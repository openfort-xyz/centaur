//! Google Chat permission records shared by Console documents and scoped APIs.
//! All writes and their sync-config invalidation use the caller's transaction.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sqlx::{PgConnection, PgPool, types::Json};

use crate::invalidate::{self, Scope};
use crate::{
    FieldErrors,
    areas::principals::{PrincipalError, Result},
    areas::secrets::Grantee,
};

pub trait Permission:
    Clone + PartialEq + Serialize + DeserializeOwned + Send + Sync + Unpin + 'static
{
    type Write: DeserializeOwned;
    const TABLE: &'static str;
    const PREFIX: &'static str;
    const NAME: &'static str;
    const KEY: &'static str;
    const FLAGS: &'static [&'static str];
    fn key(&self) -> &str;
    fn normalize(key: &str) -> String;
    fn from_write(write: &Self::Write, current: Option<&Self>, defaults: bool) -> Self;
    fn merge(&mut self, other: &Self);
    fn validate(&self) -> std::result::Result<(), FieldErrors>;
}

macro_rules! permission {
    ($row:ident, $write:ident, $table:literal, $prefix:literal, $name:literal, $key:ident, $normalize:ident, $validate:ident, [$($flag:ident),+]) => {
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        pub struct $row { pub $key: String, $(pub $flag: bool),+ }
        #[derive(Clone, Debug, Default, Deserialize)]
        pub struct $write {
            #[serde(default)] pub $key: Option<String>,
            $(#[serde(default)] pub $flag: Option<bool>),+
        }
        impl Permission for $row {
            type Write = $write;
            const TABLE: &'static str = $table;
            const PREFIX: &'static str = $prefix;
            const NAME: &'static str = $name;
            const KEY: &'static str = stringify!($key);
            const FLAGS: &'static [&'static str] = &[$(stringify!($flag)),+];
            fn key(&self) -> &str { &self.$key }
            fn normalize(key: &str) -> String { $normalize(key) }
            fn from_write(write: &$write, current: Option<&Self>, defaults: bool) -> Self {
                Self {
                    $key: Self::normalize(write.$key.as_deref().unwrap_or_default()),
                    $($flag: write.$flag.unwrap_or_else(|| current.map(|row| row.$flag).unwrap_or(defaults))),+
                }
            }
            fn merge(&mut self, other: &Self) { $(self.$flag |= other.$flag;)+ }
            fn validate(&self) -> std::result::Result<(), FieldErrors> {
                $validate(&self.$key, false $(|| self.$flag)+)
            }
        }
    };
}

permission!(
    SpacePermission,
    SpaceWrite,
    "google_chat_space_permissions",
    "gcsp",
    "GoogleChatSpacePermission",
    space_name,
    normalize_space,
    validate_space,
    [
        send_enabled,
        update_enabled,
        delete_enabled,
        upload_enabled,
        download_enabled,
        history_enabled,
        members_enabled,
        reactions_enabled
    ]
);
permission!(
    DmPermission,
    DmWrite,
    "google_chat_dm_permissions",
    "gcdp",
    "GoogleChatDmPermission",
    target_identity,
    normalize_email,
    validate_dm,
    [setup_enabled]
);

pub fn normalize_space(value: &str) -> String {
    let value = value.trim();
    match value.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("spaces/") => format!("spaces/{}", &value[7..]),
        _ => value.to_owned(),
    }
}

pub fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn valid_email(value: &str) -> bool {
    // Same address grammar as URI::MailTo::EMAIL_REGEXP in the fork.
    crate::validation::rules::matches(
        r"\A[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\z",
        value,
    )
}

pub(crate) fn valid_space(key: &str) -> bool {
    key.strip_prefix("spaces/").is_some_and(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    })
}

fn validate_space(key: &str, enabled: bool) -> std::result::Result<(), FieldErrors> {
    let mut errors = FieldErrors::default();
    if !valid_space(key) {
        errors.add("space_name", "is not a valid Google Chat space name");
    }
    if !enabled {
        errors.add("base", "Select at least one Google Chat space permission");
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn validate_dm(key: &str, enabled: bool) -> std::result::Result<(), FieldErrors> {
    let mut errors = FieldErrors::default();
    if key.starts_with("users/") || !valid_email(key) {
        errors.add("target_identity", "must be an email address");
    }
    if !enabled {
        errors.add("setup_enabled", "is not included in the list");
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

pub fn merged<P: Permission>(rows: impl IntoIterator<Item = P>) -> Vec<P> {
    let mut result: BTreeMap<String, P> = BTreeMap::new();
    for row in rows {
        result
            .entry(row.key().to_owned())
            .and_modify(|existing| existing.merge(&row))
            .or_insert(row);
    }
    result.into_values().collect()
}

pub fn normalized<P: Permission>(writes: &[P::Write]) -> Result<Vec<P>> {
    let rows = merged(writes.iter().map(|write| P::from_write(write, None, false)));
    for row in &rows {
        row.validate()?;
    }
    Ok(rows)
}

pub async fn load<P: Permission>(conn: &mut PgConnection, owner: Grantee) -> crate::Result<Vec<P>> {
    let rows: Vec<Json<P>> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(p) FROM {} p WHERE {} = $1 ORDER BY {}, id",
        P::TABLE,
        owner.column(),
        P::KEY
    ))
    .bind(owner.id())
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|row| row.0).collect())
}

async fn lock_owner(conn: &mut PgConnection, owner: Grantee) -> Result<()> {
    let table = match owner {
        Grantee::Principal(_) => "principals",
        Grantee::Role(_) => "roles",
    };
    sqlx::query(&format!("SELECT id FROM {table} WHERE id = $1 FOR UPDATE"))
        .bind(owner.id())
        .fetch_one(conn)
        .await?;
    Ok(())
}

async fn insert<P: Permission>(conn: &mut PgConnection, owner: Grantee, row: &P) -> Result<()> {
    let columns = std::iter::once(P::KEY)
        .chain(P::FLAGS.iter().copied())
        .collect::<Vec<_>>()
        .join(", ");
    // Only fixed model constants enter SQL. The JSON is bound and decoded by
    // PostgreSQL against the production table's own column types.
    sqlx::query(&format!("INSERT INTO {} (principal_id, role_id, {columns}, created_at, updated_at) SELECT $1, $2, {columns}, now(), now() FROM jsonb_populate_record(NULL::{}, $3) p", P::TABLE, P::TABLE))
        .bind(owner.principal_id()).bind(owner.role_id()).bind(Json(row)).execute(conn).await?;
    Ok(())
}

fn scope(owner: Grantee) -> Scope<'static> {
    Scope::Grantee {
        principal_id: owner.principal_id(),
        role_id: owner.role_id(),
    }
}

pub async fn replace_in_tx<P: Permission>(
    conn: &mut PgConnection,
    owner: Grantee,
    writes: &[P::Write],
) -> Result<Vec<P>> {
    let rows = normalized::<P>(writes)?;
    lock_owner(conn, owner).await?;
    if load::<P>(conn, owner).await? == rows {
        return Ok(rows);
    }
    sqlx::query(&format!(
        "DELETE FROM {} WHERE {} = $1",
        P::TABLE,
        owner.column()
    ))
    .bind(owner.id())
    .execute(&mut *conn)
    .await?;
    for row in &rows {
        insert(conn, owner, row).await?;
    }
    invalidate::invalidate(conn, scope(owner)).await?;
    Ok(rows)
}

pub async fn replace<P: Permission>(
    pool: &PgPool,
    owner: Grantee,
    writes: &[P::Write],
) -> Result<Vec<P>> {
    let mut tx = pool.begin().await?;
    let rows = replace_in_tx::<P>(&mut tx, owner, writes).await?;
    tx.commit().await?;
    Ok(rows)
}

pub async fn upsert<P: Permission>(
    pool: &PgPool,
    owner: Grantee,
    write: &P::Write,
) -> Result<(P, bool)> {
    let mut tx = pool.begin().await?;
    lock_owner(&mut tx, owner).await?;
    let key = P::from_write(write, None, true);
    let rows = load::<P>(&mut tx, owner).await?;
    let current = rows.iter().find(|row| row.key() == key.key());
    let row = P::from_write(write, current, true);
    row.validate()?;
    if current.is_none() {
        insert(&mut tx, owner, &row).await?;
    } else if current != Some(&row) {
        let assignments = P::FLAGS
            .iter()
            .map(|column| format!("{column} = p.{column}"))
            .collect::<Vec<_>>()
            .join(", ");
        sqlx::query(&format!("UPDATE {} t SET {assignments}, updated_at = now() FROM jsonb_populate_record(NULL::{}, $3) p WHERE t.{} = $1 AND t.{} = $2", P::TABLE, P::TABLE, owner.column(), P::KEY))
            .bind(owner.id()).bind(row.key()).bind(Json(&row)).execute(&mut *tx).await?;
    }
    if current != Some(&row) {
        invalidate::invalidate(&mut tx, scope(owner)).await?;
    }
    tx.commit().await?;
    Ok((row, current.is_none()))
}

pub async fn destroy<P: Permission>(
    pool: &PgPool,
    owner: Grantee,
    identifier: &str,
    by_oid: bool,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    lock_owner(&mut tx, owner).await?;
    let deleted = if by_oid {
        let id = crate::decode_oid(P::PREFIX, identifier)
            .ok_or_else(|| PrincipalError::NotFound(format!("{} not found", P::NAME)))?;
        sqlx::query(&format!(
            "DELETE FROM {} WHERE {} = $1 AND id = $2",
            P::TABLE,
            owner.column()
        ))
        .bind(owner.id())
        .bind(id)
        .execute(&mut *tx)
        .await?
    } else {
        sqlx::query(&format!(
            "DELETE FROM {} WHERE {} = $1 AND {} = $2",
            P::TABLE,
            owner.column(),
            P::KEY
        ))
        .bind(owner.id())
        .bind(P::normalize(identifier))
        .execute(&mut *tx)
        .await?
    };
    if deleted.rows_affected() == 0 {
        return Err(PrincipalError::NotFound(format!("{} not found", P::NAME)));
    }
    invalidate::invalidate(&mut tx, scope(owner)).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn delete_owner(conn: &mut PgConnection, owner: Grantee) -> Result<()> {
    for table in [SpacePermission::TABLE, DmPermission::TABLE] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE {} = $1",
            owner.column()
        ))
        .bind(owner.id())
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct DirectPermissions {
    pub google_chat_space_permissions: Vec<SpacePermission>,
    pub google_chat_dm_permissions: Vec<DmPermission>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct EffectivePermissions {
    pub effective_google_chat_space_permissions: Vec<SpacePermission>,
    pub effective_google_chat_dm_permissions: Vec<DmPermission>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct InheritedPermissions {
    pub inherited_google_chat_space_permissions: Vec<SpacePermission>,
    pub inherited_google_chat_dm_permissions: Vec<DmPermission>,
}

#[derive(Clone, Debug, Default)]
pub struct PermissionView {
    pub direct: DirectPermissions,
    pub effective: EffectivePermissions,
    pub inherited: InheritedPermissions,
}

pub async fn view(pool: &PgPool, owner: Grantee) -> crate::Result<PermissionView> {
    let mut conn = pool.acquire().await?;
    let direct = DirectPermissions {
        google_chat_space_permissions: load::<SpacePermission>(&mut conn, owner).await?,
        google_chat_dm_permissions: load::<DmPermission>(&mut conn, owner).await?,
    };
    let mut spaces = Vec::new();
    let mut dms = Vec::new();
    if let Grantee::Principal(id) = owner {
        let roles: Vec<i64> = sqlx::query_scalar(
            "SELECT role_id FROM principal_roles WHERE principal_id = $1 ORDER BY id",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
        for role in roles {
            spaces.extend(load::<SpacePermission>(&mut conn, Grantee::Role(role)).await?);
            dms.extend(load::<DmPermission>(&mut conn, Grantee::Role(role)).await?);
        }
    }
    let inherited = InheritedPermissions {
        inherited_google_chat_space_permissions: merged(spaces),
        inherited_google_chat_dm_permissions: merged(dms),
    };
    let effective = EffectivePermissions {
        effective_google_chat_space_permissions: merged(
            direct
                .google_chat_space_permissions
                .iter()
                .chain(&inherited.inherited_google_chat_space_permissions)
                .cloned(),
        ),
        effective_google_chat_dm_permissions: merged(
            direct
                .google_chat_dm_permissions
                .iter()
                .chain(&inherited.inherited_google_chat_dm_permissions)
                .cloned(),
        ),
    };
    Ok(PermissionView {
        direct,
        effective,
        inherited,
    })
}

/// Resolves a verified Google DM's linked admin against the live turn requester.
/// A link alone is insufficient, including after an email or account changes.
pub async fn google_dm_admin_user_id(
    pool: &PgPool,
    principal: &crate::Principal,
    proxy_id: i64,
) -> crate::Result<Option<i64>> {
    if principal.kind != "gchat_dm" {
        return Ok(None);
    }
    let email = normalize_email(
        principal
            .labels
            .get("google_email")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
    );
    if !valid_email(&email) {
        return Ok(None);
    }
    let requester: Option<Json<serde_json::Value>> = sqlx::query_scalar(
        "SELECT to_jsonb(p) FROM proxies proxy JOIN principals p ON p.id = proxy.requester_principal_id WHERE proxy.id = $1 AND proxy.principal_id = $2 AND p.kind = 'gchat_user'")
        .bind(proxy_id).bind(principal.id).fetch_optional(pool).await?;
    let Some(Json(requester)) = requester else {
        return Ok(None);
    };
    let labels = &requester["labels"];
    if normalize_email(labels["google_email"].as_str().unwrap_or_default()) != email {
        return Ok(None);
    }
    let subject = labels["google_subject"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let user_id = crate::find_user_id_for_google_account(pool, subject, &email).await?;
    Ok(user_id.filter(|id| Some(*id) == principal.console_user_id))
}

/// SSO may link only the single person known by this verified address, and
/// never attach a second Google account to that person's existing identity.
pub async fn sso_linkable_user_id(
    conn: &mut PgConnection,
    provider: &str,
    email: &str,
) -> crate::Result<Option<i64>> {
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM users WHERE email = $1 UNION SELECT user_id FROM user_identities WHERE provider = 'google' AND email_verified AND email = $1")
        .bind(email).fetch_all(&mut *conn).await?;
    let [id] = ids[..] else {
        return Ok(None);
    };
    if provider == "google" {
        let linked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM user_identities WHERE provider = 'google' AND user_id = $1)")
            .bind(id).fetch_one(conn).await?;
        if linked {
            return Ok(None);
        }
    }
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replacements_normalize_merge_flags_and_reject_invalid_resources() {
        let writes: Vec<SpaceWrite> = serde_json::from_value(json!([
            {"space_name":" SPACES/Ab_C-1 ","send_enabled":true},
            {"space_name":"spaces/Ab_C-1","history_enabled":true}
        ]))
        .unwrap();
        let rows = normalized::<SpacePermission>(&writes).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].space_name, "spaces/Ab_C-1");
        assert!(rows[0].send_enabled && rows[0].history_enabled);
        assert!(!rows[0].download_enabled);
        for value in [
            json!({"space_name":"spaces/empty"}),
            json!({"space_name":"spaces/a/b","send_enabled":true}),
            json!({"space_name":"spaces/","send_enabled":true}),
        ] {
            let write = serde_json::from_value(value).unwrap();
            assert!(normalized::<SpacePermission>(&[write]).is_err());
        }
    }

    #[test]
    fn dm_permissions_require_normalized_email_and_enabled_setup() {
        let writes: Vec<DmWrite> = serde_json::from_value(json!([
            {"target_identity":" A@Example.com ","setup_enabled":true},
            {"target_identity":"a@example.com","setup_enabled":false}
        ]))
        .unwrap();
        let rows = normalized::<DmPermission>(&writes).unwrap();
        assert_eq!(
            rows,
            vec![DmPermission {
                target_identity: "a@example.com".into(),
                setup_enabled: true
            }]
        );
        for key in ["users/123", "users/a@example.com", "bad", "a b@example.com"] {
            assert!(validate_dm(key, true).is_err());
        }
        assert!(validate_dm("a@example.com", false).is_err());
        assert!(
            serde_json::from_value::<DmWrite>(
                json!({"target_identity":"a@example.com","setup_enabled":"true"})
            )
            .is_err()
        );
    }

    #[test]
    fn upserts_default_all_flags_on_and_preserve_omitted_existing_flags() {
        let write: SpaceWrite = serde_json::from_value(json!({"space_name":"spaces/A"})).unwrap();
        let current = SpacePermission::from_write(&write, None, true);
        let value = serde_json::to_value(&current).unwrap();
        assert!(
            SpacePermission::FLAGS
                .iter()
                .all(|flag| value[flag] == true)
        );
        let update =
            serde_json::from_value(json!({"space_name":"spaces/A","send_enabled":false})).unwrap();
        let updated = SpacePermission::from_write(&update, Some(&current), true);
        assert!(!updated.send_enabled);
        assert!(updated.history_enabled && updated.reactions_enabled);
    }
}
