use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

use regex::Regex;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    ApiError,
    models::{Credential, CredentialData, CredentialKind, GoogleChatClaims, ProxyRecord},
};

const CREDENTIALS_SQL: &str = include_str!("../sql/effective_credentials.sql");

pub(crate) async fn load_proxy(
    pool: &PgPool,
    token: &str,
) -> Result<Option<ProxyRecord>, ApiError> {
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let row = sqlx::query(
        "SELECT p.id, p.name, p.labels, p.principal_id, p.requester_principal_id, \
                p.principal_assigned_at AT TIME ZONE 'UTC' AS principal_assigned_at, \
                p.requester_principal_assigned_at AT TIME ZONE 'UTC' AS requester_principal_assigned_at, \
                pr.sync_config_cache_version AS principal_cache_version, \
                to_jsonb(pr) AS principal, u.email AS console_user_email, u.id AS console_user_id, \
                COALESCE(( \
                    SELECT jsonb_agg(effective.channel_id ORDER BY effective.channel_id) \
                    FROM ( \
                        SELECT permissions.channel_id \
                        FROM slack_channel_permissions permissions \
                        WHERE permissions.principal_id = p.principal_id \
                           OR permissions.role_id IN (SELECT role_id FROM principal_roles WHERE principal_id = p.principal_id) \
                        GROUP BY permissions.channel_id \
                        HAVING bool_or(permissions.history_enabled) \
                    ) effective \
                ), '[]'::jsonb) AS slack_history_channel_ids \
         FROM proxies p \
         LEFT JOIN principals pr ON pr.id = p.principal_id \
         LEFT JOIN users u ON u.id = pr.console_user_id \
         WHERE p.bearer_token_hash = $1",
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await
    .map_err(db_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mut proxy = ProxyRecord {
        id: row.get("id"),
        name: row.get("name"),
        labels: row.get("labels"),
        principal_id: row.get("principal_id"),
        requester_principal_id: row.get("requester_principal_id"),
        principal_assigned_at: row.get("principal_assigned_at"),
        requester_principal_assigned_at: row.get("requester_principal_assigned_at"),
        principal_cache_version: row.get("principal_cache_version"),
        principal: row.get("principal"),
        console_user_email: row.get("console_user_email"),
        console_user_id: row.get("console_user_id"),
        slack_history_channel_ids: row.get("slack_history_channel_ids"),
        google_chat: GoogleChatClaims::default(),
    };
    if let Some(principal_id) = proxy.principal_id {
        proxy.google_chat =
            google_chat_claims(pool, principal_id, proxy.principal_field("labels")).await?;
    }
    Ok(Some(proxy))
}

async fn google_chat_claims(
    pool: &PgPool,
    principal_id: i64,
    labels: &Value,
) -> Result<GoogleChatClaims, ApiError> {
    let rows = sqlx::query(
        "SELECT space_name, bool_or(send_enabled) AS send, bool_or(update_enabled) AS update, \
                bool_or(delete_enabled) AS delete, bool_or(upload_enabled) AS upload, \
                bool_or(download_enabled) AS download, bool_or(history_enabled) AS history, \
                bool_or(members_enabled) AS members, bool_or(reactions_enabled) AS reactions \
         FROM google_chat_space_permissions \
         WHERE principal_id = $1 OR role_id IN (SELECT role_id FROM principal_roles WHERE principal_id = $1) \
         GROUP BY space_name ORDER BY space_name"
    ).bind(principal_id).fetch_all(pool).await.map_err(db_error)?;
    let mut claims = GoogleChatClaims::default();
    let mut spaces = BTreeSet::new();
    for row in rows {
        let space: String = row.get("space_name");
        for (flag, targets) in [
            ("send", &mut claims.send_spaces),
            ("update", &mut claims.update_spaces),
            ("delete", &mut claims.delete_spaces),
            ("upload", &mut claims.upload_spaces),
            ("download", &mut claims.download_spaces),
            ("history", &mut claims.history_spaces),
            ("members", &mut claims.member_spaces),
            ("reactions", &mut claims.reaction_spaces),
        ] {
            if row.get::<bool, _>(flag) {
                targets.push(space.clone());
                spaces.insert(space.clone());
            }
        }
    }
    claims.dm_setup_targets = sqlx::query_scalar(
        "SELECT DISTINCT target_identity FROM google_chat_dm_permissions \
         WHERE setup_enabled AND (principal_id = $1 OR role_id IN (SELECT role_id FROM principal_roles WHERE principal_id = $1)) \
         ORDER BY target_identity"
    ).bind(principal_id).fetch_all(pool).await.map_err(db_error)?;
    let ids: Vec<_> = spaces
        .iter()
        .map(|space| space.trim_start_matches("spaces/"))
        .collect();
    let readers = sqlx::query(
        "SELECT labels FROM principals WHERE kind = 'gchat_dm' AND labels ->> 'gchat_space_id' = ANY($1)"
    ).bind(ids).fetch_all(pool).await.map_err(db_error)?;
    let mut subjects: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in readers {
        let labels: Value = row.get("labels");
        if let (Some(id), Some(email)) = (
            labels["gchat_space_id"].as_str(),
            labels["google_email"].as_str().and_then(reader_email),
        ) {
            subjects
                .entry(format!("spaces/{id}"))
                .or_default()
                .insert(email);
        }
    }
    let configured = &labels["google_chat_reader_subjects"];
    let parsed;
    let configured = if let Some(raw) = configured.as_str() {
        parsed = serde_json::from_str::<Value>(raw).unwrap_or(Value::Null);
        &parsed
    } else {
        configured
    };
    if let Some(configured) = configured.as_object() {
        for (space, email) in configured {
            if spaces.contains(space)
                && let Some(email) = email.as_str().and_then(reader_email)
            {
                subjects.entry(space.clone()).or_default().insert(email);
            }
        }
    }
    claims.reader_subjects = subjects
        .into_iter()
        .filter_map(|(space, emails)| {
            (emails.len() == 1).then(|| (space, emails.into_iter().next().unwrap()))
        })
        .collect();
    Ok(claims)
}

fn reader_email(email: &str) -> Option<String> {
    // Same address grammar as Console's URI::MailTo::EMAIL_REGEXP.
    static EMAIL: OnceLock<Regex> = OnceLock::new();
    let pattern = EMAIL.get_or_init(|| Regex::new(r"\A[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\z").unwrap());
    let email = email.trim().to_lowercase();
    pattern.is_match(&email).then_some(email)
}

pub(crate) async fn load_credentials(
    pool: &PgPool,
    principal_id: i64,
    requester_id: Option<i64>,
) -> Result<Vec<Credential>, ApiError> {
    let rows = sqlx::query(CREDENTIALS_SQL)
        .bind(principal_id)
        .bind(requester_id)
        .fetch_all(pool)
        .await
        .map_err(db_error)?;
    rows.into_iter()
        .map(|row| {
            let id = row.try_get("credential_id").map_err(db_error)?;
            let kind_name: String = row.try_get("kind").map_err(db_error)?;
            let kind = CredentialKind::parse(&kind_name).ok_or_else(|| {
                ApiError::internal(format!("credential {id} has unknown kind {kind_name:?}"))
            })?;
            let raw_data = row.try_get("credential").map_err(db_error)?;
            Ok(Credential {
                kind,
                id,
                priority: row.try_get("effective_priority").map_err(db_error)?,
                data: credential_data(kind, id, raw_data)?,
                sources: deserialize_json(
                    id,
                    "sources",
                    row.try_get("sources").map_err(db_error)?,
                )?,
                rules: deserialize_json(id, "rules", row.try_get("rules").map_err(db_error)?)?,
            })
        })
        .collect()
}

pub(crate) async fn permission_channels(
    pool: &PgPool,
    principal_id: i64,
) -> Result<(Vec<String>, Vec<String>, Vec<String>), ApiError> {
    let rows = sqlx::query(
        "SELECT channel_id, bool_or(upload_enabled) AS upload, bool_or(download_enabled) AS download, bool_or(history_enabled) AS history \
         FROM slack_channel_permissions \
         WHERE principal_id = $1 OR role_id IN (SELECT role_id FROM principal_roles WHERE principal_id = $1) \
         GROUP BY channel_id ORDER BY channel_id",
    )
    .bind(principal_id)
    .fetch_all(pool)
    .await
    .map_err(db_error)?;
    let mut upload = Vec::new();
    let mut download = Vec::new();
    let mut history = Vec::new();
    for row in rows {
        let channel: String = row.get("channel_id");
        if row.get("upload") {
            upload.push(channel.clone());
        }
        if row.get("download") {
            download.push(channel.clone());
        }
        if row.get("history") {
            history.push(channel);
        }
    }
    Ok((upload, download, history))
}

fn credential_data(
    kind: CredentialKind,
    id: i64,
    value: Value,
) -> Result<CredentialData, ApiError> {
    Ok(match kind {
        CredentialKind::Static => CredentialData::Static(deserialize_json(id, "data", value)?),
        CredentialKind::GcpAuth => CredentialData::GcpAuth(deserialize_json(id, "data", value)?),
        CredentialKind::GcpIdToken => {
            CredentialData::GcpIdToken(deserialize_json(id, "data", value)?)
        }
        CredentialKind::AwsAuth => CredentialData::AwsAuth(deserialize_json(id, "data", value)?),
        CredentialKind::OauthToken => {
            CredentialData::OauthToken(deserialize_json(id, "data", value)?)
        }
        CredentialKind::PgDsn => CredentialData::PgDsn(deserialize_json(id, "data", value)?),
        CredentialKind::Hmac => CredentialData::Hmac(deserialize_json(id, "data", value)?),
    })
}

fn deserialize_json<T: DeserializeOwned>(
    credential_id: i64,
    field: &str,
    value: Value,
) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|error| {
        ApiError::internal(format!(
            "credential {credential_id} has invalid {field}: {error}"
        ))
    })
}

fn db_error(error: sqlx::Error) -> ApiError {
    ApiError::internal(format!("database operation failed: {error}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::credential_data;
    use crate::models::CredentialKind;

    #[test]
    fn malformed_required_credential_fields_are_rejected() {
        let error = credential_data(CredentialKind::GcpIdToken, 42, json!({}))
            .expect_err("audience is required");

        assert!(error.message.contains("credential 42 has invalid data"));
        assert!(error.message.contains("missing field `audience`"));
    }
}
