//! Per-session principal registration.
//!
//! Roles are registered once at startup. See [`crate::register_role`].
//! When a session starts, [`SessionRegistrar`] upserts its principal.
//! Iron-control owns default role assignment for brand-new principals, while
//! existing principals keep their current assignments so operator revocations
//! in console or ``centaur-perms`` remain sticky. The principal is derived from
//! the thread key (see [`crate::derive_principal`]).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::IronControlClient;
use crate::error::{IronControlError, Result};
use crate::models::{Principal, PrincipalInput, SlackChannelPermissionInput};
use crate::principal::{
    GCHAT_DIRECT_MESSAGE_SPACE_TYPE, GCHAT_DM_KIND, GCHAT_SPACE_KIND, PrincipalRef,
    derive_gchat_requester_principal, derive_github_requester_principal,
    derive_principal_with_slack_team, derive_slack_requester_principal, is_direct_message,
    parse_gchat_space, slack_conversation_id,
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct SessionPrincipalMetadata<'a> {
    actor_user_id: Option<&'a str>,
    slack_team_id: Option<&'a str>,
    slack_user_email: Option<&'a str>,
    conversation_name: Option<&'a str>,
    /// Email verified by googlechatbot from an Add-on userIdToken and released
    /// only after domain and DM checks. Separate from Slack's users.info email.
    user_email: Option<&'a str>,
    /// Google Chat ``SpaceType`` for the conversation this session runs in.
    space_type: Option<&'a str>,
    /// Whether the googlechatbot authenticated the inbound webhook against
    /// Google's signed request JWT before handing us this event.
    request_verified: bool,
}

impl<'a> SessionPrincipalMetadata<'a> {
    fn from_session_metadata(metadata: Option<&'a Value>) -> Self {
        let Some(metadata) = metadata else {
            return Self::default();
        };
        Self {
            actor_user_id: metadata
                .get("slack_user_id")
                .or_else(|| metadata.get("aad_object_id"))
                .or_else(|| metadata.get("user_id"))
                .and_then(Value::as_str),
            slack_team_id: metadata.get("slack_team_id").and_then(Value::as_str),
            slack_user_email: metadata.get("slack_user_email").and_then(Value::as_str),
            conversation_name: metadata
                .get("slack_conversation_name")
                .or_else(|| metadata.get("discord_conversation_name"))
                .or_else(|| metadata.get("googlechat_conversation_name"))
                .or_else(|| metadata.get("linear_conversation_name"))
                .or_else(|| metadata.get("teams_conversation_name"))
                .and_then(Value::as_str),
            user_email: metadata.get("user_email").and_then(Value::as_str),
            space_type: metadata
                .get("googlechat_space_type")
                .and_then(Value::as_str),
            request_verified: metadata
                .get("googlechat_request_verified")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// Registers a session's principal against iron-control at session start.
///
/// Cheap to clone (the inner [`IronControlClient`] shares a connection pool),
/// so it can live on a shared runtime handle.
#[derive(Clone, Debug)]
pub struct SessionRegistrar {
    client: IronControlClient,
}

impl SessionRegistrar {
    pub fn new(client: IronControlClient) -> Self {
        Self { client }
    }

    /// Upsert the principal for ``thread_key`` using the session metadata the
    /// ingress supplied. Returns the upserted principal record (its ``id`` is
    /// the OID) so callers can bind the session's egress proxy to the same
    /// identity.
    ///
    /// Re-registering an existing channel/user refreshes identity metadata but
    /// leaves its role assignments to iron-control.
    pub async fn register_session(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Principal> {
        self.resolve_session(thread_key, metadata, true).await
    }

    /// Resolve a session principal, optionally creating it when absent.
    ///
    /// With `create_if_missing` disabled, an existing principal is returned
    /// without a create-capable foreign-ID upsert. This keeps preapproved-only
    /// admission fail-closed even if an operator concurrently deletes it.
    pub async fn resolve_session(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
        create_if_missing: bool,
    ) -> Result<Principal> {
        let metadata = SessionPrincipalMetadata::from_session_metadata(metadata);
        let principal = derive_principal_with_slack_team(
            thread_key,
            metadata.actor_user_id,
            metadata.slack_team_id,
            metadata.conversation_name,
        )?;
        let mut input = principal.to_principal_input();
        apply_slack_dm_email(thread_key, metadata.slack_user_email, &mut input);
        apply_gchat_identity(thread_key, &metadata, &mut input);
        let existing = self.merge_existing_labels(&mut input).await?;
        let slack_permission = session_slack_permission(thread_key, &input, existing.is_some());
        let record = match principal_write(existing, create_if_missing) {
            PrincipalWrite::UseExisting(record) => record,
            PrincipalWrite::Upsert => self.client.upsert_principal(&input).await?,
            PrincipalWrite::Reject => {
                return Err(IronControlError::SessionPrincipalNotPreapproved {
                    foreign_id: input.foreign_id,
                });
            }
        };
        if let Some(permission) = slack_permission {
            self.client
                .upsert_slack_channel_permission(&record.id, &permission)
                .await?;
        }
        Ok(record)
    }

    /// Bind the principal of the human requesting this turn, resolved from the
    /// execute metadata (see [`requester_plan`]): fetched for authenticated
    /// Console executions and upserted for Slack channel, GitHub and Google
    /// Chat turns. Returns ``Ok(None)`` when the metadata carries no eligible
    /// requester. For Slack that includes DM threads (the conversation
    /// principal already is the user's) and requesters not proven to belong to
    /// the Slack app's home team, which prevents Slack Connect users from
    /// supplying requester credentials to a shared channel turn. Google Chat
    /// DMs are not excluded: their conversation principal is the space, so
    /// the per-user principal is the only one that names the person.
    ///
    /// Unlike [`Self::register_session`], this never writes Slack channel
    /// permissions: the requester principal only scopes proxy credentials, and
    /// the conversation principal already owns the thread's Slack permission.
    /// Roles are left to iron-control's default assignment, as for sessions.
    pub async fn register_requester(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Option<Principal>> {
        self.resolve_requester(thread_key, metadata, true).await
    }

    /// Resolve the human requesting a turn. When creation is disabled, a
    /// missing derived requester is omitted so an approved conversation can
    /// proceed without implicitly approving that user for a future DM.
    pub async fn resolve_requester(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
        create_if_missing: bool,
    ) -> Result<Option<Principal>> {
        let Some(metadata) = metadata else {
            return Ok(None);
        };
        match requester_plan(thread_key, metadata) {
            None => Ok(None),
            // The console owns console-user principals: fetch, never upsert.
            Some(RequesterPlan::FetchExisting(foreign_id)) => {
                self.client.get_principal(&foreign_id).await.map(Some)
            }
            Some(RequesterPlan::UpsertDerived(principal)) => {
                let mut input = principal.to_principal_input();
                set_slack_email(
                    &mut input,
                    metadata.get("slack_user_email").and_then(Value::as_str),
                );
                let existing = self.merge_existing_labels(&mut input).await?;
                match principal_write(existing, create_if_missing) {
                    PrincipalWrite::UseExisting(principal) => Ok(Some(principal)),
                    PrincipalWrite::Upsert => Ok(Some(self.client.upsert_principal(&input).await?)),
                    PrincipalWrite::Reject => Ok(None),
                }
            }
        }
    }

    pub async fn get_principal(&self, principal: &str) -> Result<Principal> {
        self.client.get_principal(principal).await
    }

    /// Fold an existing principal's labels under the freshly derived ones so
    /// labels an operator or the console added survive re-registration.
    /// Returns the existing record when one was found.
    async fn merge_existing_labels(&self, input: &mut PrincipalInput) -> Result<Option<Principal>> {
        let existing = match self.client.get_principal(&input.foreign_id).await {
            Ok(existing) => existing,
            Err(error) if is_status(&error, 404) => return Ok(None),
            Err(error) => return Err(error),
        };
        merge_labels(&existing.labels, input);
        Ok(Some(existing))
    }
}

/// Fold ``existing`` labels under ``input``'s, so freshly derived labels win
/// while labels added by an operator or the console survive re-registration.
fn merge_labels(existing: &BTreeMap<String, String>, input: &mut PrincipalInput) {
    let mut labels = existing.clone();
    labels.extend(std::mem::take(&mut input.labels));
    input.labels = labels;
}

/// How a derived principal is resolved against iron-control.
#[derive(Debug, Eq, PartialEq)]
enum PrincipalWrite {
    /// Return the existing record without a create-capable upsert.
    UseExisting(Principal),
    /// Upsert the derived identity (creating it, or refreshing its metadata).
    Upsert,
    /// The principal is absent and may not be created.
    Reject,
}

fn principal_write(existing: Option<Principal>, create_if_missing: bool) -> PrincipalWrite {
    match (existing, create_if_missing) {
        (_, true) => PrincipalWrite::Upsert,
        (Some(existing), false) => PrincipalWrite::UseExisting(existing),
        (None, false) => PrincipalWrite::Reject,
    }
}

/// The Slack permission a session registration writes. New principals get
/// their channel's permission; existing channel principals keep operator edits,
/// while DM user principals are refreshed so each DM stays reachable.
fn session_slack_permission(
    thread_key: &str,
    input: &PrincipalInput,
    exists: bool,
) -> Option<SlackChannelPermissionInput> {
    let permission = slack_permission_for_thread(
        thread_key,
        input.slack_channel_id.as_deref(),
        input.slack_user_id.as_deref(),
    )?;
    (!exists || is_direct_message(Some(&permission.channel_id))).then_some(permission)
}

/// How a turn's requester principal is resolved from the execute metadata.
/// Adding a source is one arm here, not another branch in the registrar.
#[derive(Debug)]
enum RequesterPlan {
    /// Fetch a principal the console service provisioned for its
    /// authenticated user. The API server strips this metadata field from
    /// every caller except the authenticated Console service, so checking the
    /// field also covers Console replies to non-Console threads.
    FetchExisting(String),
    /// Upsert the api-rs-owned per-user principal derived from the ingress's
    /// verified actor identity (Slack channel turns, GitHub turns, Google
    /// Chat turns).
    UpsertDerived(PrincipalRef),
}

fn requester_plan(thread_key: &str, metadata: &Value) -> Option<RequesterPlan> {
    if metadata.get("requester_principal_foreign_id").is_some() {
        let foreign_id = metadata
            .get("requester_principal_foreign_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|foreign_id| !foreign_id.is_empty())?;
        return Some(RequesterPlan::FetchExisting(foreign_id.to_owned()));
    }
    // githubbot forwards the comment author (`user_id`, `user_name`) from the
    // signature-verified webhook payload. Let the derivation helper recognize
    // every GitHub-owned session family, including work sessions.
    if let Some(principal) = metadata
        .get("user_id")
        .and_then(Value::as_str)
        .and_then(|user_id| {
            derive_github_requester_principal(
                thread_key,
                user_id,
                metadata.get("user_name").and_then(Value::as_str),
            )
        })
    {
        return Some(RequesterPlan::UpsertDerived(principal));
    }
    if let Some(principal) = gchat_requester(thread_key, metadata) {
        return Some(RequesterPlan::UpsertDerived(principal));
    }
    let slack_team_id = eligible_slack_requester_team(metadata)?;
    let slack_user_id = metadata.get("slack_user_id").and_then(Value::as_str)?;
    derive_slack_requester_principal(
        thread_key,
        slack_user_id,
        slack_team_id,
        metadata.get("slack_display_name").and_then(Value::as_str),
    )
    .map(RequesterPlan::UpsertDerived)
}

/// The Google Chat requester, from the email googlechatbot verified on the
/// Add-on `userIdToken` and released only after its domain allowlist. It
/// travels under its own key so the display-only `user_email` on message
/// metadata, which is not gated, can never be mistaken for it, and the bot's
/// `googlechat_request_verified` flag is required as well so a turn that
/// skipped signature verification names no requester.
fn gchat_requester(thread_key: &str, metadata: &Value) -> Option<PrincipalRef> {
    let verified = metadata
        .get("googlechat_request_verified")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !verified {
        return None;
    }
    let email = metadata
        .get("googlechat_requester_email")
        .and_then(Value::as_str)?;
    derive_gchat_requester_principal(
        thread_key,
        email,
        metadata.get("user_name").and_then(Value::as_str),
    )
}

fn eligible_slack_requester_team(metadata: &Value) -> Option<&str> {
    let requester_team = metadata
        .get("slack_team_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|team| !team.is_empty())?;
    let home_team = metadata
        .get("slack_home_team_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|team| !team.is_empty())?;
    (requester_team == home_team).then_some(requester_team)
}

fn slack_permission_for_thread(
    thread_key: &str,
    slack_channel_id: Option<&str>,
    slack_user_id: Option<&str>,
) -> Option<SlackChannelPermissionInput> {
    if let Some(channel_id) = slack_channel_id {
        let channel_id = channel_id.trim();
        return (!is_direct_message(Some(channel_id)))
            .then(|| slack_permission(channel_id.to_owned()));
    }

    slack_user_id?;
    let conversation_id = slack_conversation_id(thread_key)?;
    is_direct_message(Some(conversation_id)).then(|| slack_permission(conversation_id.to_owned()))
}

fn apply_slack_dm_email(
    thread_key: &str,
    slack_user_email: Option<&str>,
    input: &mut PrincipalInput,
) {
    let Some(conversation_id) = slack_conversation_id(thread_key) else {
        return;
    };
    if is_direct_message(Some(conversation_id)) {
        set_slack_email(input, slack_user_email);
    }
}

/// Stamp ``slack_email`` on a user principal, skipping blank emails. Shared by
/// the DM session path and the channel requester path so a user carries the
/// same identity either way.
fn set_slack_email(input: &mut PrincipalInput, slack_user_email: Option<&str>) {
    let Some(email) = slack_user_email
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return;
    };
    if input.slack_user_id.is_some() {
        input.slack_email = Some(email.to_owned());
    }
}

/// Set the Google Chat principal kind and label a verified DM requester.
///
/// googlechatbot verifies the Add-on userIdToken, applies the domain allowlist,
/// and confirms a one-human DM with Google before sending user_email. Its
/// request JWT alone does not authenticate an email in the event body.
/// This layer requires a Google Chat key, DIRECT_MESSAGE, request verification,
/// and a non-empty email before assigning the credential-bearing google_email
/// label. Shared spaces must never inherit one member's personal credentials.
fn apply_gchat_identity(
    thread_key: &str,
    metadata: &SessionPrincipalMetadata<'_>,
    input: &mut PrincipalInput,
) {
    if parse_gchat_space(thread_key).is_none() {
        return;
    }
    let Some(space_type) = metadata
        .space_type
        .map(str::trim)
        .filter(|space_type| !space_type.is_empty())
    else {
        return;
    };
    let is_dm = space_type.eq_ignore_ascii_case(GCHAT_DIRECT_MESSAGE_SPACE_TYPE);
    let kind = if is_dm {
        GCHAT_DM_KIND
    } else {
        GCHAT_SPACE_KIND
    };
    input.kind = Some(kind.to_owned());

    if !is_dm || !metadata.request_verified {
        return;
    }
    let Some(email) = metadata
        .user_email
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return;
    };
    input
        .labels
        .insert("google_email".to_owned(), email.to_owned());
}

fn slack_permission(channel_id: String) -> SlackChannelPermissionInput {
    SlackChannelPermissionInput {
        channel_id,
        upload_enabled: true,
        download_enabled: true,
        history_enabled: true,
    }
}

fn is_status(err: &IronControlError, code: u16) -> bool {
    matches!(err, IronControlError::Status { status, .. } if *status == code)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::{PrincipalDerivationError, derive_principal};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn session_principal_metadata_prefers_slack_user_then_teams_ids() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_user_id": "U1",
                "aad_object_id": "aad-user-1",
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("U1")
        );
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "aad_object_id": "aad-user-1",
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("aad-user-1")
        );
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "user_id": "teams-user-1"
            })))
            .actor_user_id,
            Some("teams-user-1")
        );
    }

    #[test]
    fn session_principal_metadata_accepts_teams_name() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "teams_conversation_name": "Casey Harper"
            })))
            .conversation_name,
            Some("Casey Harper")
        );
    }

    #[test]
    fn session_principal_metadata_carries_slack_team_id() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_team_id": "T123"
            })))
            .slack_team_id,
            Some("T123")
        );
    }

    #[test]
    fn session_principal_metadata_carries_slack_user_email() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "slack_user_email": "ada@example.com"
            })))
            .slack_user_email,
            Some("ada@example.com")
        );
    }

    #[test]
    fn slack_dm_email_applies_only_to_dm_user_principals() {
        let mut dm_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        apply_slack_dm_email(
            "slack:T123:D123:1773364194.179929",
            Some(" ada@example.com "),
            &mut dm_input,
        );
        assert_eq!(dm_input.slack_email.as_deref(), Some("ada@example.com"));

        let mut channel_input = derive_principal("slack:T123:C123:ts", Some("U123"), None)
            .expect("channel principal should be derivable")
            .to_principal_input();
        apply_slack_dm_email(
            "slack:T123:C123:1773364194.179929",
            Some("ada@example.com"),
            &mut channel_input,
        );
        assert_eq!(channel_input.slack_email, None);
    }

    #[tokio::test]
    async fn register_session_rejects_slack_dm_without_team_id() {
        let registrar =
            SessionRegistrar::new(IronControlClient::new("http://127.0.0.1:1", "test-key"));
        let metadata = json!({ "slack_user_id": "U123" });

        let error = registrar
            .register_session("slack:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            IronControlError::PrincipalDerivation(PrincipalDerivationError::MissingSlackTeamId)
        ));
    }

    #[tokio::test]
    async fn register_session_rejects_slack_dm_without_user_id() {
        let registrar =
            SessionRegistrar::new(IronControlClient::new("http://127.0.0.1:1", "test-key"));
        let metadata = json!({ "slack_team_id": "T123" });

        let error = registrar
            .register_session("slack:D123:1773364194.179929", Some(&metadata))
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            IronControlError::PrincipalDerivation(PrincipalDerivationError::MissingSlackUserId)
        ));
    }

    #[tokio::test]
    async fn preapproved_session_rejects_a_missing_principal_without_writing() {
        let (base_url, requests, server) = spawn_iron_control_stub(|method, _| match method {
            "GET" => not_found(),
            _ => (
                "500 Internal Server Error",
                r#"{"error":"unexpected"}"#.to_owned(),
            ),
        })
        .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123"
        });

        let error = registrar
            .resolve_session("slack:T123:C123:1773364194.179929", Some(&metadata), false)
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            IronControlError::SessionPrincipalNotPreapproved { ref foreign_id }
                if foreign_id == "slack-channel-t123-c123"
        ));
        assert!(
            requests
                .lock()
                .unwrap()
                .iter()
                .all(|request| request.method == "GET"),
            "preapproved admission must not write to iron-control"
        );
        server.abort();
    }

    #[tokio::test]
    async fn existing_dm_principal_refreshes_its_permission_on_the_upserted_record() {
        // The lookup and upsert answer with different ids, so the permission
        // write shows which record it was bound to.
        let (base_url, requests, server) =
            spawn_iron_control_stub(|method, path| match (method, path) {
                ("GET", "/api/v1/principals/lookup/slack-user-t123-u123") => {
                    principal("prn_looked_up", "slack-user-t123-u123", json!({}))
                }
                ("PUT", "/api/v1/principals/slack-user-t123-u123") => {
                    principal("prn_upserted", "slack-user-t123-u123", json!({}))
                }
                ("POST", "/api/v1/principals/prn_upserted/slack_channel_permissions") => {
                    ("200 OK", r#"{"data":{"ok":true}}"#.to_owned())
                }
                _ => not_found(),
            })
            .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));

        let record = registrar
            .register_session(
                "slack:T123:D123:1773364194.179929",
                Some(&json!({"slack_user_id": "U123", "slack_team_id": "T123"})),
            )
            .await
            .expect("register DM session");

        assert_eq!(record.id, "prn_upserted");
        let permission = requests
            .lock()
            .unwrap()
            .iter()
            .find(|request| request.path.ends_with("/slack_channel_permissions"))
            .and_then(|request| request.body.clone())
            .expect("DM permission is written");
        assert_eq!(
            permission["data"],
            json!({
                "channel_id": "D123",
                "upload_enabled": true,
                "download_enabled": true,
                "history_enabled": true
            })
        );
        server.abort();
    }

    #[tokio::test]
    async fn unknown_console_requester_is_an_error_not_an_omitted_requester() {
        let (base_url, _requests, server) = spawn_iron_control_stub(|_, _| not_found()).await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));

        let error = registrar
            .register_requester(
                "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
                Some(&json!({"requester_principal_foreign_id": "console-user-ghost"})),
            )
            .await
            .expect_err("a console requester the console never provisioned must fail");

        assert!(is_status(&error, 404), "{error:?}");
        server.abort();
    }

    #[tokio::test]
    async fn channel_requester_upsert_keeps_existing_labels_and_sets_email() {
        let (base_url, requests, server) =
            spawn_iron_control_stub(|method, path| match (method, path) {
                ("GET", "/api/v1/principals/lookup/slack-user-t123-u123") => principal(
                    "prn_user",
                    "slack-user-t123-u123",
                    json!({"team": "finance"}),
                ),
                ("PUT", "/api/v1/principals/slack-user-t123-u123") => {
                    principal("prn_user", "slack-user-t123-u123", json!({}))
                }
                _ => not_found(),
            })
            .await;
        let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));

        let requester = registrar
            .register_requester(
                "slack:T123:C123:1773364194.179929",
                Some(&json!({
                    "slack_user_id": "U123",
                    "slack_team_id": "T123",
                    "slack_home_team_id": "T123",
                    "slack_user_email": " ada@example.com "
                })),
            )
            .await
            .expect("register requester")
            .expect("home-team channel requester resolves");

        assert_eq!(requester.id, "prn_user");
        let upsert = requests
            .lock()
            .unwrap()
            .iter()
            .find(|request| request.method == "PUT")
            .and_then(|request| request.body.clone())
            .expect("requester principal is upserted");
        assert_eq!(upsert["data"]["slack_email"], "ada@example.com");
        assert_eq!(upsert["data"]["labels"]["team"], "finance");
        assert_eq!(upsert["data"]["labels"]["managed-by"], "centaur");
        server.abort();
    }

    #[test]
    fn principal_write_creates_only_when_allowed() {
        let existing = Principal {
            id: "prn_existing".to_owned(),
            foreign_id: Some("slack-channel-t123-c123".to_owned()),
            name: "Slack Channel #general".to_owned(),
            labels: Default::default(),
            sandbox_observability_enabled: true,
        };

        assert_eq!(
            principal_write(Some(existing.clone()), false),
            PrincipalWrite::UseExisting(existing.clone())
        );
        assert_eq!(principal_write(None, false), PrincipalWrite::Reject);
        assert_eq!(
            principal_write(Some(existing), true),
            PrincipalWrite::Upsert
        );
        assert_eq!(principal_write(None, true), PrincipalWrite::Upsert);
    }

    #[test]
    fn session_slack_permission_preserves_existing_channel_grants() {
        let permission = |thread_key: &str, actor: Option<&str>, exists: bool| {
            let input = derive_principal(thread_key, actor, None)
                .expect("principal should be derivable")
                .to_principal_input();
            session_slack_permission(thread_key, &input, exists)
                .map(|permission| permission.channel_id)
        };

        let channel = "slack:T123:C123:1773364194.179929";
        let dm = "slack:T123:D123:1773364194.179929";
        assert_eq!(
            permission(channel, Some("U123"), false).as_deref(),
            Some("C123")
        );
        assert_eq!(
            permission(channel, Some("U123"), true),
            None,
            "operator edits to an existing channel's permission must survive"
        );
        assert_eq!(permission(dm, Some("U123"), false).as_deref(), Some("D123"));
        assert_eq!(permission(dm, Some("U123"), true).as_deref(), Some("D123"));
        assert_eq!(permission("linear:issue-1", None, false), None);
    }

    #[test]
    fn merge_labels_keeps_existing_labels_under_derived_ones() {
        let mut input = derive_principal("slack:T123:C123:ts", None, None)
            .expect("channel principal should be derivable")
            .to_principal_input();
        let existing = BTreeMap::from([
            ("managed-by".to_owned(), "operator".to_owned()),
            ("team".to_owned(), "finance".to_owned()),
        ]);

        merge_labels(&existing, &mut input);

        assert_eq!(
            input.labels,
            BTreeMap::from([
                ("managed-by".to_owned(), "centaur".to_owned()),
                ("team".to_owned(), "finance".to_owned()),
            ])
        );
    }

    #[test]
    fn requester_plan_skips_ineligible_requesters() {
        let slack_requester = json!({
            "slack_user_id": "U123",
            "slack_team_id": "T123",
            "slack_home_team_id": "T123"
        });
        for (thread_key, metadata) in [
            // The DM conversation principal already is the user's.
            ("slack:T123:D123:1773364194.179929", slack_requester.clone()),
            ("linear:issue-1", slack_requester),
            (
                "slack:T123:C123:1773364194.179929",
                json!({
                    "aad_object_id": "aad-user-1",
                    "user_id": "teams-user-1",
                    "slack_team_id": "T123",
                    "slack_home_team_id": "T123"
                }),
            ),
            (
                "slack:T_HOME:C123:1773364194.179929",
                json!({
                    "slack_user_id": "U123",
                    "slack_team_id": "T_EXTERNAL",
                    "slack_home_team_id": "T_HOME"
                }),
            ),
            (
                "slack:T123:C123:1773364194.179929",
                json!({"slack_user_id": "U123", "slack_team_id": "T123"}),
            ),
            (
                "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
                json!({"user_email": "ada@example.com"}),
            ),
            ("github:acme/widgets:12", json!({"user_name": "ada"})),
            (
                "linear:issue-1",
                json!({"user_id": "90210001", "user_name": "ada"}),
            ),
        ] {
            assert!(
                requester_plan(thread_key, &metadata).is_none(),
                "{thread_key} {metadata}"
            );
        }
    }

    #[test]
    fn requester_plan_fetches_console_requesters_on_any_thread() {
        let metadata = json!({
            "requester_principal_foreign_id": " console-user-ada-example-com-abc123 "
        });
        for thread_key in [
            "console:9f1b7a3c-2d4e-4f6a-8b0c-1d2e3f4a5b6c",
            "slack:T123:C123:1773364194.179929",
        ] {
            let Some(RequesterPlan::FetchExisting(foreign_id)) =
                requester_plan(thread_key, &metadata)
            else {
                panic!("expected a console requester fetch for {thread_key}");
            };
            assert_eq!(foreign_id, "console-user-ada-example-com-abc123");
        }
    }

    #[test]
    fn requester_plan_upserts_home_team_slack_channel_requesters() {
        let Some(RequesterPlan::UpsertDerived(principal)) = requester_plan(
            "slack:T123:C123:1773364194.179929",
            &json!({
                "slack_user_id": "U123",
                "slack_team_id": "T123",
                "slack_home_team_id": "T123",
                "slack_display_name": "Ada Lovelace"
            }),
        ) else {
            panic!("expected a Slack requester upsert");
        };
        assert_eq!(principal.foreign_id, "slack-user-t123-u123");
    }

    #[test]
    fn slack_email_applies_only_to_user_principals_with_non_blank_email() {
        let mut user_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut user_input, Some(" ada@example.com "));
        assert_eq!(user_input.slack_email.as_deref(), Some("ada@example.com"));

        let mut blank_input = derive_principal("slack:T123:D123:ts", Some("U123"), None)
            .expect("DM principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut blank_input, Some("   "));
        assert_eq!(blank_input.slack_email, None);

        let mut channel_input = derive_principal("slack:T123:C123:ts", None, None)
            .expect("channel principal should be derivable")
            .to_principal_input();
        set_slack_email(&mut channel_input, Some("ada@example.com"));
        assert_eq!(channel_input.slack_email, None);
    }

    #[test]
    fn requester_plan_resolves_github_work_session_keys() {
        let metadata = json!({
            "user_id": "90210001",
            "user_name": "ada"
        });

        for thread_key in [
            "github:acme/widgets:12",
            "github-issue:acme/widgets:12",
            "github-manage:acme/widgets:12",
        ] {
            let Some(RequesterPlan::UpsertDerived(principal)) =
                requester_plan(thread_key, &metadata)
            else {
                panic!("expected a GitHub requester for {thread_key}");
            };
            assert_eq!(principal.foreign_id, "github-user-90210001");
        }
    }

    #[test]
    fn requester_team_eligibility_requires_matching_non_blank_teams() {
        for metadata in [
            json!({"slack_home_team_id": "T123"}),
            json!({"slack_team_id": "T123"}),
            json!({"slack_team_id": "", "slack_home_team_id": "T123"}),
            json!({"slack_team_id": "T123", "slack_home_team_id": "   "}),
            json!({"slack_team_id": "T_EXTERNAL", "slack_home_team_id": "T_HOME"}),
        ] {
            assert_eq!(eligible_slack_requester_team(&metadata), None);
        }

        assert_eq!(
            eligible_slack_requester_team(&json!({
                "slack_team_id": " T123 ",
                "slack_home_team_id": "T123"
            })),
            Some("T123")
        );
    }

    #[test]
    fn slack_permission_for_thread_skips_dm_channel_fallback_without_user() {
        assert_eq!(
            slack_permission_for_thread("slack:D123:ts", Some("D123"), None),
            None
        );
    }

    /// One request the stub received; `body` is the decoded JSON body, if any.
    #[derive(Clone, Debug)]
    struct StubRequest {
        method: String,
        path: String,
        body: Option<Value>,
    }

    type StubResponder = fn(&str, &str) -> (&'static str, String);

    /// A stub iron-control API answering with `respond(method, path)` and
    /// recording every request it receives.
    async fn spawn_iron_control_stub(
        respond: StubResponder,
    ) -> (
        String,
        Arc<Mutex<Vec<StubRequest>>>,
        tokio::task::JoinHandle<()>,
    ) {
        fn content_length(headers: &str) -> usize {
            headers
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse().ok())
                .unwrap_or(0)
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    let complete = request
                        .windows(4)
                        .position(|window| window == b"\r\n\r\n")
                        .is_some_and(|headers_end| {
                            let headers = String::from_utf8_lossy(&request[..headers_end]);
                            request.len() >= headers_end + 4 + content_length(&headers)
                        });
                    if complete {
                        break;
                    }
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buf[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let (head, body) = request.split_once("\r\n\r\n").unwrap_or((&request, ""));
                let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
                let method = parts.next().unwrap_or_default().to_owned();
                let path = parts.next().unwrap_or_default().to_owned();
                let (status_line, response_body) = respond(&method, &path);
                seen.lock().unwrap().push(StubRequest {
                    method,
                    path,
                    body: serde_json::from_str(body).ok(),
                });
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                    response_body.len(),
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (base_url, requests, handle)
    }

    fn not_found() -> (&'static str, String) {
        ("404 Not Found", r#"{"error":"not found"}"#.to_owned())
    }

    fn principal(id: &str, foreign_id: &str, labels: Value) -> (&'static str, String) {
        (
            "200 OK",
            json!({"data": {"id": id, "foreign_id": foreign_id, "name": "stub", "labels": labels}})
                .to_string(),
        )
    }

    const GCHAT_DM_THREAD: &str = "chat:spaces:AAAA:spaces:AAAA:threads:T1";

    fn gchat_input(metadata: Value) -> PrincipalInput {
        let mut input = derive_principal(GCHAT_DM_THREAD, None, None)
            .expect("Google Chat principal should be derivable")
            .to_principal_input();
        apply_gchat_identity(
            GCHAT_DM_THREAD,
            &SessionPrincipalMetadata::from_session_metadata(Some(&metadata)),
            &mut input,
        );
        input
    }

    #[test]
    fn session_principal_metadata_accepts_googlechat_name() {
        assert_eq!(
            SessionPrincipalMetadata::from_session_metadata(Some(&json!({
                "googlechat_conversation_name": "Ada Lovelace"
            })))
            .conversation_name,
            Some("Ada Lovelace")
        );
    }

    #[test]
    fn session_principal_metadata_carries_googlechat_space_fields() {
        let raw = json!({
            "user_email": "ada@example.com",
            "googlechat_space_type": "DIRECT_MESSAGE",
            "googlechat_request_verified": true
        });
        let metadata = SessionPrincipalMetadata::from_session_metadata(Some(&raw));
        assert_eq!(metadata.user_email, Some("ada@example.com"));
        assert_eq!(metadata.space_type, Some("DIRECT_MESSAGE"));
        assert!(metadata.request_verified);
    }

    #[test]
    fn gchat_dm_labels_carry_the_verified_requester_email() {
        let input = gchat_input(json!({
            "user_email": " ada@example.com ",
            "googlechat_space_type": "DIRECT_MESSAGE",
            "googlechat_request_verified": true
        }));
        assert_eq!(input.kind.as_deref(), Some("gchat_dm"));
        assert_eq!(
            input.labels.get("google_email").map(String::as_str),
            Some("ada@example.com")
        );
    }

    #[test]
    fn gchat_group_spaces_never_carry_an_email() {
        for space_type in ["GROUP_CHAT", "SPACE"] {
            let input = gchat_input(json!({
                "user_email": "ada@example.com",
                "googlechat_space_type": space_type,
                "googlechat_request_verified": true
            }));
            assert_eq!(
                input.kind.as_deref(),
                Some("gchat_space"),
                "{space_type} must not be treated as a 1:1 conversation"
            );
            assert_eq!(
                input.labels.get("google_email"),
                None,
                "{space_type} must not adopt one member's identity"
            );
        }
    }

    #[test]
    fn gchat_dm_email_requires_a_verified_request() {
        // An unverified event body is attacker-controllable, so its email must
        // not become an identity reconciliation will grant credentials to.
        let input = gchat_input(json!({
            "user_email": "attacker@example.com",
            "googlechat_space_type": "DIRECT_MESSAGE"
        }));
        assert_eq!(input.kind.as_deref(), Some("gchat_dm"));
        assert_eq!(input.labels.get("google_email"), None);
    }

    #[test]
    fn gchat_identity_is_skipped_without_a_space_type() {
        // An ingress that predates the space-type contract leaves the principal
        // exactly as it is today rather than being guessed into a kind.
        let input = gchat_input(json!({
            "user_email": "ada@example.com",
            "googlechat_request_verified": true
        }));
        assert_eq!(input.kind, None);
        assert_eq!(input.labels.get("google_email"), None);
    }

    #[test]
    fn gchat_identity_ignores_non_gchat_threads() {
        // The Slack-compatible `chat:C…` adapter key is not Google Chat.
        let mut input = derive_principal("chat:C123:1780000000.000000", None, None)
            .expect("Slack-compatible principal should be derivable")
            .to_principal_input();
        let before = input.clone();
        let metadata = json!({
            "user_email": "ada@example.com",
            "googlechat_space_type": "DIRECT_MESSAGE",
            "googlechat_request_verified": true
        });
        for thread_key in ["chat:C123:1780000000.000000", "slack:T123:D123:1780.1"] {
            apply_gchat_identity(
                thread_key,
                &SessionPrincipalMetadata::from_session_metadata(Some(&metadata)),
                &mut input,
            );
        }
        assert_eq!(input, before);
    }

    #[test]
    fn slack_dm_labels_are_unchanged_by_googlechat_metadata() {
        // Slack keeps sourcing its address from `slack_user_email`; a stray
        // `user_email` must not leak into a Slack principal.
        let mut input = derive_principal("slack:T123:D123:1780.1", Some("U123"), None)
            .expect("Slack DM principal should be derivable")
            .to_principal_input();
        let metadata = json!({
            "slack_user_id": "U123",
            "slack_user_email": "ada@example.com",
            "user_email": "someone-else@example.com",
            "googlechat_space_type": "DIRECT_MESSAGE",
            "googlechat_request_verified": true
        });
        let parsed = SessionPrincipalMetadata::from_session_metadata(Some(&metadata));
        apply_slack_dm_email(
            "slack:T123:D123:1780.1",
            parsed.slack_user_email,
            &mut input,
        );
        apply_gchat_identity("slack:T123:D123:1780.1", &parsed, &mut input);
        assert_eq!(input.slack_email.as_deref(), Some("ada@example.com"));
        assert_eq!(input.labels.get("google_email"), None);
        assert_eq!(input.kind.as_deref(), Some("slack_dm"));
    }

    #[tokio::test]
    async fn register_requester_upserts_gchat_user_principal_for_any_space() {
        // A group thread and a DM both resolve the same person to the same
        // per-user principal: Chat sessions key on the space, so this is the
        // only principal a personal grant can live on.
        for thread_key in [
            "chat:spaces:GROUP:spaces:GROUP:threads:T1",
            "chat:spaces:DM:spaces:DM:threads:T2",
        ] {
            let (base_url, requests, server) = spawn_iron_control_stub(|method, path| {
                if method == "PUT" && path.ends_with("/gchat-user-ada-example-com-b5fc85e55755") {
                    principal(
                        "prn_user",
                        "gchat-user-ada-example-com-b5fc85e55755",
                        json!({}),
                    )
                } else {
                    not_found()
                }
            })
            .await;
            let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
            let metadata = json!({
                "user_id": "users/123",
                "user_name": "Ada Lovelace",
                "user_email": "ada@example.com",
                "googlechat_request_verified": true,
                "googlechat_requester_email": "ada@example.com"
            });

            let principal = registrar
                .register_requester(thread_key, Some(&metadata))
                .await
                .unwrap()
                .expect("a verified Chat requester resolves to a principal");
            assert_eq!(principal.id, "prn_user");

            let requests = requests.lock().unwrap();
            assert!(
                !requests
                    .iter()
                    .any(|request| request.path.ends_with("/roles"))
            );
            let upsert = requests
                .iter()
                .find(|request| request.method == "PUT")
                .and_then(|request| request.body.as_ref())
                .expect("gchat requester principal is upserted");
            assert_eq!(upsert["data"]["kind"], "gchat_user");
            assert_eq!(upsert["data"]["name"], "Google Chat User @Ada Lovelace");
            assert_eq!(upsert["data"]["labels"]["google_email"], "ada@example.com");
            server.abort();
        }
    }

    #[tokio::test]
    async fn register_requester_ignores_unverified_or_display_only_gchat_emails() {
        let thread_key = "chat:spaces:GROUP:spaces:GROUP:threads:T1";
        for metadata in [
            // Signature verification skipped: the email proves nothing.
            json!({
                "googlechat_request_verified": false,
                "googlechat_requester_email": "ada@example.com"
            }),
            // Only the display-only message email, never gated by the bot.
            json!({
                "googlechat_request_verified": true,
                "user_email": "ada@example.com"
            }),
            json!({ "googlechat_requester_email": "ada@example.com" }),
        ] {
            let (base_url, requests, server) = spawn_iron_control_stub(|_, _| not_found()).await;
            let registrar = SessionRegistrar::new(IronControlClient::new(base_url, "test-key"));
            let principal = registrar
                .register_requester(thread_key, Some(&metadata))
                .await
                .unwrap();
            assert_eq!(principal, None, "{metadata}");
            assert!(requests.lock().unwrap().is_empty());
            server.abort();
        }
    }
}
