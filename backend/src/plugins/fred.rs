//! FRED data is request-local: no tool snapshots, invocation rows, query logs or result cache.
use super::{financial, legacy, mcp_error, runtime, store, types::McpError};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderValue, header},
    middleware,
    response::Response,
    routing::{get, post},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

async fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/v1/plugins/connections/{id}/fred/tools", get(tools))
        .route("/v1/plugins/connections/{id}/fred/query", post(query))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::map_response(no_store))
}
async fn owned(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<store::StoredConnection> {
    let connection = store::owned(state, user, id).await?;
    connection.usable()?;
    if connection.financial_provider_id.as_deref() != Some("fred") {
        return Err(super::not_found());
    }
    financial::binding(&connection)?;
    Ok(connection)
}
async fn check_current(state: &AppState, user: Uuid, id: Uuid, revision: i64) -> ApiResult<()> {
    let current = owned(state, user, id).await?;
    if current.revision != revision || current.auth_status != "authorized" {
        return Err(super::changed());
    }
    Ok(())
}
async fn tools(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    state.limit_auth(format!("fred-tools:{}", auth.user_id), 12)?;
    let c = owned(&state, auth.user_id, id).await?;
    let p = financial::binding(&c)?;
    let rt = runtime(&state)?;
    let bearer = financial::token(&state, &c).await?;
    let result = legacy::tools(&rt.http, p.endpoint, bearer.as_ref(), p.tools, p.initial).await;
    let items = financial::handle(&state, &c, result).await?;
    check_current(&state, auth.user_id, id, c.revision).await?;
    // Recover only the connection state; the returned tool definitions stay request-local.
    let recovered = sqlx::query("UPDATE plugin_connections SET status='ready',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND auth_status='authorized' AND status NOT IN ('revoked','needs_review')")
        .bind(id).bind(auth.user_id).bind(c.revision).execute(&state.pool).await?;
    if recovered.rows_affected() != 1 {
        return Err(super::changed());
    }
    Ok(Json(
        json!({"connection_revision":c.revision,"items":items,"retention":"ephemeral"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest {
    connection_revision: i64,
    tool_name: String,
    arguments: Value,
}
async fn query(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(body): ApiJson<QueryRequest>,
) -> ApiResult<Json<Value>> {
    state.limit_auth(format!("fred-query:{}", auth.user_id), 12)?;
    let c = owned(&state, auth.user_id, id).await?;
    let p = financial::binding(&c)?;
    if c.revision != body.connection_revision {
        return Err(super::changed());
    }
    if !p.tools.contains(&body.tool_name.as_str()) || !body.arguments.is_object() {
        return Err(ApiError::validation(
            "Select a supported FRED research operation.",
        ));
    }
    super::protocol::bounded_json(&body.arguments, 16 * 1024, 8, 1000).map_err(mcp_error)?;
    let rt = runtime(&state)?;
    let bearer = financial::token(&state, &c).await?;
    let result = tokio::time::timeout(Duration::from_secs(40), async {
        let mut session = legacy::Session::new(&rt.http, p.endpoint, bearer.as_ref(), p.initial);
        financial::handle(&state, &c, session.initialize().await).await?;
        let tools = financial::handle(&state, &c, session.read_tools(p.tools).await).await?;
        let tool = tools
            .iter()
            .find(|t| t.name == body.tool_name)
            .ok_or_else(|| {
                ApiError::validation("This FRED operation is not currently available.")
            })?;
        super::protocol::validate_arguments(tool, &body.arguments).map_err(mcp_error)?;
        check_current(&state, auth.user_id, id, c.revision).await?;
        let result = session.call_tool(tool, &body.arguments).await;
        let result = financial::handle(&state, &c, result).await?;
        check_current(&state, auth.user_id, id, c.revision).await?;
        Ok::<_, ApiError>(result)
    })
    .await
    .map_err(|_| mcp_error(McpError::timeout()))??;
    Ok(Json(
        json!({"connection_id":id,"connection_revision":c.revision,"tool_name":body.tool_name,"result":result,"retrieved_at":Utc::now(),"retention":"ephemeral"}),
    ))
}
