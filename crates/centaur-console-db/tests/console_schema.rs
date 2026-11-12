//! Tests against a Postgres database holding Console's schema.
//!
//! Set `CONSOLE_DB_TEST_DATABASE_URL` to a database prepared with Console's
//! `bin/rails db:prepare`. Each test inserts uniquely named rows, so tests can
//! share one database and run in parallel.

use std::env;

use active_record_encryption::ActiveRecordEncryption;
use centaur_console_db::{
    ApiClient, ApiClientPrincipal, REDACTED, SecretValues, SlackChannelPermission, Subject,
    api_client_principals, build_config, find_api_client, find_direct_slack_channel_permission,
    find_gchat_user_principal_by_google_subject, find_principal, find_principal_by_foreign_id,
    find_user_id_by_email, find_user_id_for_google_account, models::Config, oid,
    principal_is_linked_to_another_google_account,
};
use centaur_iron_control::{IronControlClient, SessionRegistrar, slugify};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};

const PRIMARY_KEY: &str = "dev_ar_encryption_primary_key_0000000000000000";
const SALT: &str = "dev_ar_encryption_key_derivation_salt_000000000";
/// "known secret" encrypted by Active Record with the keys above.
const ENCRYPTED: &str =
    r#"{"p":"xOiyro9XYBkfABUF","h":{"iv":"pCjJC5SxH78ZN0Nm","at":"s9DIUyHAkF8ZAthKO6ROtw=="}}"#;
const PLAINTEXT: &str = "known secret";

async fn database() -> Option<PgPool> {
    let Ok(url) = env::var("CONSOLE_DB_TEST_DATABASE_URL") else {
        assert!(
            env::var_os("CI").is_none(),
            "CONSOLE_DB_TEST_DATABASE_URL must be set in CI"
        );
        eprintln!("skipping: set CONSOLE_DB_TEST_DATABASE_URL to a database with Console's schema");
        return None;
    };
    Some(
        PgPoolOptions::new()
            .max_connections(2)
            .connect(&url)
            .await
            .expect("connect to the test database"),
    )
}

struct Fixture {
    pool: PgPool,
    admin: i64,
    unique: String,
}

impl Fixture {
    async fn new() -> Option<Self> {
        let pool = database().await?;
        let unique = format!("{:032x}", rand::random::<u128>());
        let admin = sqlx::query_scalar(
            "INSERT INTO users (email, admin, status, created_at, updated_at) \
             VALUES ($1, true, 'active', now(), now()) RETURNING id",
        )
        .bind(format!("admin-{unique}@example.com"))
        .fetch_one(&pool)
        .await
        .unwrap();
        Some(Self {
            pool,
            admin,
            unique,
        })
    }

    fn name(&self, label: &str) -> String {
        format!("{label}-{}", self.unique)
    }

    async fn principal(&self, label: &str) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO principals (foreign_id, name, kind, labels, slack_user_id, created_by_id, created_at, updated_at) \
             VALUES ($1, 'Example', 'slack_dm', '{\"team\": \"core\"}', 'U12345678', $2, now(), now()) RETURNING id",
        )
        .bind(self.name(label))
        .bind(self.admin)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn grant(&self, principal: i64, column: &str, secret: i64) {
        sqlx::query(&format!(
            "INSERT INTO grants (principal_id, {column}, priority, created_by_id, created_at, updated_at) \
             VALUES ($1, $2, 100, $3, now(), now())"
        ))
        .bind(principal)
        .bind(secret)
        .bind(self.admin)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn rule(&self, column: &str, secret: i64, host: &str) {
        sqlx::query(&format!(
            "INSERT INTO request_rules ({column}, host, position, created_at, updated_at) \
             VALUES ($1, $2, 0, now(), now())"
        ))
        .bind(secret)
        .bind(host)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn static_secret(&self, label: &str, inject: Value, replace: Option<Value>) -> i64 {
        let (inject, replace) = match replace {
            Some(replace) => (None, Some(replace)),
            None => (Some(inject), None),
        };
        sqlx::query_scalar(
            "INSERT INTO static_secrets (foreign_id, inject_config, replace_config, created_by_id, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, now(), now()) RETURNING id",
        )
        .bind(self.name(label))
        .bind(inject)
        .bind(replace)
        .bind(self.admin)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn broker_credential(&self, label: &str) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO broker_credentials (foreign_id, token_endpoint, access_token, created_by_id, created_at, updated_at) \
             VALUES ($1, 'https://idp.example/token', $2, $3, now(), now()) RETURNING id",
        )
        .bind(self.name(label))
        .bind(ENCRYPTED)
        .bind(self.admin)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn source(
        &self,
        column: &str,
        owner: i64,
        source_type: &str,
        secret: Option<&str>,
        broker: Option<i64>,
    ) {
        sqlx::query(&format!(
            "INSERT INTO secret_sources ({column}, source_type, config, secret, broker_credential_id, created_at, updated_at) \
             VALUES ($1, $2, '{{}}', $3, $4, now(), now())"
        ))
        .bind(owner)
        .bind(source_type)
        .bind(secret)
        .bind(broker)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    /// Grants `principal` a stored inject secret, a brokered secret, a replace
    /// secret, and a GCP keyfile transform, all with encrypted values.
    async fn grant_secret_values(&self, principal: i64) {
        let inject = self
            .static_secret("inject", json!({ "header": "X-Api-Key" }), None)
            .await;
        self.source(
            "static_secret_id",
            inject,
            "control_plane",
            Some(ENCRYPTED),
            None,
        )
        .await;
        self.rule("static_secret_id", inject, "inject.example")
            .await;
        self.grant(principal, "static_secret_id", inject).await;

        let broker = self.broker_credential("broker").await;
        let brokered = self
            .static_secret("brokered", json!({ "header": "Authorization" }), None)
            .await;
        self.source(
            "static_secret_id",
            brokered,
            "token_broker",
            None,
            Some(broker),
        )
        .await;
        self.rule("static_secret_id", brokered, "brokered.example")
            .await;
        self.grant(principal, "static_secret_id", brokered).await;

        let replace = self
            .static_secret(
                "replace",
                Value::Null,
                Some(json!({ "proxy_value": "PLACEHOLDER", "match_headers": ["X-Token"] })),
            )
            .await;
        self.source(
            "static_secret_id",
            replace,
            "control_plane",
            Some(ENCRYPTED),
            None,
        )
        .await;
        self.rule("static_secret_id", replace, "replace.example")
            .await;
        self.grant(principal, "static_secret_id", replace).await;

        let gcp: i64 = sqlx::query_scalar(
            "INSERT INTO gcp_auth_secrets (foreign_id, scopes, created_by_id, created_at, updated_at) \
             VALUES ($1, '[]', $2, now(), now()) RETURNING id",
        )
        .bind(self.name("gcp"))
        .bind(self.admin)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        self.source(
            "gcp_auth_secret_id",
            gcp,
            "control_plane",
            Some(ENCRYPTED),
            None,
        )
        .await;
        self.rule("gcp_auth_secret_id", gcp, "gcp.example").await;
        self.grant(principal, "gcp_auth_secret_id", gcp).await;
    }
}

fn to_json(config: &Config) -> Value {
    json!({
        "secrets": config.secrets,
        "transforms": config.transforms,
        "postgres": config.postgres,
    })
}

/// Console's redaction: every inline control_plane value becomes `[redacted]`.
fn redact(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut redacted: serde_json::Map<String, Value> = map
                .iter()
                .map(|(key, value)| (key.clone(), redact(value)))
                .collect();
            if map.get("type") == Some(&json!("control_plane")) && map.contains_key("value") {
                redacted.insert("value".to_owned(), json!(REDACTED));
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn redacted_config_is_the_live_config_without_secret_values() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let principal = fixture.principal("principal").await;
    fixture.grant_secret_values(principal).await;
    let empty = json!([]);
    let labels = json!({});
    let subject = Subject {
        principal_id: principal,
        principal: None,
        console_user_id: None,
        console_user_email: None,
        slack_history_channel_ids: &empty,
        proxy_labels: &labels,
    };
    let encryption = ActiveRecordEncryption::new(PRIMARY_KEY, SALT);

    let live = build_config(
        &fixture.pool,
        SecretValues::Live(&encryption),
        &subject,
        None,
    )
    .await
    .unwrap();
    let redacted = build_config(&fixture.pool, SecretValues::Redacted, &subject, None)
        .await
        .unwrap();

    let live = to_json(&live);
    assert_eq!(live["secrets"].as_array().unwrap().len(), 3);
    assert!(live.to_string().contains(PLAINTEXT));
    let redacted = to_json(&redacted);
    assert!(!redacted.to_string().contains(PLAINTEXT));
    assert_eq!(redacted, redact(&live));
}

#[tokio::test]
async fn effective_config_is_redacted_and_absent_for_missing_principals() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let principal = fixture.principal("principal").await;
    fixture.grant_secret_values(principal).await;

    let config = centaur_console_db::effective_config(&fixture.pool, principal)
        .await
        .unwrap()
        .expect("principal exists");
    let config = to_json(&config);
    assert!(!config.to_string().contains(PLAINTEXT));
    assert_eq!(
        config["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|secret| secret["replace"]["proxy_value"].as_str())
            .collect::<Vec<_>>(),
        vec!["PLACEHOLDER"]
    );

    assert!(
        centaur_console_db::effective_config(&fixture.pool, i64::MAX)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn reads_principals_users_and_direct_slack_permissions() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let principal = fixture.principal("principal").await;
    sqlx::query(
        "INSERT INTO slack_channel_permissions (principal_id, channel_id, upload_enabled, download_enabled, history_enabled, created_at, updated_at) \
         VALUES ($1, 'D12345678', true, false, true, now(), now())",
    )
    .bind(principal)
    .execute(&fixture.pool)
    .await
    .unwrap();

    let by_id = find_principal(&fixture.pool, principal)
        .await
        .unwrap()
        .expect("principal exists");
    assert_eq!(
        by_id.foreign_id.as_deref(),
        Some(fixture.name("principal").as_str())
    );
    assert_eq!(by_id.name.as_deref(), Some("Example"));
    assert_eq!(by_id.kind, "slack_dm");
    assert_eq!(by_id.labels, json!({ "team": "core" }));
    assert_eq!(by_id.slack_user_id.as_deref(), Some("U12345678"));
    assert_eq!(by_id.sandbox_repo_cache, "all");
    assert!(by_id.sandbox_observability_enabled);
    assert_eq!(
        find_principal_by_foreign_id(&fixture.pool, &fixture.name("principal"))
            .await
            .unwrap(),
        Some(by_id)
    );
    assert_eq!(
        find_principal_by_foreign_id(&fixture.pool, &fixture.name("missing"))
            .await
            .unwrap(),
        None
    );

    assert_eq!(
        find_user_id_by_email(
            &fixture.pool,
            &format!("admin-{}@example.com", fixture.unique)
        )
        .await
        .unwrap(),
        Some(fixture.admin)
    );
    assert_eq!(
        find_direct_slack_channel_permission(&fixture.pool, principal, "D12345678")
            .await
            .unwrap(),
        Some(SlackChannelPermission {
            upload_enabled: true,
            download_enabled: false,
            history_enabled: true,
        })
    );
    assert_eq!(
        find_direct_slack_channel_permission(&fixture.pool, principal, "D99999999")
            .await
            .unwrap(),
        None
    );
}

/// A `gchat_user` principal with the given labels, optionally linked to a
/// Console user; returns its `foreign_id`.
async fn gchat_user(fixture: &Fixture, label: &str, labels: Value, user: Option<i64>) -> String {
    gchat_user_as(fixture, fixture.name(label), labels, user).await
}

/// [`gchat_user`] under an exact `foreign_id`.
async fn gchat_user_as(
    fixture: &Fixture,
    foreign_id: String,
    labels: Value,
    user: Option<i64>,
) -> String {
    sqlx::query(
        "INSERT INTO principals (foreign_id, name, kind, labels, console_user_id, created_by_id, created_at, updated_at) \
         VALUES ($1, 'Example', 'gchat_user', $2, $3, $4, now(), now())",
    )
    .bind(&foreign_id)
    .bind(labels)
    .bind(user)
    .bind(fixture.admin)
    .execute(&fixture.pool)
    .await
    .unwrap();
    foreign_id
}

#[tokio::test]
async fn finds_a_google_chat_user_by_google_account_not_by_email() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let subject = |label: &str| format!("{label}-{}", fixture.unique);
    let found = async |subject: String| {
        find_gchat_user_principal_by_google_subject(&fixture.pool, &subject)
            .await
            .unwrap()
            .and_then(|principal| principal.foreign_id)
    };

    // Labelled with the account: found whatever email it was created under.
    let labelled = gchat_user(
        &fixture,
        "labelled",
        json!({ "google_email": "ada@old.example", "google_subject": subject("ada") }),
        None,
    )
    .await;
    assert_eq!(found(subject("ada")).await, Some(labelled));

    // Unlabelled, but linked to the Console user who signs in with the account.
    sqlx::query(
        "INSERT INTO user_identities (user_id, provider, subject, email, email_verified, created_at, updated_at) \
         VALUES ($1, 'google', $2, 'admin@old.example', true, now(), now())",
    )
    .bind(fixture.admin)
    .bind(subject("admin"))
    .execute(&fixture.pool)
    .await
    .unwrap();
    let linked = gchat_user(
        &fixture,
        "linked",
        json!({ "google_email": "admin@old.example" }),
        Some(fixture.admin),
    )
    .await;
    assert_eq!(found(subject("admin")).await, Some(linked));

    // A principal labelled with another account is not that user's, even when
    // an operator linked it to them.
    gchat_user(
        &fixture,
        "other",
        json!({ "google_subject": subject("grace") }),
        Some(fixture.admin),
    )
    .await;
    assert_eq!(found(subject("admin")).await, Some(fixture.name("linked")));

    assert_eq!(found(subject("nobody")).await, None);
}

/// A Console user, optionally signing in with a Google account; returns its id.
async fn console_user(fixture: &Fixture, email: &str, google: Option<(&str, &str, bool)>) -> i64 {
    let user: i64 = sqlx::query_scalar(
        "INSERT INTO users (email, admin, status, created_at, updated_at) \
         VALUES ($1, false, 'active', now(), now()) RETURNING id",
    )
    .bind(email)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    if let Some((subject, identity_email, verified)) = google {
        sqlx::query(
            "INSERT INTO user_identities (user_id, provider, subject, email, email_verified, created_at, updated_at) \
             VALUES ($1, 'google', $2, $3, $4, now(), now())",
        )
        .bind(user)
        .bind(subject)
        .bind(identity_email)
        .bind(verified)
        .execute(&fixture.pool)
        .await
        .unwrap();
    }
    user
}

#[tokio::test]
async fn an_unlabelled_principal_linked_to_another_google_account_is_not_claimable() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let subject = |label: &str| format!("{label}-{}", fixture.unique);
    let ada = console_user(
        &fixture,
        &format!("ada-{}@old.example", fixture.unique),
        Some((&subject("ada"), "ada@old.example", true)),
    )
    .await;
    let password_only = console_user(
        &fixture,
        &format!("pw-{}@old.example", fixture.unique),
        None,
    )
    .await;
    let linked_to_ada = gchat_user(&fixture, "ada", json!({}), Some(ada)).await;
    let linked_without_google = gchat_user(&fixture, "pw", json!({}), Some(password_only)).await;
    let unlinked = gchat_user(&fixture, "unlinked", json!({}), None).await;
    let conflict = async |foreign_id: &str, subject: String| {
        principal_is_linked_to_another_google_account(&fixture.pool, foreign_id, &subject)
            .await
            .unwrap()
    };

    assert!(conflict(&linked_to_ada, subject("grace")).await);
    assert!(!conflict(&linked_to_ada, subject("ada")).await);
    assert!(!conflict(&linked_without_google, subject("grace")).await);
    assert!(!conflict(&unlinked, subject("grace")).await);
    assert!(!conflict(&fixture.name("missing"), subject("grace")).await);
}

/// Secrets [`Fixture::grant_secret_values`] makes visible in a principal's
/// effective config.
const GRANTED_SECRETS: usize = 3;

/// A Google account id no other test uses.
fn google_account() -> String {
    rand::random::<u64>().to_string()
}

/// The `foreign_id` api-rs derives for a Chat sender it sees for the first
/// time under `email`.
fn chat_sender_foreign_id(email: &str) -> String {
    let digest = hex::encode(Sha256::digest(email.as_bytes()));
    format!("gchat-user-{}-{}", slugify(email), &digest[..12])
}

/// Grants the principal `foreign_id` secrets and returns its OID.
async fn grant_secrets(fixture: &Fixture, foreign_id: &str) -> String {
    let principal = find_principal_by_foreign_id(&fixture.pool, foreign_id)
        .await
        .unwrap()
        .expect("principal exists");
    fixture.grant_secret_values(principal.id).await;
    oid("prn", principal.id)
}

/// The OID of the principal api-rs resolves a verified Chat sender to, with
/// the number of secrets that principal is granted. The registrar reads
/// Console's database as it does in production; its admin API is unreachable,
/// so resolving must not write.
async fn chat_sender(
    fixture: &Fixture,
    email: &str,
    subject: Option<&str>,
) -> Option<(String, usize)> {
    let client = IronControlClient::new("http://127.0.0.1:9", "unused")
        .with_console_db(fixture.pool.clone());
    let metadata = json!({
        "googlechat_request_verified": true,
        "googlechat_requester_email": email,
        "googlechat_requester_subject": subject,
    });
    let principal = SessionRegistrar::new(client.clone())
        .resolve_requester(
            "chat:spaces:GROUP:spaces:GROUP:threads:T1",
            Some(&metadata),
            false,
        )
        .await
        .unwrap()?;
    let config = client.effective_config(&principal.id).await.unwrap();
    Some((principal.id, config.secrets.len()))
}

#[tokio::test]
async fn a_renamed_chat_sender_keeps_the_unlabelled_principal_of_its_console_user() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let address = |label: &str| format!("{label}-{}@example.com", fixture.unique);
    let subject = google_account();
    let ada = console_user(
        &fixture,
        &address("ada-old"),
        Some((&subject, &address("ada-old"), true)),
    )
    .await;
    let foreign_id = gchat_user_as(
        &fixture,
        chat_sender_foreign_id(&address("ada-old")),
        json!({ "google_email": address("ada-old") }),
        Some(ada),
    )
    .await;
    let principal = grant_secrets(&fixture, &foreign_id).await;

    assert_eq!(
        chat_sender(&fixture, &address("ada-new"), Some(&subject)).await,
        Some((principal, GRANTED_SECRETS))
    );
}

#[tokio::test]
async fn another_google_account_reusing_an_address_never_resolves_to_its_linked_principal() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let address = format!("ada-{}@example.com", fixture.unique);
    let (ada_subject, grace_subject) = (google_account(), google_account());
    let ada = console_user(&fixture, &address, Some((&ada_subject, &address, true))).await;
    let foreign_id = gchat_user_as(
        &fixture,
        chat_sender_foreign_id(&address),
        json!({ "google_email": address }),
        Some(ada),
    )
    .await;
    let ada_principal = grant_secrets(&fixture, &foreign_id).await;
    // The address alone names Ada's principal, so it is the one at stake.
    assert_eq!(
        chat_sender(&fixture, &address, None).await,
        Some((ada_principal.clone(), GRANTED_SECRETS))
    );

    assert_eq!(
        chat_sender(&fixture, &address, Some(&grace_subject)).await,
        None
    );

    // Once the sender has the principal keyed on its own account id, it
    // resolves to that one, which holds none of Ada's grants.
    let own = gchat_user_as(
        &fixture,
        format!("gchat-user-{grace_subject}"),
        json!({}),
        None,
    )
    .await;
    let own = find_principal_by_foreign_id(&fixture.pool, &own)
        .await
        .unwrap()
        .expect("principal exists");
    assert_eq!(
        chat_sender(&fixture, &address, Some(&grace_subject)).await,
        Some((oid("prn", own.id), 0))
    );
    assert_eq!(
        chat_sender(&fixture, &address, Some(&ada_subject)).await,
        Some((ada_principal, GRANTED_SECRETS))
    );
}

#[tokio::test]
async fn a_renamed_chat_sender_keeps_the_principal_labelled_with_its_account() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let address = |label: &str| format!("{label}-{}@example.com", fixture.unique);
    let subject = google_account();
    let foreign_id = gchat_user_as(
        &fixture,
        chat_sender_foreign_id(&address("ada-old")),
        json!({ "google_email": address("ada-old"), "google_subject": subject }),
        None,
    )
    .await;
    let principal = grant_secrets(&fixture, &foreign_id).await;

    assert_eq!(
        chat_sender(&fixture, &address("ada-new"), Some(&subject)).await,
        Some((principal, GRANTED_SECRETS))
    );
}

#[tokio::test]
async fn links_a_google_chat_principal_to_the_user_of_the_account_before_the_email() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let subject = |label: &str| format!("{label}-{}", fixture.unique);
    let address = |label: &str| format!("{label}-{}@example.com", fixture.unique);
    // Ada was renamed: her stored email is the old address, and her Google
    // sign-in has since reported the new one.
    let ada = console_user(
        &fixture,
        &address("ada-old"),
        Some((&subject("ada"), &address("ada-new"), true)),
    )
    .await;
    let password_only = console_user(&fixture, &address("pw"), None).await;
    console_user(
        &fixture,
        &address("unverified-owner"),
        Some((&subject("unverified"), &address("claimed"), false)),
    )
    .await;
    let found = async |subject: Option<String>, email: String| {
        find_user_id_for_google_account(&fixture.pool, subject.as_deref(), &email)
            .await
            .unwrap()
    };

    // The account id finds her whatever address Chat reports.
    assert_eq!(
        found(Some(subject("ada")), address("ada-new")).await,
        Some(ada)
    );
    assert_eq!(
        found(Some(subject("ada")), address("elsewhere")).await,
        Some(ada)
    );
    // Without an account id, either of her addresses finds her.
    assert_eq!(found(None, address("ada-old")).await, Some(ada));
    assert_eq!(found(None, address("ada-new")).await, Some(ada));
    // Another account reporting one of her addresses is not her.
    assert_eq!(
        found(Some(subject("grace")), address("ada-old")).await,
        None
    );
    assert_eq!(
        found(Some(subject("grace")), address("ada-new")).await,
        None
    );
    // A user with no Google sign-in is still found by email.
    assert_eq!(
        found(Some(subject("grace")), address("pw")).await,
        Some(password_only)
    );
    // An unverified sign-in email names nobody.
    assert_eq!(found(None, address("claimed")).await, None);
    assert_eq!(found(None, address("nobody")).await, None);

    // An address two users are known by names neither.
    console_user(
        &fixture,
        &address("ada-new"),
        Some((&subject("twin"), &address("twin"), true)),
    )
    .await;
    assert_eq!(found(None, address("ada-new")).await, None);
}

#[tokio::test]
async fn reads_api_clients_and_their_principals() {
    let Some(fixture) = Fixture::new().await else {
        return;
    };
    let default = fixture.principal("default").await;
    let other = fixture.principal("other").await;
    let client: i64 = sqlx::query_scalar(
        "INSERT INTO api_clients (name, secret_digest, scopes, disabled_at, created_by_id, created_at, updated_at) \
         VALUES ($1, $2, '[\"sessions:read\", \"sessions:write\"]', now(), $3, now(), now()) RETURNING id",
    )
    .bind(fixture.name("client"))
    .bind(fixture.name("digest"))
    .bind(fixture.admin)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    for (principal, is_default) in [(default, true), (other, false)] {
        sqlx::query(
            "INSERT INTO api_client_principals (api_client_id, principal_id, \"default\", created_at, updated_at) \
             VALUES ($1, $2, $3, now(), now())",
        )
        .bind(client)
        .bind(principal)
        .bind(is_default)
        .execute(&fixture.pool)
        .await
        .unwrap();
    }

    assert_eq!(
        find_api_client(&fixture.pool, client).await.unwrap(),
        Some(ApiClient {
            id: client,
            name: fixture.name("client"),
            secret_digest: fixture.name("digest"),
            scopes: vec!["sessions:read".to_owned(), "sessions:write".to_owned()],
            disabled: true,
        })
    );
    assert_eq!(
        find_api_client(&fixture.pool, i64::MAX).await.unwrap(),
        None
    );
    assert_eq!(
        api_client_principals(&fixture.pool, client).await.unwrap(),
        vec![
            ApiClientPrincipal {
                principal_id: default,
                foreign_id: Some(fixture.name("default")),
                default: true,
            },
            ApiClientPrincipal {
                principal_id: other,
                foreign_id: Some(fixture.name("other")),
                default: false,
            },
        ]
    );
}
