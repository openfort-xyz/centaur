//! Google Chat permission endpoints for Console, connector, and operator callers.
use axum::{
    Extension,
    extract::{Path, State},
    response::Response,
    routing::{delete, post, put},
};
use centaur_console_db::{
    areas::principals::Grantee,
    google_chat_permissions::{
        self as db, DmPermission, DmWrite, Permission, SpacePermission, SpaceWrite,
    },
};
use serde::Deserialize;

use crate::AppState;
use crate::console::{
    guard::GuardedRoutes,
    http::{ConsoleError, created_data, json_data, no_content},
    request::ConsoleData,
    sandbox::SandboxContext,
};

#[derive(Default, Deserialize)]
struct Replacement {
    #[serde(default)]
    google_chat_space_permissions: Option<Vec<SpaceWrite>>,
    #[serde(default)]
    google_chat_dm_permissions: Option<Vec<DmWrite>>,
}

pub(super) fn console(routes: GuardedRoutes) -> GuardedRoutes {
    routes
        .console_admin(
            "/{owner}/{id}/google_chat_space_permissions",
            put(replace_spaces).post(upsert_spaces),
        )
        .console_admin(
            "/{owner}/{id}/google_chat_space_permissions/spaces/{target}",
            delete(delete_space),
        )
        .console_admin(
            "/{owner}/{id}/google_chat_space_permissions/{target}",
            delete(delete_space),
        )
        .console_admin(
            "/{owner}/{id}/google_chat_dm_permissions",
            put(replace_dms).post(upsert_dms),
        )
        .console_admin(
            "/{owner}/{id}/google_chat_dm_permissions/{target}",
            delete(delete_dm),
        )
}

pub(super) fn bearer(routes: GuardedRoutes) -> GuardedRoutes {
    routes
        .operator(
            "/{owner}/{id}/google_chat_space_permissions",
            post(operator_upsert_spaces),
        )
        .operator(
            "/{owner}/{id}/google_chat_space_permissions/{target}",
            delete(operator_delete_space),
        )
        .operator(
            "/{owner}/{id}/google_chat_dm_permissions",
            post(operator_upsert_dms),
        )
        .operator(
            "/{owner}/{id}/google_chat_dm_permissions/{target}",
            delete(operator_delete_dm),
        )
}

async fn owner(pool: &sqlx::PgPool, kind: &str, id: &str) -> Result<Grantee, ConsoleError> {
    match kind {
        "principals" => Ok(Grantee::Principal(
            super::principal_view(pool, id).await?.row.id,
        )),
        "roles" => Ok(Grantee::Role(super::role_view(pool, id).await?.row.id)),
        _ => Err(ConsoleError::not_found("permission owner not found")),
    }
}

async fn require_google_dm(
    pool: &sqlx::PgPool,
    binding: Option<Extension<SandboxContext>>,
) -> Result<(), ConsoleError> {
    if let Some(Extension(binding)) = binding {
        let principal = match binding.proxy.principal_id {
            Some(id) => centaur_console_db::find_principal(pool, id).await?,
            None => None,
        };
        if !principal.is_some_and(|principal| principal.kind == "gchat_dm") {
            return Err(ConsoleError::new(
                axum::http::StatusCode::FORBIDDEN,
                "Google Chat permission changes require a Google Chat DM from an active Console admin",
            ));
        }
    }
    Ok(())
}

async fn replace_spaces(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    binding: Option<Extension<SandboxContext>>,
    ConsoleData(data): ConsoleData<Replacement>,
) -> Result<Response, ConsoleError> {
    let pool = super::pool(&state)?;
    require_google_dm(&pool, binding).await?;
    let owner = owner(&pool, &kind, &id).await?;
    Ok(json_data(
        db::replace::<SpacePermission>(
            &pool,
            owner,
            data.google_chat_space_permissions
                .as_deref()
                .unwrap_or_default(),
        )
        .await?,
    ))
}

async fn replace_dms(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    binding: Option<Extension<SandboxContext>>,
    ConsoleData(data): ConsoleData<Replacement>,
) -> Result<Response, ConsoleError> {
    let pool = super::pool(&state)?;
    require_google_dm(&pool, binding).await?;
    let owner = owner(&pool, &kind, &id).await?;
    Ok(json_data(
        db::replace::<DmPermission>(
            &pool,
            owner,
            data.google_chat_dm_permissions
                .as_deref()
                .unwrap_or_default(),
        )
        .await?,
    ))
}

async fn upsert<P: Permission>(
    state: AppState,
    kind: String,
    id: String,
    data: P::Write,
    binding: Option<Extension<SandboxContext>>,
) -> Result<Response, ConsoleError> {
    let pool = super::pool(&state)?;
    require_google_dm(&pool, binding).await?;
    let owner = owner(&pool, &kind, &id).await?;
    let (row, inserted) = db::upsert::<P>(&pool, owner, &data).await?;
    Ok(if inserted {
        created_data(row)
    } else {
        json_data(row)
    })
}

macro_rules! upsert_handlers {
    ($console:ident, $operator:ident, $row:ty, $write:ty) => {
        async fn $console(
            State(state): State<AppState>,
            Path((kind, id)): Path<(String, String)>,
            binding: Option<Extension<SandboxContext>>,
            ConsoleData(data): ConsoleData<$write>,
        ) -> Result<Response, ConsoleError> {
            upsert::<$row>(state, kind, id, data, binding).await
        }
        async fn $operator(
            State(state): State<AppState>,
            Path((kind, id)): Path<(String, String)>,
            ConsoleData(data): ConsoleData<$write>,
        ) -> Result<Response, ConsoleError> {
            upsert::<$row>(state, kind, id, data, None).await
        }
    };
}
upsert_handlers!(
    upsert_spaces,
    operator_upsert_spaces,
    SpacePermission,
    SpaceWrite
);
upsert_handlers!(upsert_dms, operator_upsert_dms, DmPermission, DmWrite);

async fn destroy<P: Permission>(
    state: AppState,
    kind: String,
    id: String,
    target: String,
    by_oid: bool,
    binding: Option<Extension<SandboxContext>>,
) -> Result<Response, ConsoleError> {
    let pool = super::pool(&state)?;
    require_google_dm(&pool, binding).await?;
    let owner = owner(&pool, &kind, &id).await?;
    db::destroy::<P>(&pool, owner, &target, by_oid).await?;
    Ok(no_content())
}

async fn delete_space(
    State(state): State<AppState>,
    Path((kind, id, target)): Path<(String, String, String)>,
    binding: Option<Extension<SandboxContext>>,
) -> Result<Response, ConsoleError> {
    destroy::<SpacePermission>(
        state,
        kind,
        id,
        format!("spaces/{}", target.trim()),
        false,
        binding,
    )
    .await
}
async fn delete_dm(
    State(state): State<AppState>,
    Path((kind, id, target)): Path<(String, String, String)>,
    binding: Option<Extension<SandboxContext>>,
) -> Result<Response, ConsoleError> {
    destroy::<DmPermission>(state, kind, id, target, false, binding).await
}
async fn operator_delete_space(
    State(state): State<AppState>,
    Path((kind, id, target)): Path<(String, String, String)>,
) -> Result<Response, ConsoleError> {
    destroy::<SpacePermission>(state, kind, id, target, true, None).await
}
async fn operator_delete_dm(
    State(state): State<AppState>,
    Path((kind, id, target)): Path<(String, String, String)>,
) -> Result<Response, ConsoleError> {
    destroy::<DmPermission>(state, kind, id, target, true, None).await
}

#[cfg(test)]
#[path = "google_chat_tests.rs"]
mod tests;
