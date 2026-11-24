use crate::{
    ApiAuthConfig, AppState, build_router_with_app_state,
    console::{guard::GuardedRoutes, sandbox::SandboxJwtConfig, session_cookie::ConsoleSession},
    console_session::ConsoleSessionConfig,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use centaur_console_db::{
    areas::principals::{self, PrincipalWrite, RoleWrite},
    oid,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

#[tokio::test]
async fn google_chat_routes_accept_spa_connector_and_operator_paths() {
    let state = AppState::unready(ApiAuthConfig::testing("test-secret"));
    let console = super::console(GuardedRoutes::new(state.clone()))
        .into_router()
        .with_state(state.clone());
    let bearer = super::bearer(GuardedRoutes::new(state.clone()))
        .into_router()
        .with_state(state);
    for owner in ["principals/prn_example", "roles/role_example"] {
        for (method, path) in [
            ("PUT", format!("/{owner}/google_chat_space_permissions")),
            ("POST", format!("/{owner}/google_chat_space_permissions")),
            (
                "DELETE",
                format!("/{owner}/google_chat_space_permissions/spaces/AAAA"),
            ),
            (
                "DELETE",
                format!("/{owner}/google_chat_space_permissions/AAAA"),
            ),
            ("PUT", format!("/{owner}/google_chat_dm_permissions")),
            ("POST", format!("/{owner}/google_chat_dm_permissions")),
            (
                "DELETE",
                format!("/{owner}/google_chat_dm_permissions/a%40example.com"),
            ),
        ] {
            let response = console
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        for (method, path) in [
            ("POST", format!("/{owner}/google_chat_space_permissions")),
            (
                "DELETE",
                format!("/{owner}/google_chat_space_permissions/gcsp_example"),
            ),
            ("POST", format!("/{owner}/google_chat_dm_permissions")),
            (
                "DELETE",
                format!("/{owner}/google_chat_dm_permissions/gcdp_example"),
            ),
        ] {
            let response = bearer
                .clone()
                .oneshot(
                    Request::builder()
                        .method(method)
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
}

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    auth: &str,
    cookie: bool,
    data: Value,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "console.example.test")
        .header("origin", "https://console.example.test")
        .header("content-type", "application/json")
        .header(if cookie { "cookie" } else { "authorization" }, auth)
        .body(Body::from(json!({"data":data}).to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}

#[tokio::test]
async fn google_chat_permission_router_preserves_verified_dm_delegation_and_live_revocation() {
    let Some(pool) = crate::console::tests_db::test_pool().await else {
        return;
    };
    let unique = format!(
        "{:016x}",
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    );
    let email = format!("google-api-{unique}@example.test");
    let admin:i64=sqlx::query_scalar("INSERT INTO users(email,admin,status,created_at,updated_at) VALUES ($1,true,'active',now(),now()) RETURNING id").bind(&email).fetch_one(&pool).await.unwrap();
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
    let requester = principals::create_principal(
        &pool,
        &serde_json::from_value::<PrincipalWrite>(
            json!({"kind":"gchat_user","labels":{"google_email":email,"google_subject":unique}}),
        )
        .unwrap(),
        admin,
    )
    .await
    .unwrap();
    let role = principals::create_role(&pool, &RoleWrite::default(), admin)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_identities(user_id,provider,subject,email,email_verified,created_at,updated_at) VALUES ($1,'google',$2,$3,true,now(),now())").bind(admin).bind(&unique).bind(&email).execute(&pool).await.unwrap();
    let proxy:i64=sqlx::query_scalar("INSERT INTO proxies(name,bearer_token_hash,principal_id,requester_principal_id,created_at,updated_at) VALUES ($1,$1,$2,$3,now(),now()) RETURNING id").bind(&unique).bind(dm.row.id).bind(requester.row.id).fetch_one(&pool).await.unwrap();
    let config = ConsoleSessionConfig::from_settings(
        Some("google-chat-test-only-session-secret-0000000000000000000000000000000000000"),
        Some("https://console.example.test"),
    )
    .unwrap()
    .unwrap()
    .with_sandbox_jwt(
        SandboxJwtConfig::new(
            "google-chat-test-only-jwt-secret",
            crate::auth::SANDBOX_TOKEN_AUDIENCE,
            crate::auth::SANDBOX_TOKEN_ISSUER,
        )
        .unwrap(),
    );
    let cookie = config
        .cookie()
        .set_cookie_header(&ConsoleSession::signed_in(admin))
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let state = AppState::unready(ApiAuthConfig::testing("test-secret"))
        .with_console_db(pool.clone())
        .with_console_write_db(pool.clone())
        .with_console_session(config);
    let app = build_router_with_app_state(state);
    let path = format!(
        "/api/v1/console/principals/{}/google_chat_space_permissions",
        oid("prn", dm.row.id)
    );
    let operator_token = format!("google-chat-test-only-key-{unique}");
    sqlx::query("INSERT INTO api_keys(name,token_hash,user_id,created_at,updated_at) VALUES ('Google Chat test', $1,$2,now(),now())")
        .bind(hex::encode(Sha256::digest(operator_token.as_bytes()))).bind(admin).execute(&pool).await.unwrap();
    let operator_auth = format!("Bearer {operator_token}");
    let operator_path = path.replace("/console", "");
    let (status, body) = send(
        &app,
        "POST",
        &operator_path,
        &operator_auth,
        false,
        json!({"space_name":"spaces/OPERATOR"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let permission_id: i64 = sqlx::query_scalar("SELECT id FROM google_chat_space_permissions WHERE principal_id = $1 AND space_name = 'spaces/OPERATOR'").bind(dm.row.id).fetch_one(&pool).await.unwrap();
    let (status, body) = send(
        &app,
        "DELETE",
        &format!("{operator_path}/{}", oid("gcsp", permission_id)),
        &operator_auth,
        false,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let token=jsonwebtoken::encode(&jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),&json!({"iss":crate::auth::SANDBOX_TOKEN_ISSUER,"aud":crate::auth::SANDBOX_TOKEN_AUDIENCE,"exp":now+3600,"sub":oid("prn",dm.row.id),"proxy_id":oid("prx",proxy),"sandbox_id":unique,"console_delegate":true}),&jsonwebtoken::EncodingKey::from_secret(b"google-chat-test-only-jwt-secret")).unwrap();
    let auth = format!("Bearer {token}");
    let (status, body) = send(
        &app,
        "POST",
        &path,
        &auth,
        false,
        json!({"space_name":" SPACES/ABC "}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["data"]["space_name"], "spaces/ABC");
    assert_eq!(body["data"]["members_enabled"], true);
    let role_path = format!(
        "/api/v1/console/roles/{}/google_chat_dm_permissions",
        oid("role", role.row.id)
    );
    let (status,body)=send(&app,"PUT",&role_path,&cookie,true,json!({"google_chat_dm_permissions":[{"target_identity":" A@Example.test ","setup_enabled":true}]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"][0]["target_identity"], "a@example.test");
    let (status, body) = send(
        &app,
        "POST",
        &path.replace("space_permissions", "dm_permissions"),
        &auth,
        false,
        json!({"target_identity":"users/123"}),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    // Every request must use the proxy's current verified requester.
    for labels in [
        json!({}),
        json!({"google_email":"other@example.test","google_subject":unique}),
        json!({"google_email":email,"google_subject":"wrong-google-account"}),
    ] {
        sqlx::query("UPDATE principals SET labels = $2 WHERE id = $1")
            .bind(requester.row.id)
            .bind(labels)
            .execute(&pool)
            .await
            .unwrap();
        let (status, body) = send(
            &app,
            "POST",
            &path,
            &auth,
            false,
            json!({"space_name":"spaces/XYZ"}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    sqlx::query("UPDATE principals SET labels = $2 WHERE id = $1")
        .bind(requester.row.id)
        .bind(json!({"google_email":email,"google_subject":unique}))
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "DELETE",
        &format!("{path}/ABC"),
        &auth,
        false,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    for status_value in ["pending", "disabled"] {
        sqlx::query("UPDATE users SET status = $2 WHERE id = $1")
            .bind(admin)
            .bind(status_value)
            .execute(&pool)
            .await
            .unwrap();
        let (status, body) = send(
            &app,
            "POST",
            &path,
            &auth,
            false,
            json!({"space_name":"spaces/XYZ"}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    sqlx::query("UPDATE users SET status = 'active' WHERE id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET admin = false WHERE id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &path,
        &auth,
        false,
        json!({"space_name":"spaces/XYZ"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    sqlx::query("UPDATE users SET admin = true WHERE id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE principals SET kind = 'gchat_space' WHERE id = $1")
        .bind(dm.row.id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &path,
        &auth,
        false,
        json!({"space_name":"spaces/XYZ"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    sqlx::query("DELETE FROM proxies WHERE id = $1")
        .bind(proxy)
        .execute(&pool)
        .await
        .unwrap();
    principals::delete_role(&pool, &role).await.unwrap();
    principals::delete_principal(&pool, &dm).await.unwrap();
    principals::delete_principal(&pool, &requester)
        .await
        .unwrap();
    sqlx::query("DELETE FROM user_identities WHERE user_id = $1")
        .bind(admin)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM api_keys WHERE user_id = $1")
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
