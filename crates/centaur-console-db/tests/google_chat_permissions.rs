use centaur_console_db::{
    areas::principals::{self, Grantee, PrincipalWrite, RoleWrite},
    google_chat_permissions::{self as perms, DmPermission, SpacePermission, SpaceWrite},
    oid,
};
use serde_json::json;
mod common;

async fn user(pool: &sqlx::PgPool, email: &str) -> i64 {
    sqlx::query_scalar("INSERT INTO users(email,admin,status,created_at,updated_at) VALUES ($1,true,'active',now(),now()) RETURNING id").bind(email).fetch_one(pool).await.unwrap()
}

async fn cache(pool: &sqlx::PgPool, id: i64) -> i64 {
    sqlx::query_scalar("SELECT sync_config_cache_version FROM principals WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn google_chat_permissions_documents_routes_and_cache_invariants() {
    let Some(pool) = common::database().await else {
        return;
    };
    let unique = format!("{:016x}", rand::random::<u64>());
    let user = user(&pool, &format!("gchat-{unique}@example.test")).await;
    let principal = principals::create_principal(&pool, &serde_json::from_value(json!({
        "kind":"gchat_dm", "name":"Before", "google_chat_space_permissions":[{"space_name":"spaces/ABC","send_enabled":true}]
    })).unwrap(),user).await.unwrap();
    let id = principal.row.id;
    let owner = Grantee::Principal(id);
    let before = cache(&pool, id).await;
    let permission_id: i64 =
        sqlx::query_scalar("SELECT id FROM google_chat_space_permissions WHERE principal_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let rows: Vec<SpaceWrite> = serde_json::from_value(json!([{"space_name":" SPACES/ABC ","send_enabled":true},{"space_name":"spaces/ABC","send_enabled":true}])).unwrap();
    perms::replace::<SpacePermission>(&pool, owner, &rows)
        .await
        .unwrap();
    assert_eq!(cache(&pool, id).await, before);
    assert_eq!(
        permission_id,
        sqlx::query_scalar::<_, i64>(
            "SELECT id FROM google_chat_space_permissions WHERE principal_id = $1"
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let invalid: PrincipalWrite = serde_json::from_value(json!({"name":"After","google_chat_space_permissions":[{"space_name":"bad","send_enabled":true}]})).unwrap();
    assert!(
        principals::upsert_principal(&pool, &oid("prn", id), &invalid, user)
            .await
            .is_err()
    );
    let reread = principals::load_principal_view(&pool, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reread.row.name.as_deref(), Some("Before"));
    assert_eq!(
        reread
            .google_chat
            .direct
            .google_chat_space_permissions
            .len(),
        1
    );
    assert_eq!(cache(&pool, id).await, before);

    let role = principals::create_role(&pool,&serde_json::from_value::<RoleWrite>(json!({"google_chat_space_permissions":[{"space_name":"spaces/ABC","history_enabled":true}],"google_chat_dm_permissions":[{"target_identity":" Recipient@Example.test ","setup_enabled":true}]})).unwrap(),user).await.unwrap();
    principals::assign_role(&pool, id, &oid("role", role.row.id))
        .await
        .unwrap();
    let view = principals::load_principal_view(&pool, id)
        .await
        .unwrap()
        .unwrap();
    let payload = serde_json::to_value(principals::console_principal_payload(&view)).unwrap();
    assert_eq!(
        payload["google_chat_space_permissions"][0]["history_enabled"],
        false
    );
    assert_eq!(
        payload["inherited_google_chat_space_permissions"][0]["history_enabled"],
        true
    );
    assert_eq!(
        payload["effective_google_chat_space_permissions"][0]["send_enabled"],
        true
    );
    assert_eq!(
        payload["effective_google_chat_space_permissions"][0]["history_enabled"],
        true
    );
    assert_eq!(
        payload["effective_google_chat_dm_permissions"][0]["target_identity"],
        "recipient@example.test"
    );
    let before = cache(&pool, id).await;
    let update =
        serde_json::from_value(json!({"space_name":"spaces/ABC","upload_enabled":true})).unwrap();
    perms::upsert::<SpacePermission>(&pool, Grantee::Role(role.row.id), &update)
        .await
        .unwrap();
    assert_eq!(cache(&pool, id).await, before + 1);
    let (created, inserted) = perms::upsert::<SpacePermission>(
        &pool,
        owner,
        &serde_json::from_value(json!({"space_name":"spaces/NEW"})).unwrap(),
    )
    .await
    .unwrap();
    assert!(inserted && created.reactions_enabled && created.members_enabled);
    let before = cache(&pool, id).await;
    perms::upsert::<SpacePermission>(
        &pool,
        owner,
        &serde_json::from_value(json!({"space_name":"spaces/NEW"})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(cache(&pool, id).await, before);
    assert!(
        perms::destroy::<SpacePermission>(
            &pool,
            Grantee::Role(role.row.id),
            &oid("gcsp", permission_id),
            true
        )
        .await
        .is_err()
    );
    perms::destroy::<SpacePermission>(&pool, owner, &oid("gcsp", permission_id), true)
        .await
        .unwrap();
    assert!(
        perms::destroy::<SpacePermission>(&pool, owner, &oid("gcsp", permission_id), true)
            .await
            .is_err()
    );
    perms::destroy::<DmPermission>(
        &pool,
        Grantee::Role(role.row.id),
        " Recipient@Example.test ",
        false,
    )
    .await
    .unwrap();
    principals::delete_role(
        &pool,
        &principals::load_role_view(&pool, role.row.id)
            .await
            .unwrap()
            .unwrap(),
    )
    .await
    .unwrap();
    principals::delete_principal(
        &pool,
        &principals::load_principal_view(&pool, id)
            .await
            .unwrap()
            .unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn verified_google_dm_rechecks_current_requester_and_stable_google_account() {
    let Some(pool) = common::database().await else {
        return;
    };
    let unique = format!("{:016x}", rand::random::<u64>());
    let old_email = format!("old-{unique}@example.test");
    let email = format!("new-{unique}@example.test");
    let admin = user(&pool, &old_email).await;
    let subject = format!("google-{unique}");
    sqlx::query("INSERT INTO user_identities(user_id,provider,subject,email,email_verified,created_at,updated_at) VALUES ($1,'google',$2,$3,true,now(),now())").bind(admin).bind(&subject).bind(&email).execute(&pool).await.unwrap();
    let dm = principals::create_principal(
        &pool,
        &serde_json::from_value::<PrincipalWrite>(
            json!({"kind":"gchat_dm","console_user_id":admin,"labels":{"google_email":email}}),
        )
        .unwrap(),
        admin,
    )
    .await
    .unwrap();
    let requester = principals::create_principal(&pool,&serde_json::from_value::<PrincipalWrite>(json!({"kind":"gchat_user","console_user_id":admin,"labels":{"google_email":email,"google_subject":subject}})).unwrap(),admin).await.unwrap();
    let proxy: i64 = sqlx::query_scalar("INSERT INTO proxies(name,bearer_token_hash,principal_id,requester_principal_id,created_at,updated_at) VALUES ($1,'test-only-token-hash',$2,$3,now(),now()) RETURNING id").bind(format!("gchat-{unique}")).bind(dm.row.id).bind(requester.row.id).fetch_one(&pool).await.unwrap();
    let principal = centaur_console_db::find_principal(&pool, dm.row.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        perms::google_dm_admin_user_id(&pool, &principal, proxy)
            .await
            .unwrap(),
        Some(admin)
    );
    sqlx::query("UPDATE proxies SET requester_principal_id = NULL WHERE id = $1")
        .bind(proxy)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        perms::google_dm_admin_user_id(&pool, &principal, proxy)
            .await
            .unwrap(),
        None
    );
    sqlx::query("UPDATE proxies SET requester_principal_id = $2 WHERE id = $1")
        .bind(proxy)
        .bind(requester.row.id)
        .execute(&pool)
        .await
        .unwrap();
    for labels in [
        json!({"google_email":old_email,"google_subject":subject}),
        json!({"google_email":email,"google_subject":"different-subject"}),
    ] {
        sqlx::query("UPDATE principals SET labels = $2 WHERE id = $1")
            .bind(requester.row.id)
            .bind(labels)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            perms::google_dm_admin_user_id(&pool, &principal, proxy)
                .await
                .unwrap(),
            None
        );
    }
    sqlx::query("UPDATE principals SET labels = $2 WHERE id = $1")
        .bind(requester.row.id)
        .bind(json!({"google_email":email,"google_subject":subject}))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        perms::google_dm_admin_user_id(&pool, &principal, proxy)
            .await
            .unwrap(),
        Some(admin)
    );
    let mut conn = pool.acquire().await.unwrap();
    assert_eq!(
        perms::sso_linkable_user_id(&mut conn, "slack", &email)
            .await
            .unwrap(),
        Some(admin)
    );
    assert_eq!(
        perms::sso_linkable_user_id(&mut conn, "google", &email)
            .await
            .unwrap(),
        None
    );
    drop(conn);
    sqlx::query("DELETE FROM proxies WHERE id = $1")
        .bind(proxy)
        .execute(&pool)
        .await
        .unwrap();
    principals::delete_principal(&pool, &dm).await.unwrap();
    principals::delete_principal(&pool, &requester)
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_identities WHERE user_id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
}
