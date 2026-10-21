//! Every invocation is first persisted as an immutable proposal. Only the authenticated
//! confirmation endpoint can claim it once; model planning cannot execute business tools.
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use super::{
    changed, fingerprint, hash, not_found, oauth, protocol, runtime, store,
    types::{ErrorCategory, MAX_RESULT_BYTES, Tool},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Invocation {
    pub owner_name: Option<String>,
    pub connection_kind: String,
    pub builtin_service_id: Option<String>,
    pub id: Uuid,
    pub connection_id: Uuid,
    pub connection_revision: i64,
    pub tool_name: String,
    pub arguments: Value,
    pub status: String,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub connection_title: String,
    pub card_url: String,
    pub endpoint_url: String,
}
#[derive(FromRow)]
struct StoredInvocation {
    id: Uuid,
    connection_id: Uuid,
    connection_revision: i64,
    request_fingerprint: Vec<u8>,
    tool_name: String,
    arguments: Value,
    tool_snapshot: Value,
    schema_fingerprint: String,
    status: String,
    expires_at: DateTime<Utc>,
}
const STORED: &str = "id,connection_id,connection_revision,request_fingerprint,tool_name,arguments,tool_snapshot,schema_fingerprint,status,expires_at";
const VIEW: &str = "i.id,i.connection_id,i.connection_revision,i.tool_name,i.arguments,i.status,i.result,i.error_code,i.created_at,i.updated_at,i.expires_at,i.connection_snapshot->>'title' AS connection_title,i.connection_snapshot->>'card_url' AS card_url,i.connection_snapshot->>'endpoint_url' AS endpoint_url,i.connection_snapshot->>'owner_name' AS owner_name,COALESCE(i.connection_snapshot->>'connection_kind','remote_mcp') AS connection_kind,i.connection_snapshot->>'builtin_service_id' AS builtin_service_id";

async fn expire(state: &AppState, user: Uuid) -> ApiResult<()> {
    sqlx::query("UPDATE plugin_invocations SET status=CASE WHEN status='running' THEN 'unknown' ELSE 'expired' END,error_code=CASE WHEN status='running' THEN 'PLUGIN_RESULT_UNKNOWN' ELSE 'PLUGIN_PROPOSAL_EXPIRED' END,updated_at=now() WHERE user_id=$1 AND ((status='running' AND execution_deadline<now()) OR (status='awaiting_confirmation' AND expires_at<now()))")
        .bind(user).execute(&state.pool).await?;
    Ok(())
}
async fn stored(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<StoredInvocation> {
    sqlx::query_as(&format!(
        "SELECT {STORED} FROM plugin_invocations WHERE id=$1 AND user_id=$2"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)
}
pub async fn get_invocation(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<Invocation> {
    expire(state, user).await?;
    sqlx::query_as(&format!("SELECT {VIEW} FROM plugin_invocations i JOIN plugin_connections c ON c.id=i.connection_id AND c.user_id=i.user_id WHERE i.id=$1 AND i.user_id=$2"))
        .bind(id).bind(user).fetch_optional(&state.pool).await?.ok_or_else(not_found)
}
pub async fn prepare_invocation(
    state: &AppState,
    user: Uuid,
    connection_id: Uuid,
    tool_name: String,
    arguments: Value,
    idempotency_key: Uuid,
) -> ApiResult<Invocation> {
    if tool_name.is_empty()
        || tool_name.len() > 512
        || tool_name.chars().count() > 128
        || !arguments.is_object()
        || serde_json::to_vec(&arguments)
            .map_err(|_| ApiError::internal())?
            .len()
            > 64 * 1024
    {
        return Err(ApiError::validation(
            "Tool arguments must be an object of at most 64 KiB.",
        ));
    }
    let request_hash = hash(
        serde_json::to_string(
            &json!({"connection_id":connection_id,"tool_name":tool_name,"arguments":arguments}),
        )
        .map_err(|_| ApiError::internal())?
        .as_bytes(),
    );
    if let Some(existing) = sqlx::query_as::<_, StoredInvocation>(&format!(
        "SELECT {STORED} FROM plugin_invocations WHERE user_id=$1 AND idempotency_key=$2"
    ))
    .bind(user)
    .bind(idempotency_key)
    .fetch_optional(&state.pool)
    .await?
    {
        if existing.request_fingerprint != request_hash {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This request key already belongs to a different proposal.",
            ));
        }
        return get_invocation(state, user, existing.id).await;
    }
    state.limit_auth(format!("plugin-propose:{user}"), 30)?;
    expire(state, user).await?;
    let initial_revision = store::owned(state, user, connection_id).await?.revision;
    let tools = store::load_tools_for_user(state, user, connection_id).await?;
    let tool = tools
        .into_iter()
        .find(|tool| tool.name == tool_name)
        .ok_or_else(|| {
            ApiError::validation("The selected tool is not available to this connection.")
        })?;
    protocol::validate_arguments(&tool, &arguments).map_err(super::mcp_error)?;
    let connection = store::owned(state, user, connection_id).await?;
    connection.usable()?;
    if connection.revision != initial_revision {
        return Err(changed());
    }
    let snapshot = json!(tool);
    let signature = fingerprint(&snapshot)?;
    let id = Uuid::new_v4();
    let card = connection.card()?;
    let owner_name = card.owner_name();
    let connection_snapshot = json!({"title":card.title,"card_url":card.card_url,"endpoint_url":card.endpoint_url,"owner_name":owner_name,"connection_kind":connection.connection_kind,"builtin_service_id":connection.builtin_service_id});
    let mut tx = state.pool.begin().await?;
    // Serialize this owner's quota and key creation without locking another domain's records.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('q.plugins:' || $1::text,731291))")
        .bind(user.to_string())
        .execute(&mut *tx)
        .await?;
    if let Some(existing) = sqlx::query_as::<_, StoredInvocation>(&format!(
        "SELECT {STORED} FROM plugin_invocations WHERE user_id=$1 AND idempotency_key=$2"
    ))
    .bind(user)
    .bind(idempotency_key)
    .fetch_optional(&mut *tx)
    .await?
    {
        if existing.request_fingerprint != request_hash {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This request key already belongs to a different proposal.",
            ));
        }
        tx.commit().await?;
        return get_invocation(state, user, existing.id).await;
    }
    let ready:Option<Uuid>=sqlx::query_scalar("SELECT id FROM plugin_connections WHERE id=$1 AND user_id=$2 AND revision=$3 AND status='ready' FOR SHARE")
        .bind(connection_id).bind(user).bind(initial_revision).fetch_optional(&mut *tx).await?;
    if ready.is_none() {
        return Err(changed());
    }
    let (count,bytes):(i64,i64)=sqlx::query_as("SELECT count(*)::bigint,COALESCE(sum(octet_length(arguments::text)+octet_length(tool_snapshot::text)+octet_length(connection_snapshot::text)+CASE WHEN status IN ('awaiting_confirmation','running','unknown') THEN 2097152 ELSE COALESCE(octet_length(result::text),0) END),0)::bigint FROM plugin_invocations WHERE user_id=$1")
        .bind(user).fetch_one(&mut *tx).await?;
    let reserved = 2
        * (arguments.to_string().len()
            + snapshot.to_string().len()
            + connection_snapshot.to_string().len()) as i64
        + 2097152;
    if count >= 5000 || bytes.saturating_add(reserved) > 64 * 1024 * 1024 {
        return Err(ApiError::conflict(
            "PLUGIN_STORAGE_LIMIT",
            "Plugin history has reached its storage limit. Existing invocations remain available; contact the administrator to archive history.",
        ));
    }
    let inserted:Option<Uuid>=sqlx::query_scalar("INSERT INTO plugin_invocations(id,user_id,connection_id,connection_revision,idempotency_key,request_fingerprint,tool_name,arguments,tool_snapshot,schema_fingerprint,connection_snapshot,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '10 minutes') ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING id")
        .bind(id).bind(user).bind(connection_id).bind(connection.revision).bind(idempotency_key).bind(&request_hash).bind(tool_name).bind(arguments).bind(snapshot).bind(signature).bind(connection_snapshot).fetch_optional(&mut *tx).await?;
    let id = if let Some(id) = inserted {
        id
    } else {
        let other: StoredInvocation = sqlx::query_as(&format!(
            "SELECT {STORED} FROM plugin_invocations WHERE user_id=$1 AND idempotency_key=$2"
        ))
        .bind(user)
        .bind(idempotency_key)
        .fetch_one(&mut *tx)
        .await?;
        if other.request_fingerprint != request_hash {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This request key already belongs to a different proposal.",
            ));
        }
        other.id
    };
    tx.commit().await?;
    get_invocation(state, user, id).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareRequest {
    connection_id: Uuid,
    tool_name: String,
    arguments: Value,
    idempotency_key: Uuid,
}
pub async fn prepare(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(body): ApiJson<PrepareRequest>,
) -> ApiResult<(StatusCode, Json<Invocation>)> {
    Ok((
        StatusCode::CREATED,
        Json(
            prepare_invocation(
                &state,
                auth.user_id,
                body.connection_id,
                body.tool_name,
                body.arguments,
                body.idempotency_key,
            )
            .await?,
        ),
    ))
}
pub async fn read(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Invocation>> {
    Ok(Json(get_invocation(&state, auth.user_id, id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    connection_id: Option<Uuid>,
}
pub async fn list(
    State(state): State<AppState>,
    auth: Authenticated,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<store::Items<Invocation>>> {
    expire(&state, auth.user_id).await?;
    if let Some(id) = query.connection_id {
        store::owned(&state, auth.user_id, id).await?;
    }
    let summary = VIEW.replace("i.result,", "NULL::jsonb AS result,");
    let items=sqlx::query_as(&format!("SELECT {summary} FROM plugin_invocations i JOIN plugin_connections c ON c.id=i.connection_id AND c.user_id=i.user_id WHERE i.user_id=$1 AND ($2::uuid IS NULL OR i.connection_id=$2) ORDER BY i.created_at DESC LIMIT 50"))
        .bind(auth.user_id).bind(query.connection_id).fetch_all(&state.pool).await?;
    Ok(Json(store::Items { items }))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Confirmation {
    confirmed: bool,
}
pub async fn confirm(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(body): ApiJson<Confirmation>,
) -> ApiResult<Json<Invocation>> {
    if !body.confirmed {
        return Err(ApiError::validation("Explicit confirmation is required."));
    }
    Ok(Json(confirm_owned(&state, auth.user_id, id).await?))
}

/// Intentionally not exported at the plugins root: AI planning can prepare/read, never confirm.
pub(crate) async fn confirm_owned(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<Invocation> {
    expire(state, user).await?;
    let proposal = stored(state, user, id).await?;
    if proposal.status != "awaiting_confirmation" {
        return get_invocation(state, user, id).await;
    }
    if proposal.expires_at <= Utc::now() {
        return get_invocation(state, user, id).await;
    }
    let tools = store::load_tools_for_user(state, user, proposal.connection_id).await?;
    let current = tools
        .iter()
        .find(|tool| tool.name == proposal.tool_name)
        .ok_or_else(changed)?;
    if fingerprint(&json!(current))? != proposal.schema_fingerprint {
        return Err(changed());
    }
    let connection = store::owned(state, user, proposal.connection_id).await?;
    connection.usable()?;
    if connection.revision != proposal.connection_revision {
        return Err(changed());
    }
    let tool: Tool =
        serde_json::from_value(proposal.tool_snapshot.clone()).map_err(|_| ApiError::internal())?;
    protocol::validate_arguments(&tool, &proposal.arguments).map_err(super::mcp_error)?;
    if connection.bank_service_id()?.is_some() {
        return confirm_bank(state, user, &connection, &proposal, &tool).await;
    }
    let bearer = oauth::bearer_for(state, &connection).await?;
    let runtime = runtime(state)?;
    let mut tx = state.pool.begin().await?;
    let ready:Option<Uuid>=sqlx::query_scalar("SELECT id FROM plugin_connections WHERE id=$1 AND user_id=$2 AND revision=$3 AND status='ready' FOR SHARE")
        .bind(connection.id).bind(user).bind(connection.revision).fetch_optional(&mut *tx).await?;
    if ready.is_none() {
        return Err(changed());
    }
    let claimed:Option<Uuid>=sqlx::query_scalar("UPDATE plugin_invocations SET status='running',confirmed_at=now(),execution_deadline=now()+interval '40 seconds',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='awaiting_confirmation' AND expires_at>now() RETURNING id")
        .bind(id).bind(user).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    if claimed.is_none() {
        return get_invocation(state, user, id).await;
    }
    // This committed reservation survives disconnects and crashes. A second confirmation
    // only reads it; it never dispatches another tools/call or fabricates rollback.
    let result = runtime
        .client
        .call_tool(
            &connection.card()?.endpoint_url,
            &tool,
            &proposal.arguments,
            bearer.as_ref(),
        )
        .await;
    let (status, result, error_code) = match result {
        Ok(result) => {
            if serde_json::to_vec(&result)
                .map_err(|_| ApiError::internal())?
                .len()
                > MAX_RESULT_BYTES
                || resource_links(&result) > 300
            {
                ("unknown", None, Some("MCP_LIMIT_EXCEEDED"))
            } else if result.get("resultType").and_then(Value::as_str) == Some("input_required") {
                ("input_required", Some(result), None)
            } else if result.get("isError").and_then(Value::as_bool) == Some(true) {
                ("tool_error", Some(result), None)
            } else {
                ("succeeded", Some(result), None)
            }
        }
        Err(error) => {
            store::record_remote_error(state, &connection, &error).await?;
            // A response rejected after dispatch can still follow an executed business action.
            // A pinned-address check can fail after request.send(), so even UnsafeNetwork
            // is uncertain here. Only input checks and explicit authorization rejection fail closed.
            let status = if matches!(
                error.category,
                ErrorCategory::Validation | ErrorCategory::Authorization
            ) {
                "failed"
            } else {
                "unknown"
            };
            let code = if error.category == ErrorCategory::Authorization {
                "PLUGIN_AUTH_REQUIRED"
            } else {
                error.code
            };
            (status, None, Some(code))
        }
    };
    sqlx::query("UPDATE plugin_invocations SET status=$3,result=$4,error_code=$5,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('running','unknown')")
        .bind(id).bind(user).bind(status).bind(result).bind(error_code).execute(&state.pool).await?;
    get_invocation(state, user, id).await
}

/// Internal demo tools and their receipt commit together. There is no remote dispatch window.
async fn confirm_bank(
    state: &AppState,
    user: Uuid,
    connection: &store::StoredConnection,
    proposal: &StoredInvocation,
    tool: &Tool,
) -> ApiResult<Invocation> {
    let mut tx = state.pool.begin().await?;
    // Account deletion takes identity -> connection -> invocation. Use the same order,
    // and let revocation win before the ledger is touched when it owns the connection lock.
    let active: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM identities WHERE id=$1 AND status='active' FOR SHARE")
            .bind(user)
            .fetch_optional(&mut *tx)
            .await?;
    if active.is_none() {
        return Err(ApiError::unauthorized());
    }
    let current: store::StoredConnection = sqlx::query_as(&format!(
        "SELECT {} FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR SHARE",
        store::CONNECTION_FIELDS
    ))
    .bind(connection.id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(not_found)?;
    current.usable()?;
    let service = current.bank_service_id()?.ok_or_else(changed)?;
    if current.status != "ready"
        || current.auth_status != "anonymous"
        || current.revision != proposal.connection_revision
        || current.builtin_service_id != connection.builtin_service_id
        || current.schema_fingerprint != connection.schema_fingerprint
    {
        return Err(changed());
    }
    let locked: StoredInvocation = sqlx::query_as(&format!(
        "SELECT {STORED} FROM plugin_invocations WHERE id=$1 AND user_id=$2 FOR UPDATE"
    ))
    .bind(proposal.id)
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(not_found)?;
    if locked.status != "awaiting_confirmation" {
        tx.commit().await?;
        return get_invocation(state, user, proposal.id).await;
    }
    // clock_timestamp is checked after lock waits, not transaction start time.
    let unexpired: bool = sqlx::query_scalar("SELECT $1::timestamptz > clock_timestamp()")
        .bind(locked.expires_at)
        .fetch_one(&mut *tx)
        .await?;
    if !unexpired {
        sqlx::query("UPDATE plugin_invocations SET status='expired',error_code='PLUGIN_PROPOSAL_EXPIRED',updated_at=now() WHERE id=$1 AND user_id=$2")
            .bind(proposal.id).bind(user).execute(&mut *tx).await?;
        tx.commit().await?;
        return get_invocation(state, user, proposal.id).await;
    }
    let result = crate::banking::execute_tool(
        &mut tx,
        user,
        service,
        proposal.id,
        &locked.tool_name,
        &locked.arguments,
    )
    .await?;
    protocol::validate_tool_result(tool, &result).map_err(super::mcp_error)?;
    if serde_json::to_vec(&result)
        .map_err(|_| ApiError::internal())?
        .len()
        > MAX_RESULT_BYTES
    {
        return Err(ApiError::internal());
    }
    let status = if result.get("isError").and_then(Value::as_bool) == Some(true) {
        "tool_error"
    } else {
        "succeeded"
    };
    sqlx::query("UPDATE plugin_invocations SET status=$3,result=$4,error_code=NULL,confirmed_at=now(),execution_deadline=NULL,updated_at=now() WHERE id=$1 AND user_id=$2")
        .bind(proposal.id).bind(user).bind(status).bind(result).execute(&mut *tx).await?;
    tx.commit().await?;
    get_invocation(state, user, proposal.id).await
}

fn resource_links(value: &Value) -> usize {
    let mut pending = vec![value];
    let mut links = 0;
    while let Some(item) = pending.pop() {
        if let Some(object) = item.as_object() {
            if object.get("type").and_then(Value::as_str) == Some("resource_link") {
                links += 1;
            }
            pending.extend(object.values());
        } else if let Some(array) = item.as_array() {
            pending.extend(array);
        }
        if links > 300 {
            break;
        }
    }
    links
}
pub async fn cancel(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Invocation>> {
    get_invocation(&state, auth.user_id, id).await?;
    sqlx::query("UPDATE plugin_invocations SET status='cancelled',updated_at=now() WHERE id=$1 AND user_id=$2 AND status='awaiting_confirmation'")
        .bind(id).bind(auth.user_id).execute(&state.pool).await?;
    Ok(Json(get_invocation(&state, auth.user_id, id).await?))
}
