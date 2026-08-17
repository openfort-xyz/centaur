use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    sync::OnceLock,
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, Query},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[cfg(not(test))]
use crate::api_jwt::verify_console_jwt;
#[cfg(test)]
use crate::api_jwt::verify_hs256_jwt;
use crate::{ApiError, api_jwt::bearer_token, routes::AppState};

const DEFAULT_GOOGLECHATBOT_INTERNAL_URL: &str = "http://centaur-centaur-googlechatbot:3002";
const DEFAULT_JSON_BODY_MAX_BYTES: usize = 1024 * 1024;
// Interim JSON upload envelope: 100 MiB decoded content expands by 4/3 in base64.
// The bot enforces the authoritative 100 MiB decoded limit.
const DEFAULT_UPLOAD_BODY_MAX_BYTES: usize = 135 * 1024 * 1024;
const DEFAULT_DOWNLOAD_RESPONSE_MAX_BYTES: usize = 100 * 1024 * 1024;
const DEFAULT_JSON_RESPONSE_MAX_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(60);
const GOOGLE_CHAT_DWD_SUBJECT_HEADER: &str = "x-centaur-google-chat-dwd-subject";

pub(crate) fn google_chat_proxy_router() -> Router<AppState> {
    Router::new()
        .route("/api/google-chat/spaces", get(list_spaces))
        .route("/api/google-chat/spaces/{space_id}", get(get_space))
        .route(
            "/api/google-chat/spaces/{space_id}/messages",
            get(list_messages).post(send_message),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/messages/{message_id}",
            patch(update_message).delete(delete_message),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/threads/{thread_id}",
            get(list_thread_messages),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/members",
            get(list_members),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/messages/{message_id}/reactions",
            get(list_reactions),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/attachments",
            post(upload_attachment),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/files",
            get(list_files),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/messages/{message_id}/attachments/{attachment_id}",
            get(get_attachment),
        )
        .route(
            "/api/google-chat/spaces/{space_id}/messages/{message_id}/attachments/{attachment_id}/download",
            get(download_attachment),
        )
        .route("/api/google-chat/dms/setup", post(setup_dm))
        .route("/api/google-chat/dms/messages", post(send_dm))
        .layer(DefaultBodyLimit::disable())
}

#[derive(Clone, Debug, Default, Deserialize)]
struct GoogleChatProxyJwt {
    google_chat: GoogleChatClaims,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct GoogleChatClaims {
    #[serde(default)]
    reader_subjects: BTreeMap<String, String>,
    #[serde(default)]
    send_spaces: Vec<String>,
    #[serde(default)]
    update_spaces: Vec<String>,
    #[serde(default)]
    delete_spaces: Vec<String>,
    #[serde(default)]
    upload_spaces: Vec<String>,
    #[serde(default)]
    download_spaces: Vec<String>,
    #[serde(default)]
    history_spaces: Vec<String>,
    #[serde(default)]
    member_spaces: Vec<String>,
    #[serde(default)]
    reaction_spaces: Vec<String>,
    #[serde(default)]
    dm_setup_targets: Vec<String>,
}

#[derive(Deserialize)]
struct PageQuery {
    #[serde(default)]
    page_size: Option<u16>,
    #[serde(default)]
    page_token: Option<String>,
    #[serde(default)]
    filter: Option<String>,
    #[serde(default)]
    order_by: Option<String>,
}

#[derive(Deserialize)]
struct DmSetupQuery {
    target_identity: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DmMessageBody {
    text: String,
}

#[derive(Serialize)]
struct SpacesResponse {
    spaces: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_page_token: Option<String>,
}

#[derive(Clone)]
struct GoogleChatProxyConfig {
    client: reqwest::Client,
    internal_url: String,
    internal_key: String,
    max_json_body_bytes: usize,
    max_upload_body_bytes: usize,
    max_download_response_bytes: usize,
    max_json_response_bytes: usize,
}

async fn list_spaces(
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> Result<Json<SpacesResponse>, ApiError> {
    let claims = authorize(&headers)?;
    let allowed = validated_allowed_spaces(&claims.google_chat)?;
    if allowed.is_empty() {
        return Ok(Json(SpacesResponse {
            spaces: Vec::new(),
            next_page_token: None,
        }));
    }
    let query = page_query(&query)?;
    let value = forward_json(Method::GET, "/api/chat/spaces", query.as_deref(), None).await?;
    let spaces = value
        .get("spaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|space| {
            space
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| allowed.contains(name))
        })
        .cloned()
        .collect();
    let next_page_token = value
        .get("nextPageToken")
        .or_else(|| value.get("next_page_token"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Json(SpacesResponse {
        spaces,
        next_page_token,
    }))
}

async fn get_space(headers: HeaderMap, Path(space_id): Path<String>) -> Result<Response, ApiError> {
    let space = authorized_space(&headers, &space_id, Operation::History)?;
    forward(
        Method::GET,
        &format!("/api/chat/{space}"),
        None,
        Body::empty(),
        0,
    )
    .await
}

async fn list_messages(
    headers: HeaderMap,
    Path(space_id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::History)?;
    forward_as(
        Method::GET,
        &format!("/api/chat/{space}/messages"),
        page_query(&query)?.as_deref(),
        Body::empty(),
        0,
        subject.as_deref(),
    )
    .await
}

async fn list_thread_messages(
    headers: HeaderMap,
    Path((space_id, thread_id)): Path<(String, String)>,
    Query(mut query): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::History)?;
    validate_resource_id(&thread_id, "thread")?;
    query.filter = Some(format!("thread.name = {space}/threads/{thread_id}"));
    forward_as(
        Method::GET,
        &format!("/api/chat/{space}/messages"),
        page_query(&query)?.as_deref(),
        Body::empty(),
        0,
        subject.as_deref(),
    )
    .await
}

async fn list_members(
    headers: HeaderMap,
    Path(space_id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Members)?;
    forward_as(
        Method::GET,
        &format!("/api/chat/{space}/members"),
        page_query(&query)?.as_deref(),
        Body::empty(),
        0,
        subject.as_deref(),
    )
    .await
}

async fn list_reactions(
    headers: HeaderMap,
    Path((space_id, message_id)): Path<(String, String)>,
    Query(query): Query<PageQuery>,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Reactions)?;
    validate_resource_id(&message_id, "message")?;
    forward_as(
        Method::GET,
        &format!("/api/chat/{space}/messages/{message_id}/reactions"),
        page_query(&query)?.as_deref(),
        Body::empty(),
        0,
        subject.as_deref(),
    )
    .await
}

async fn get_attachment(
    headers: HeaderMap,
    Path((space_id, message_id, attachment_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let space = authorized_space(&headers, &space_id, Operation::Download)?;
    validate_resource_id(&message_id, "message")?;
    validate_resource_id(&attachment_id, "attachment")?;
    forward(
        Method::GET,
        &format!("/api/chat/{space}/messages/{message_id}/attachments/{attachment_id}"),
        None,
        Body::empty(),
        0,
    )
    .await
}

async fn list_files(
    headers: HeaderMap,
    Path(space_id): Path<String>,
    Query(query): Query<PageQuery>,
) -> Result<Json<Value>, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Download)?;
    let page = forward_json_as(
        Method::GET,
        &format!("/api/chat/{space}/messages"),
        page_query(&query)?.as_deref(),
        None,
        subject.as_deref(),
    )
    .await?;
    let files = files_from_messages(&space, &page);
    Ok(Json(json!({
        "files": files,
        "next_page_token": page.get("nextPageToken")
            .or_else(|| page.get("next_page_token"))
            .and_then(Value::as_str),
    })))
}

async fn download_attachment(
    headers: HeaderMap,
    Path((space_id, message_id, attachment_id)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    let space = authorized_space(&headers, &space_id, Operation::Download)?;
    validate_resource_id(&message_id, "message")?;
    validate_resource_id(&attachment_id, "attachment")?;
    let path = format!("/api/chat/{space}/messages/{message_id}/attachments/{attachment_id}");
    let metadata = forward_json(Method::GET, &path, None, None).await?;
    let response = forward(
        Method::GET,
        &format!("{path}/download"),
        None,
        Body::empty(),
        0,
    )
    .await?;
    download_response(response, &metadata, &attachment_id)
}

async fn send_message(
    headers: HeaderMap,
    Path(space_id): Path<String>,
    body: Body,
) -> Result<Response, ApiError> {
    let space = authorized_space(&headers, &space_id, Operation::Send)?;
    forward(
        Method::POST,
        &format!("/api/chat/{space}/messages"),
        None,
        body,
        config()?.max_json_body_bytes,
    )
    .await
}

async fn update_message(
    headers: HeaderMap,
    Path((space_id, message_id)): Path<(String, String)>,
    body: Body,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Update)?;
    validate_resource_id(&message_id, "message")?;
    forward_as(
        Method::PATCH,
        &format!("/api/chat/{space}/messages/{message_id}"),
        None,
        body,
        config()?.max_json_body_bytes,
        subject.as_deref(),
    )
    .await
}

async fn delete_message(
    headers: HeaderMap,
    Path((space_id, message_id)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Delete)?;
    validate_resource_id(&message_id, "message")?;
    forward_as(
        Method::DELETE,
        &format!("/api/chat/{space}/messages/{message_id}"),
        None,
        Body::empty(),
        0,
        subject.as_deref(),
    )
    .await
}

async fn upload_attachment(
    headers: HeaderMap,
    Path(space_id): Path<String>,
    body: Body,
) -> Result<Response, ApiError> {
    let (space, subject) = authorized_space_with_reader(&headers, &space_id, Operation::Upload)?;
    forward_as(
        Method::POST,
        &format!("/api/chat/{space}/attachments"),
        None,
        body,
        config()?.max_upload_body_bytes,
        subject.as_deref(),
    )
    .await
}

async fn setup_dm(
    headers: HeaderMap,
    Query(query): Query<DmSetupQuery>,
    body: Body,
) -> Result<Response, ApiError> {
    let target = authorized_dm_target(&headers, &query.target_identity)?;
    forward(
        Method::POST,
        "/api/chat/dms/setup",
        Some(&format!("target_identity={}", urlencoding::encode(&target))),
        body,
        config()?.max_json_body_bytes,
    )
    .await
}

async fn send_dm(
    headers: HeaderMap,
    Query(query): Query<DmSetupQuery>,
    body: Body,
) -> Result<Json<Value>, ApiError> {
    let target = authorized_dm_target(&headers, &query.target_identity)?;
    let bytes = to_bytes(body, config()?.max_json_body_bytes)
        .await
        .map_err(|_| {
            ApiError::PayloadTooLarge(
                "Google Chat request exceeded the configured limit".to_owned(),
            )
        })?;
    let message: DmMessageBody = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::BadRequest("invalid Google Chat DM message body".to_owned()))?;
    let space = forward_json(
        Method::POST,
        "/api/chat/dms/setup",
        Some(&format!("target_identity={}", urlencoding::encode(&target))),
        Some(b"{}".to_vec()),
    )
    .await?;
    let space_name = space
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Internal("Google Chat DM setup returned no space".to_owned()))?;
    let space_name = normalize_space(space_name)?;
    let sent = forward_json(
        Method::POST,
        &format!("/api/chat/{space_name}/messages"),
        None,
        Some(
            serde_json::to_vec(&json!({ "text": message.text })).map_err(|_| {
                ApiError::Internal("failed to encode Google Chat DM message".to_owned())
            })?,
        ),
    )
    .await?;
    Ok(Json(json!({ "space": space, "message": sent })))
}

#[derive(Clone, Copy)]
enum Operation {
    Send,
    Update,
    Delete,
    Upload,
    Download,
    History,
    Members,
    Reactions,
}

fn authorize(headers: &HeaderMap) -> Result<GoogleChatProxyJwt, ApiError> {
    let token = bearer_token(headers)?;
    #[cfg(test)]
    return verify_hs256_jwt(token, b"test-secret", "centaur-api", "centaur-console");
    #[cfg(not(test))]
    verify_console_jwt(token)
}

fn authorized_space(
    headers: &HeaderMap,
    space_id: &str,
    operation: Operation,
) -> Result<String, ApiError> {
    let claims = authorize(headers)?;
    let space = normalize_space(space_id)?;
    let allowed = operation_spaces(&claims.google_chat, operation);
    ensure_allowed(
        allowed,
        &space,
        "JWT is not authorized for this Google Chat operation",
    )?;
    Ok(space)
}

fn authorized_space_with_reader(
    headers: &HeaderMap,
    space_id: &str,
    operation: Operation,
) -> Result<(String, Option<String>), ApiError> {
    let claims = authorize(headers)?;
    let space = normalize_space(space_id)?;
    ensure_allowed(
        operation_spaces(&claims.google_chat, operation),
        &space,
        "Google Chat operation is not allowed for this space",
    )?;
    let subject = claims
        .google_chat
        .reader_subjects
        .get(&space)
        .map(String::as_str)
        .map(normalize_target_identity)
        .transpose()?;
    Ok((space, subject))
}

fn authorized_dm_target(headers: &HeaderMap, value: &str) -> Result<String, ApiError> {
    let claims = authorize(headers)?;
    let target = normalize_target_identity(value)?;
    ensure_allowed(
        &claims.google_chat.dm_setup_targets,
        &target,
        "JWT is not authorized to set up this Google Chat DM",
    )?;
    Ok(target)
}

fn files_from_messages(space: &str, page: &Value) -> Vec<Value> {
    page.get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|message| {
            let message_name = message
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let prefix = format!("{space}/messages/");
            let valid_message = message_name
                .strip_prefix(&prefix)
                .is_some_and(|id| validate_resource_id(id, "message").is_ok());
            message
                .get("attachment")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |attachment| {
                    if !valid_message {
                        return None;
                    }
                    let attachment_id = attachment_resource_name(attachment)
                        .and_then(|name| name.strip_prefix(&format!("{message_name}/attachments/")))
                        .filter(|id| validate_resource_id(id, "attachment").is_ok())?;
                    let mut file = attachment.clone();
                    let object = file.as_object_mut()?;
                    object.insert("space_name".to_owned(), Value::String(space.to_owned()));
                    object.insert(
                        "message_name".to_owned(),
                        Value::String(message_name.to_owned()),
                    );
                    object.insert(
                        "attachment_id".to_owned(),
                        Value::String(attachment_id.to_owned()),
                    );
                    if let Some(create_time) = message.get("createTime") {
                        object.insert("message_create_time".to_owned(), create_time.clone());
                    }
                    Some(file)
                })
        })
        .collect()
}

fn attachment_resource_name(attachment: &Value) -> Option<&str> {
    attachment
        .get("name")
        .or_else(|| attachment.pointer("/attachmentDataRef/resourceName"))
        .and_then(Value::as_str)
}

fn operation_spaces(claims: &GoogleChatClaims, operation: Operation) -> &[String] {
    match operation {
        Operation::Send => &claims.send_spaces,
        Operation::Update => &claims.update_spaces,
        Operation::Delete => &claims.delete_spaces,
        Operation::Upload => &claims.upload_spaces,
        Operation::Download => &claims.download_spaces,
        Operation::History => &claims.history_spaces,
        Operation::Members => &claims.member_spaces,
        Operation::Reactions => &claims.reaction_spaces,
    }
}

fn ensure_allowed(allowed: &[String], value: &str, message: &str) -> Result<(), ApiError> {
    if allowed.iter().any(|candidate| candidate == value) {
        Ok(())
    } else {
        Err(ApiError::Forbidden(message.to_owned()))
    }
}

fn validated_allowed_spaces(claims: &GoogleChatClaims) -> Result<BTreeSet<String>, ApiError> {
    claims
        .send_spaces
        .iter()
        .chain(&claims.update_spaces)
        .chain(&claims.delete_spaces)
        .chain(&claims.upload_spaces)
        .chain(&claims.download_spaces)
        .chain(&claims.history_spaces)
        .chain(&claims.member_spaces)
        .chain(&claims.reaction_spaces)
        .map(|space| normalize_space(space))
        .collect()
}

fn normalize_space(value: &str) -> Result<String, ApiError> {
    let id = value.strip_prefix("spaces/").unwrap_or(value);
    validate_resource_id(id, "space")?;
    Ok(format!("spaces/{id}"))
}

fn validate_resource_id(value: &str, kind: &str) -> Result<(), ApiError> {
    if !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Ok(());
    }
    Err(ApiError::BadRequest(format!(
        "invalid Google Chat {kind} resource ID"
    )))
}

fn normalize_target_identity(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    let valid_email = value.len() <= 320
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.is_empty()
                && !local.contains('/')
                && !domain.contains('/')
                && !domain.contains('@')
                && !value
                    .bytes()
                    .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        });
    if valid_email {
        Ok(value)
    } else {
        Err(ApiError::BadRequest(
            "Google Chat DM target must be an email address".to_owned(),
        ))
    }
}

fn page_query(query: &PageQuery) -> Result<Option<String>, ApiError> {
    let mut values = Vec::new();
    if let Some(size) = query.page_size {
        if !(1..=1000).contains(&size) {
            return Err(ApiError::BadRequest(
                "page_size must be between 1 and 1000".to_owned(),
            ));
        }
        values.push(format!("page_size={size}"));
    }
    if let Some(token) = query.page_token.as_deref() {
        if token.len() > 4096 || token.chars().any(char::is_control) {
            return Err(ApiError::BadRequest("invalid page_token".to_owned()));
        }
        values.push(format!("page_token={}", urlencoding::encode(token)));
    }
    if let Some(filter) = query.filter.as_deref() {
        if filter.len() > 4096 || filter.chars().any(char::is_control) {
            return Err(ApiError::BadRequest("invalid filter".to_owned()));
        }
        values.push(format!("filter={}", urlencoding::encode(filter)));
    }
    if let Some(order_by) = query.order_by.as_deref() {
        if order_by.len() > 4096 || order_by.chars().any(char::is_control) {
            return Err(ApiError::BadRequest("invalid order_by".to_owned()));
        }
        values.push(format!("order_by={}", urlencoding::encode(order_by)));
    }
    Ok((!values.is_empty()).then(|| values.join("&")))
}

async fn forward_json(
    method: Method,
    path: &str,
    query: Option<&str>,
    body: Option<Vec<u8>>,
) -> Result<Value, ApiError> {
    forward_json_as(method, path, query, body, None).await
}

async fn forward_json_as(
    method: Method,
    path: &str,
    query: Option<&str>,
    body: Option<Vec<u8>>,
    subject: Option<&str>,
) -> Result<Value, ApiError> {
    let response = forward_as(
        method,
        path,
        query,
        body.map(Body::from).unwrap_or_else(Body::empty),
        DEFAULT_JSON_BODY_MAX_BYTES,
        subject,
    )
    .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), config()?.max_json_response_bytes)
        .await
        .map_err(|_| {
            ApiError::PayloadTooLarge(
                "Google Chat response exceeded the configured limit".to_owned(),
            )
        })?;
    if !status.is_success() {
        return Err(upstream_status_error(status));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::Internal("Google Chat service returned invalid JSON".to_owned()))
}

async fn forward(
    method: Method,
    path: &str,
    query: Option<&str>,
    body: Body,
    max_body_bytes: usize,
) -> Result<Response, ApiError> {
    forward_as(method, path, query, body, max_body_bytes, None).await
}

async fn forward_as(
    method: Method,
    path: &str,
    query: Option<&str>,
    body: Body,
    max_body_bytes: usize,
    subject: Option<&str>,
) -> Result<Response, ApiError> {
    let config = config()?;
    let is_download = method == Method::GET && path.ends_with("/download");
    let max_response_bytes = if is_download {
        config.max_download_response_bytes
    } else {
        config.max_json_response_bytes
    };
    let mut url = format!("{}{}", config.internal_url, path);
    if let Some(query) = query {
        url.push('?');
        url.push_str(query);
    }
    let mut request = config
        .client
        .request(method, url)
        .bearer_auth(&config.internal_key)
        .header(header::CONTENT_TYPE.as_str(), "application/json");
    if let Some(subject) = subject {
        request = request.header(GOOGLE_CHAT_DWD_SUBJECT_HEADER, subject);
    }
    if max_body_bytes > 0 {
        let bytes = to_bytes(body, max_body_bytes).await.map_err(|_| {
            ApiError::PayloadTooLarge(
                "Google Chat request exceeded the configured limit".to_owned(),
            )
        })?;
        request = request.body(bytes);
    }
    let upstream = request.send().await.map_err(|error| {
        tracing::warn!(error = %error, "Google Chat internal service request failed");
        ApiError::ServiceUnavailable("Google Chat service request failed".to_owned())
    })?;
    let status = upstream.status();
    if !status.is_success() {
        return Err(upstream_status_error(status));
    }
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let declared_length = upstream
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if declared_length.is_some_and(|length| length > max_response_bytes) {
        return Err(ApiError::PayloadTooLarge(
            "Google Chat response exceeded the configured limit".to_owned(),
        ));
    }
    // Buffer to the ceiling before returning headers. This checks actual bytes
    // even when a broken upstream understates Content-Length, and prevents a
    // chunked over-limit body from becoming a committed HTTP 200.
    let bytes = to_bytes(
        Body::from_stream(upstream.bytes_stream()),
        max_response_bytes,
    )
    .await
    .map_err(|_| {
        ApiError::PayloadTooLarge("Google Chat response exceeded the configured limit".to_owned())
    })?;
    let actual_length = bytes.len();
    let mut response = Body::from(bytes).into_response();
    *response.status_mut() = status;
    if let Some(value) = content_type {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&actual_length.to_string()).expect("byte length is a valid header"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn download_response(
    response: Response,
    metadata: &Value,
    attachment_id: &str,
) -> Result<Response, ApiError> {
    let upstream_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let expected_type = metadata
        .get("contentType")
        .or_else(|| metadata.get("mime_type"))
        .and_then(Value::as_str);
    if unexpected_html(upstream_type) {
        return Err(ApiError::Internal(
            "Google Chat download returned HTML instead of file content".to_owned(),
        ));
    }
    let content_type = safe_content_type(expected_type.or(upstream_type));
    let filename = metadata
        .get("contentName")
        .or_else(|| metadata.get("filename"))
        .and_then(Value::as_str)
        .unwrap_or(attachment_id);
    let mut response = response;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type);
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition_filename(filename))
            .expect("sanitized filename is a valid header"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn unexpected_html(upstream_content_type: Option<&str>) -> bool {
    upstream_content_type.is_some_and(|value| {
        value
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("text/html")
    })
}

fn safe_content_type(value: Option<&str>) -> HeaderValue {
    value
        .filter(|value| value.len() <= 255 && valid_content_type(value))
        .and_then(|value| HeaderValue::from_str(value).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"))
}

fn valid_content_type(value: &str) -> bool {
    let media_type = value.split(';').next().unwrap_or_default().trim();
    let Some((kind, subtype)) = media_type.split_once('/') else {
        return false;
    };
    let valid_token = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#' | b'$' | b'&' | b'^' | b'_' | b'.' | b'+' | b'-'
                    )
            })
    };
    valid_token(kind) && valid_token(subtype)
}

fn content_disposition_filename(filename: &str) -> String {
    let sanitized = filename
        .chars()
        .take(200)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let sanitized = if sanitized.is_empty() || matches!(sanitized.as_str(), "." | "..") {
        "attachment"
    } else {
        &sanitized
    };
    format!("attachment; filename=\"{sanitized}\"")
}

fn upstream_status_error(status: StatusCode) -> ApiError {
    match status {
        StatusCode::BAD_REQUEST => {
            ApiError::BadRequest("Google Chat service rejected the request".to_owned())
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            ApiError::Forbidden("Google Chat service denied the request".to_owned())
        }
        StatusCode::NOT_FOUND => {
            ApiError::NotFound("Google Chat resource was not found".to_owned())
        }
        StatusCode::PAYLOAD_TOO_LARGE => {
            ApiError::PayloadTooLarge("Google Chat request was too large".to_owned())
        }
        StatusCode::SERVICE_UNAVAILABLE => {
            ApiError::ServiceUnavailable("Google Chat service is unavailable".to_owned())
        }
        _ => ApiError::Internal(format!(
            "Google Chat service returned status {}",
            status.as_u16()
        )),
    }
}

fn config() -> Result<GoogleChatProxyConfig, ApiError> {
    static CELL: OnceLock<GoogleChatProxyConfig> = OnceLock::new();
    if !cfg!(test)
        && let Some(config) = CELL.get()
    {
        return Ok(config.clone());
    }
    let internal_key = non_empty_env("GOOGLECHATBOT_INTERNAL_API_KEY").ok_or_else(|| {
        ApiError::Internal("GOOGLECHATBOT_INTERNAL_API_KEY is not configured".to_owned())
    })?;
    let connect_timeout = duration_env(
        "GOOGLE_CHAT_PROXY_CONNECT_TIMEOUT_MS",
        DEFAULT_HTTP_CONNECT_TIMEOUT,
    );
    let read_timeout = duration_env(
        "GOOGLE_CHAT_PROXY_READ_TIMEOUT_MS",
        DEFAULT_HTTP_READ_TIMEOUT,
    );
    let client = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .build()
        .map_err(|_| {
            ApiError::Internal("invalid Google Chat proxy HTTP configuration".to_owned())
        })?;
    let config = GoogleChatProxyConfig {
        client,
        internal_url: non_empty_env("GOOGLECHATBOT_INTERNAL_URL")
            .unwrap_or_else(|| DEFAULT_GOOGLECHATBOT_INTERNAL_URL.to_owned())
            .trim_end_matches('/')
            .to_owned(),
        internal_key,
        max_json_body_bytes: positive_env_usize(
            "GOOGLE_CHAT_PROXY_MAX_JSON_BODY_BYTES",
            DEFAULT_JSON_BODY_MAX_BYTES,
        ),
        max_upload_body_bytes: positive_env_usize(
            "GOOGLE_CHAT_PROXY_MAX_UPLOAD_BYTES",
            DEFAULT_UPLOAD_BODY_MAX_BYTES,
        ),
        max_download_response_bytes: positive_env_usize(
            "GOOGLE_CHAT_PROXY_MAX_DOWNLOAD_BYTES",
            DEFAULT_DOWNLOAD_RESPONSE_MAX_BYTES,
        ),
        max_json_response_bytes: positive_env_usize(
            "GOOGLE_CHAT_PROXY_MAX_JSON_RESPONSE_BYTES",
            DEFAULT_JSON_RESPONSE_MAX_BYTES,
        ),
    };
    Ok(if cfg!(test) {
        config
    } else {
        CELL.get_or_init(|| config).clone()
    })
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn positive_env_usize(name: &str, default: usize) -> usize {
    non_empty_env(name)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn duration_env(name: &str, default: Duration) -> Duration {
    Duration::from_millis(
        non_empty_env(name)
            .and_then(|value| value.parse().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default.as_millis() as u64),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{Request, Uri},
        routing::any,
    };
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use serde_json::json;
    use std::{
        convert::Infallible,
        ffi::OsString,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::{net::TcpListener, sync::Mutex};
    use tower::ServiceExt;

    static ENV_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

    #[derive(Debug, Eq, PartialEq)]
    struct ObservedRequest {
        method: Method,
        target: String,
        body: Vec<u8>,
        reader_subject: Option<String>,
    }

    struct EnvGuard(Vec<(String, Option<OsString>)>);

    impl EnvGuard {
        fn set(values: &[(&str, &str)]) -> Self {
            let previous = values
                .iter()
                .map(|(name, _)| ((*name).to_owned(), env::var_os(name)))
                .collect();
            for (name, value) in values {
                // SAFETY: this module serializes its environment-mutating tests.
                unsafe { env::set_var(name, value) };
            }
            Self(previous)
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (name, value) in &self.0 {
                // SAFETY: this module serializes its environment-mutating tests.
                unsafe {
                    if let Some(value) = value {
                        env::set_var(name, value);
                    } else {
                        env::remove_var(name);
                    }
                }
            }
        }
    }

    fn jwt(google_chat: Value, expires_at: i64) -> String {
        let now = time::OffsetDateTime::now_utc().unix_timestamp();
        encode(
            &Header::new(Algorithm::HS256),
            &json!({
                "iss": "centaur-console",
                "sub": "principal_test",
                "aud": "centaur-api",
                "iat": now,
                "exp": expires_at,
                "google_chat": google_chat,
            }),
            &EncodingKey::from_secret(b"test-secret"),
        )
        .unwrap()
    }

    fn authorized_jwt() -> String {
        let spaces = ["spaces/S", "spaces/ERROR", "spaces/TIMEOUT"];
        let claims = json!({
            "reader_subjects": { "spaces/S": "reader@example.com" },
            "send_spaces": spaces,
            "update_spaces": spaces,
            "delete_spaces": spaces,
            "upload_spaces": spaces,
            "download_spaces": spaces,
            "history_spaces": spaces,
            "member_spaces": spaces,
            "reaction_spaces": spaces,
            "dm_setup_targets": ["user@example.com"],
        });
        jwt(
            claims,
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        )
    }

    async fn call(
        app: &Router,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Body,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        app.clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }

    fn claims() -> GoogleChatClaims {
        GoogleChatClaims {
            reader_subjects: BTreeMap::from([(
                "spaces/HISTORY".to_owned(),
                "reader@example.com".to_owned(),
            )]),
            send_spaces: vec!["spaces/SEND".to_owned()],
            update_spaces: vec!["spaces/UPDATE".to_owned()],
            delete_spaces: vec!["spaces/DELETE".to_owned()],
            upload_spaces: vec!["spaces/UPLOAD".to_owned()],
            download_spaces: vec!["spaces/DOWNLOAD".to_owned()],
            history_spaces: vec!["spaces/HISTORY".to_owned()],
            member_spaces: vec!["spaces/MEMBERS".to_owned()],
            reaction_spaces: vec!["spaces/REACTIONS".to_owned()],
            dm_setup_targets: vec!["user@example.com".to_owned()],
        }
    }

    #[test]
    fn validates_and_normalizes_space_resources() {
        assert_eq!(normalize_space("ABC_123").unwrap(), "spaces/ABC_123");
        assert_eq!(normalize_space("spaces/ABC-123").unwrap(), "spaces/ABC-123");
        for invalid in ["", "spaces/", "spaces/A/B", "../A", "A%2fB", "A B"] {
            assert!(normalize_space(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn allowed_space_union_is_exact_and_validated() {
        let allowed = validated_allowed_spaces(&claims()).unwrap();
        assert!(allowed.contains("spaces/SEND"));
        assert!(allowed.contains("spaces/REACTIONS"));
        assert!(!allowed.contains("spaces/OTHER"));

        let mut invalid = claims();
        invalid.send_spaces = vec!["spaces/A/B".to_owned()];
        assert!(validated_allowed_spaces(&invalid).is_err());
    }

    #[test]
    fn every_operation_uses_only_its_matching_claim() {
        let claims = claims();
        for (operation, expected) in [
            (Operation::Send, "spaces/SEND"),
            (Operation::Update, "spaces/UPDATE"),
            (Operation::Delete, "spaces/DELETE"),
            (Operation::Upload, "spaces/UPLOAD"),
            (Operation::Download, "spaces/DOWNLOAD"),
            (Operation::History, "spaces/HISTORY"),
            (Operation::Members, "spaces/MEMBERS"),
            (Operation::Reactions, "spaces/REACTIONS"),
        ] {
            assert_eq!(operation_spaces(&claims, operation), &[expected.to_owned()]);
        }
    }

    #[test]
    fn dm_targets_are_canonical_and_exact() {
        assert_eq!(
            normalize_target_identity(" User@Example.COM ").unwrap(),
            "user@example.com"
        );
        for invalid in [
            "",
            "example.com",
            "users/12345",
            "users/User@Example.COM",
            "user@example.com@other.example",
            "a b@example.com",
        ] {
            assert!(
                normalize_target_identity(invalid).is_err(),
                "accepted {invalid}"
            );
        }
        ensure_allowed(&claims().dm_setup_targets, "user@example.com", "denied").unwrap();
        assert!(ensure_allowed(&claims().dm_setup_targets, "other@example.com", "denied").is_err());
    }

    #[test]
    fn page_query_is_bounded_and_encoded() {
        let query = PageQuery {
            page_size: Some(100),
            page_token: Some("a+b/c".to_owned()),
            filter: Some("thread.name = spaces/S/threads/T".to_owned()),
            order_by: Some("createTime DESC".to_owned()),
        };
        let encoded = page_query(&query).unwrap().unwrap();
        assert!(encoded.contains("page_size=100"));
        assert!(encoded.contains("page_token=a%2Bb%2Fc"));
        assert!(encoded.contains("filter=thread.name%20%3D%20spaces%2FS%2Fthreads%2FT"));
        assert!(encoded.contains("order_by=createTime%20DESC"));
        assert!(
            page_query(&PageQuery {
                page_size: Some(1001),
                page_token: None,
                filter: None,
                order_by: None,
            })
            .is_err()
        );
    }

    #[test]
    fn files_are_derived_only_from_exact_message_attachments() {
        let files = files_from_messages(
            "spaces/S",
            &json!({
                "messages": [
                    {
                        "name": "spaces/S/messages/M",
                        "createTime": "2026-01-01T00:00:00Z",
                        "attachment": [
                            {
                                "name": "spaces/S/messages/M/attachments/A",
                                "contentName": "report.pdf"
                            },
                            {
                                "attachmentDataRef": {
                                    "resourceName": "spaces/S/messages/M/attachments/B"
                                }
                            },
                            {"name": "spaces/OTHER/messages/M/attachments/ESCAPE"}
                        ]
                    },
                    {
                        "name": "spaces/OTHER/messages/M",
                        "attachment": [{"name": "spaces/OTHER/messages/M/attachments/C"}]
                    }
                ]
            }),
        );
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["space_name"], "spaces/S");
        assert_eq!(files[0]["message_name"], "spaces/S/messages/M");
        assert_eq!(files[0]["attachment_id"], "A");
        assert_eq!(files[1]["attachment_id"], "B");
        assert_eq!(files[1]["message_create_time"], "2026-01-01T00:00:00Z");
    }

    #[test]
    fn download_headers_are_sanitized_and_html_errors_are_detected() {
        assert_eq!(
            content_disposition_filename("../bad\r\nname.pdf"),
            "attachment; filename=\".._bad__name.pdf\""
        );
        assert_eq!(
            safe_content_type(Some("bad\r\nvalue")),
            HeaderValue::from_static("application/octet-stream")
        );
        assert!(unexpected_html(Some("text/html; charset=utf-8")));
        assert!(!unexpected_html(Some("application/pdf")));
    }

    #[tokio::test]
    async fn routes_reject_missing_jwt_before_upstream_configuration() {
        let app = google_chat_proxy_router().with_state(AppState::unready());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/google-chat/spaces/SPACE1/messages")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"text":"must not forward"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn routes_enforce_claims_before_forwarding_and_bound_upstream_io() {
        let _lock = ENV_LOCK.lock().await;
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_paths = Arc::clone(&paths);
        let upstream = Router::new().fallback(any(move |uri: Uri, headers: HeaderMap| {
            let observed = Arc::clone(&observed);
            let observed_paths = Arc::clone(&observed_paths);
            async move {
                observed.fetch_add(1, Ordering::SeqCst);
                observed_paths.lock().await.push(uri.path().to_owned());
                assert_eq!(
                    headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok()),
                    Some("Bearer internal-test-key")
                );
                if uri.path().contains("TIMEOUT") {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                if uri.path().contains("ERROR") {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "upstream secret detail")
                        .into_response();
                }
                if uri.path() == "/api/chat/spaces" {
                    return Json(json!({
                        "spaces": [{"name": "spaces/S"}, {"name": "spaces/OTHER"}],
                        "nextPageToken": "next",
                    }))
                    .into_response();
                }
                Json(json!({"ok": true, "path": uri.path()})).into_response()
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("GOOGLECHATBOT_INTERNAL_URL", &format!("http://{address}")),
            ("GOOGLECHATBOT_INTERNAL_API_KEY", "internal-test-key"),
            ("GOOGLE_CHAT_PROXY_MAX_JSON_BODY_BYTES", "64"),
            ("GOOGLE_CHAT_PROXY_MAX_UPLOAD_BYTES", "64"),
            ("GOOGLE_CHAT_PROXY_READ_TIMEOUT_MS", "20"),
        ]);
        let app = google_chat_proxy_router().with_state(AppState::unready());
        let allowed = authorized_jwt();
        let history_only = jwt(
            json!({"history_spaces": ["spaces/S"]}),
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        );
        let expired = jwt(json!({}), 1);
        let no_grants = jwt(
            json!({}),
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        );
        let legacy_user_resource = jwt(
            json!({"dm_setup_targets": ["users/123456789"]}),
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        );

        for (method, uri, token, body, expected) in [
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages",
                None,
                Body::empty(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages",
                Some("invalid"),
                Body::empty(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages",
                Some(expired.as_str()),
                Body::empty(),
                StatusCode::UNAUTHORIZED,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/OTHER/messages",
                Some(allowed.as_str()),
                Body::empty(),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/messages",
                Some(history_only.as_str()),
                Body::from("{}"),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/OTHER/files",
                Some(allowed.as_str()),
                Body::empty(),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/files",
                Some(history_only.as_str()),
                Body::empty(),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/attachments/A/download",
                Some(history_only.as_str()),
                Body::empty(),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::POST,
                "/api/google-chat/dms/setup?target_identity=other@example.com",
                Some(allowed.as_str()),
                Body::from("{}"),
                StatusCode::FORBIDDEN,
            ),
            (
                Method::POST,
                "/api/google-chat/dms/setup?target_identity=users%2F123456789",
                Some(legacy_user_resource.as_str()),
                Body::from("{}"),
                StatusCode::BAD_REQUEST,
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/messages",
                Some(allowed.as_str()),
                Body::from(vec![b'x'; 65]),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            assert_eq!(
                call(&app, method, uri, token, body).await.status(),
                expected,
                "{uri}"
            );
        }
        let encoded_path = call(
            &app,
            Method::GET,
            "/api/google-chat/spaces/S%2FOTHER/messages",
            Some(&allowed),
            Body::empty(),
        )
        .await;
        assert!(!encoded_path.status().is_success());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a denied request reached the upstream"
        );

        let empty_list = call(
            &app,
            Method::GET,
            "/api/google-chat/spaces",
            Some(&no_grants),
            Body::empty(),
        )
        .await;
        assert_eq!(empty_list.status(), StatusCode::OK);
        let empty_list: Value =
            serde_json::from_slice(&to_bytes(empty_list.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(empty_list["spaces"], json!([]));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "an empty grant reached upstream"
        );

        let list = call(
            &app,
            Method::GET,
            "/api/google-chat/spaces",
            Some(&allowed),
            Body::empty(),
        )
        .await;
        assert_eq!(list.status(), StatusCode::OK);
        let list: Value =
            serde_json::from_slice(&to_bytes(list.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(list["spaces"], json!([{"name": "spaces/S"}]));

        for (method, uri, body) in [
            (Method::GET, "/api/google-chat/spaces/S", Body::empty()),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages?page_size=20&page_token=a%2Bb",
                Body::empty(),
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/messages",
                Body::from("{}"),
            ),
            (
                Method::PATCH,
                "/api/google-chat/spaces/S/messages/M",
                Body::from("{}"),
            ),
            (
                Method::DELETE,
                "/api/google-chat/spaces/S/messages/M",
                Body::empty(),
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/threads/T",
                Body::empty(),
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/members",
                Body::empty(),
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/reactions",
                Body::empty(),
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/attachments/A",
                Body::empty(),
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/attachments",
                Body::from("{}"),
            ),
            (
                Method::POST,
                "/api/google-chat/dms/setup?target_identity=USER%40EXAMPLE.COM",
                Body::from("{}"),
            ),
        ] {
            assert_eq!(
                call(&app, method, uri, Some(&allowed), body).await.status(),
                StatusCode::OK,
                "{uri}"
            );
        }
        let forwarded_paths = paths.lock().await;
        assert!(
            forwarded_paths
                .iter()
                .any(|path| path == "/api/chat/spaces/S/messages/M/reactions")
        );
        assert!(
            forwarded_paths
                .iter()
                .any(|path| path == "/api/chat/spaces/S/messages/M/attachments/A")
        );
        drop(forwarded_paths);

        let upstream_error = call(
            &app,
            Method::GET,
            "/api/google-chat/spaces/ERROR",
            Some(&allowed),
            Body::empty(),
        )
        .await;
        assert_eq!(upstream_error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = String::from_utf8(
            to_bytes(upstream_error.into_body(), 4096)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(!body.contains("upstream secret detail"));

        let timeout = call(
            &app,
            Method::GET,
            "/api/google-chat/spaces/TIMEOUT",
            Some(&allowed),
            Body::empty(),
        )
        .await;
        assert_eq!(timeout.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn every_route_forwards_exact_method_target_and_body() {
        let _lock = ENV_LOCK.lock().await;
        let observed_requests = Arc::new(Mutex::new(Vec::<ObservedRequest>::new()));
        let recorded = Arc::clone(&observed_requests);
        let upstream = Router::new().fallback(any(move |request: Request<Body>| {
            let recorded = Arc::clone(&recorded);
            async move {
                let (parts, body) = request.into_parts();
                let target = parts.uri.path_and_query().map(ToString::to_string).unwrap();
                let body = to_bytes(body, 1024).await.unwrap().to_vec();
                recorded.lock().await.push(ObservedRequest {
                    method: parts.method,
                    target: target.clone(),
                    body,
                    reader_subject: parts
                        .headers
                        .get(GOOGLE_CHAT_DWD_SUBJECT_HEADER)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                });
                if target.starts_with("/api/chat/spaces?") {
                    return Json(json!({"spaces": [{"name": "spaces/S"}]})).into_response();
                }
                if target.starts_with("/api/chat/dms/setup?") {
                    return Json(json!({"name": "spaces/DM"})).into_response();
                }
                if target.ends_with("/attachments/A/download") {
                    return (
                        [(header::CONTENT_TYPE, "application/pdf")],
                        Body::from("PDF"),
                    )
                        .into_response();
                }
                if target.ends_with("/attachments/A") {
                    return Json(json!({
                        "name": "spaces/S/messages/M/attachments/A",
                        "contentName": "report.pdf",
                        "contentType": "application/pdf"
                    }))
                    .into_response();
                }
                Json(json!({"ok": true})).into_response()
            }
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("GOOGLECHATBOT_INTERNAL_URL", &format!("http://{address}")),
            ("GOOGLECHATBOT_INTERNAL_API_KEY", "internal-test-key"),
        ]);
        let app = google_chat_proxy_router().with_state(AppState::unready());
        let token = authorized_jwt();
        for (method, uri, body) in [
            (Method::GET, "/api/google-chat/spaces?page_size=3", ""),
            (Method::GET, "/api/google-chat/spaces/S", ""),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages?page_size=4&page_token=next&filter=createTime%20%3E%20%222026-08-13T00%3A00%3A00Z%22&order_by=createTime%20DESC",
                "",
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/messages",
                r#"{"text":"send"}"#,
            ),
            (
                Method::PATCH,
                "/api/google-chat/spaces/S/messages/M",
                r#"{"text":"edit"}"#,
            ),
            (Method::DELETE, "/api/google-chat/spaces/S/messages/M", ""),
            (
                Method::GET,
                "/api/google-chat/spaces/S/threads/T?page_size=5",
                "",
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/members?page_size=6",
                "",
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/reactions?page_size=7",
                "",
            ),
            (
                Method::POST,
                "/api/google-chat/spaces/S/attachments",
                r#"{"file":"body"}"#,
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/files?page_size=8",
                "",
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/attachments/A",
                "",
            ),
            (
                Method::GET,
                "/api/google-chat/spaces/S/messages/M/attachments/A/download",
                "",
            ),
            (
                Method::POST,
                "/api/google-chat/dms/setup?target_identity=USER%40EXAMPLE.COM",
                "{}",
            ),
            (
                Method::POST,
                "/api/google-chat/dms/messages?target_identity=USER%40EXAMPLE.COM",
                r#"{"text":"dm"}"#,
            ),
        ] {
            assert!(
                call(&app, method, uri, Some(&token), Body::from(body))
                    .await
                    .status()
                    .is_success(),
                "{uri}"
            );
        }

        assert_eq!(
            *observed_requests.lock().await,
            vec![
                observed(Method::GET, "/api/chat/spaces?page_size=3", ""),
                observed(Method::GET, "/api/chat/spaces/S", ""),
                observed_as(
                    Method::GET,
                    "/api/chat/spaces/S/messages?page_size=4&page_token=next&filter=createTime%20%3E%20%222026-08-13T00%3A00%3A00Z%22&order_by=createTime%20DESC",
                    "",
                    "reader@example.com"
                ),
                observed(
                    Method::POST,
                    "/api/chat/spaces/S/messages",
                    r#"{"text":"send"}"#
                ),
                observed_as(
                    Method::PATCH,
                    "/api/chat/spaces/S/messages/M",
                    r#"{"text":"edit"}"#,
                    "reader@example.com"
                ),
                observed_as(
                    Method::DELETE,
                    "/api/chat/spaces/S/messages/M",
                    "",
                    "reader@example.com"
                ),
                observed_as(
                    Method::GET,
                    "/api/chat/spaces/S/messages?page_size=5&filter=thread.name%20%3D%20spaces%2FS%2Fthreads%2FT",
                    "",
                    "reader@example.com"
                ),
                observed_as(
                    Method::GET,
                    "/api/chat/spaces/S/members?page_size=6",
                    "",
                    "reader@example.com"
                ),
                observed_as(
                    Method::GET,
                    "/api/chat/spaces/S/messages/M/reactions?page_size=7",
                    "",
                    "reader@example.com"
                ),
                observed_as(
                    Method::POST,
                    "/api/chat/spaces/S/attachments",
                    r#"{"file":"body"}"#,
                    "reader@example.com"
                ),
                observed_as(
                    Method::GET,
                    "/api/chat/spaces/S/messages?page_size=8",
                    "",
                    "reader@example.com"
                ),
                observed(
                    Method::GET,
                    "/api/chat/spaces/S/messages/M/attachments/A",
                    ""
                ),
                observed(
                    Method::GET,
                    "/api/chat/spaces/S/messages/M/attachments/A",
                    ""
                ),
                observed(
                    Method::GET,
                    "/api/chat/spaces/S/messages/M/attachments/A/download",
                    ""
                ),
                observed(
                    Method::POST,
                    "/api/chat/dms/setup?target_identity=user%40example.com",
                    "{}"
                ),
                observed(
                    Method::POST,
                    "/api/chat/dms/setup?target_identity=user%40example.com",
                    "{}"
                ),
                observed(
                    Method::POST,
                    "/api/chat/spaces/DM/messages",
                    r#"{"text":"dm"}"#
                ),
            ]
        );
    }

    fn observed(method: Method, target: &str, body: &str) -> ObservedRequest {
        ObservedRequest {
            method,
            target: target.to_owned(),
            body: body.as_bytes().to_vec(),
            reader_subject: None,
        }
    }

    fn observed_as(method: Method, target: &str, body: &str, subject: &str) -> ObservedRequest {
        ObservedRequest {
            reader_subject: Some(subject.to_owned()),
            ..observed(method, target, body)
        }
    }

    #[tokio::test]
    async fn declared_and_chunked_oversize_fail_before_success_status() {
        let _lock = ENV_LOCK.lock().await;
        let upstream = Router::new().fallback(any(|uri: Uri| async move {
            if uri.path().contains("DECLARED") {
                return ([(header::CONTENT_LENGTH, "5")], Body::from("12345")).into_response();
            }
            Body::from_stream(futures_util::stream::iter([
                Ok::<_, Infallible>("123"),
                Ok::<_, Infallible>("45"),
            ]))
            .into_response()
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("GOOGLECHATBOT_INTERNAL_URL", &format!("http://{address}")),
            ("GOOGLECHATBOT_INTERNAL_API_KEY", "internal-test-key"),
            ("GOOGLE_CHAT_PROXY_MAX_JSON_RESPONSE_BYTES", "4"),
        ]);
        let app = google_chat_proxy_router().with_state(AppState::unready());
        let token = jwt(
            json!({"history_spaces": ["spaces/DECLARED", "spaces/CHUNKED"]}),
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        );
        for space in ["DECLARED", "CHUNKED"] {
            let response = call(
                &app,
                Method::GET,
                &format!("/api/google-chat/spaces/{space}"),
                Some(&token),
                Body::empty(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE, "{space}");
        }
    }

    #[tokio::test]
    async fn download_enforces_boundary_raw_bytes_html_and_upstream_errors() {
        let _lock = ENV_LOCK.lock().await;
        let upstream = Router::new().fallback(any(|uri: Uri| async move {
            let path = uri.path();
            if !path.ends_with("/download") {
                let id = path.rsplit('/').next().unwrap();
                return Json(json!({
                    "name": format!("spaces/S/messages/M/attachments/{id}"),
                    "contentName": if id == "A" { "../bad\r\nname.pdf" } else { "file.bin" },
                    "contentType": if id == "A" { "bad\r\nvalue" } else { "image/png" }
                }))
                .into_response();
            }
            if path.contains("/A/") {
                return (
                    [
                        (header::CONTENT_LENGTH, "4"),
                        (header::CONTENT_TYPE, "application/pdf"),
                    ],
                    Body::from("1234"),
                )
                    .into_response();
            }
            if path.contains("/B/") {
                return ([(header::CONTENT_LENGTH, "5")], Body::from("12345")).into_response();
            }
            if path.contains("/H/") {
                return ([(header::CONTENT_TYPE, "text/html")], Body::from("<h>")).into_response();
            }
            if path.contains("/E/") {
                return (StatusCode::BAD_GATEWAY, "upstream secret").into_response();
            }
            Body::from_stream(futures_util::stream::iter([
                Ok::<_, Infallible>("123"),
                Ok::<_, Infallible>("45"),
            ]))
            .into_response()
        }));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("GOOGLECHATBOT_INTERNAL_URL", &format!("http://{address}")),
            ("GOOGLECHATBOT_INTERNAL_API_KEY", "internal-test-key"),
            ("GOOGLE_CHAT_PROXY_MAX_DOWNLOAD_BYTES", "4"),
        ]);
        let app = google_chat_proxy_router().with_state(AppState::unready());
        let token = jwt(
            json!({"download_spaces": ["spaces/S"]}),
            time::OffsetDateTime::now_utc().unix_timestamp() + 3600,
        );
        let boundary = download_call(&app, &token, "A").await;
        assert_eq!(boundary.status(), StatusCode::OK);
        assert_eq!(
            boundary.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            boundary.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\".._bad__name.pdf\""
        );
        assert_eq!(
            to_bytes(boundary.into_body(), 4).await.unwrap().as_ref(),
            b"1234"
        );
        assert_eq!(
            download_call(&app, &token, "B").await.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            download_call(&app, &token, "C").await.status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert_eq!(
            download_call(&app, &token, "H").await.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        let error = download_call(&app, &token, "E").await;
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = to_bytes(error.into_body(), 4096).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("upstream secret"));
    }

    async fn download_call(app: &Router, token: &str, attachment_id: &str) -> Response {
        let uri =
            format!("/api/google-chat/spaces/S/messages/M/attachments/{attachment_id}/download");
        call(app, Method::GET, &uri, Some(token), Body::empty()).await
    }
}
