use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use super::{
    changed, discovery, fingerprint, hash, mcp_error, not_found, oauth, runtime,
    types::{Candidate, EntryKind, ErrorCategory, McpError, RemoteBearer, Tool},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};

#[derive(Clone, FromRow)]
pub(crate) struct StoredConnection {
    pub id: Uuid,
    pub user_id: Uuid,
    pub candidate: Value,
    pub pending_candidate: Option<Value>,
    pub tools_snapshot: Option<Value>,
    pub pending_tools: Option<Value>,
    pub schema_fingerprint: Option<String>,
    pub revision: i64,
    pub status: String,
    pub auth_status: String,
    pub auth_challenge: Option<Value>,
    pub requested_scopes: Vec<String>,
    pub last_error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
pub(crate) const CONNECTION_FIELDS: &str = "id,user_id,candidate,pending_candidate,tools_snapshot,pending_tools,schema_fingerprint,revision,status,auth_status,auth_challenge,requested_scopes,last_error_code,created_at,updated_at";
impl StoredConnection {
    pub(crate) fn card(&self) -> ApiResult<Candidate> {
        serde_json::from_value(self.candidate.clone()).map_err(|_| ApiError::internal())
    }
    pub(crate) fn usable(&self) -> ApiResult<()> {
        if self.status == "revoked" {
            return Err(not_found());
        }
        if self.status == "needs_review" {
            return Err(changed());
        }
        Ok(())
    }
    fn dto(&self) -> ApiResult<Connection> {
        let card = self.card()?;
        let pending_update = self.pending_candidate.is_some() || self.pending_tools.is_some();
        let pending_update_details = if pending_update {
            Some(PendingUpdate {
                candidate: self
                    .pending_candidate
                    .clone()
                    .map(serde_json::from_value::<Candidate>)
                    .transpose()
                    .map_err(|_| ApiError::internal())?
                    .map(|candidate| CandidateSummary {
                        card_url: candidate.card_url,
                        name: candidate.name,
                        title: candidate.title,
                        description: candidate.description,
                        version: candidate.version,
                        endpoint_url: candidate.endpoint_url,
                    }),
                tools: self
                    .pending_tools
                    .clone()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| ApiError::internal())?,
                previous_tools: self
                    .tools_snapshot
                    .clone()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| ApiError::internal())?,
            })
        } else {
            None
        };
        Ok(Connection {
            id: self.id,
            card_url: card.card_url,
            name: card.name,
            title: card.title,
            description: card.description,
            version: card.version,
            endpoint_url: card.endpoint_url,
            revision: self.revision,
            status: self.status.clone(),
            auth_status: self.auth_status.clone(),
            last_error_code: self.last_error_code.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            pending_update,
            pending_update_details,
        })
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub id: Uuid,
    pub card_url: String,
    pub name: String,
    pub title: String,
    pub description: String,
    pub version: String,
    pub endpoint_url: String,
    pub revision: i64,
    pub status: String,
    pub auth_status: String,
    pub last_error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub pending_update: bool,
    pub pending_update_details: Option<PendingUpdate>,
}
#[derive(Debug, Clone, Serialize)]
pub struct CandidateSummary {
    card_url: String,
    name: String,
    title: String,
    description: String,
    version: String,
    endpoint_url: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct PendingUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate: Option<CandidateSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_tools: Option<Vec<Tool>>,
}
#[derive(Serialize)]
pub struct Items<T> {
    pub items: Vec<T>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoverRequest {
    entry: String,
    kind: EntryKind,
}
#[derive(Serialize, Deserialize)]
struct SavedCandidate {
    id: Uuid,
    card: Candidate,
}
#[derive(Serialize)]
pub struct CandidateView {
    candidate_id: Uuid,
    card_url: String,
    name: String,
    title: String,
    description: String,
    version: String,
    endpoint_url: String,
}
#[derive(Serialize)]
pub struct DiscoveryResult {
    discovery_id: Uuid,
    expires_at: DateTime<Utc>,
    candidates: Vec<CandidateView>,
}

pub async fn discover(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<DiscoverRequest>,
) -> ApiResult<Json<DiscoveryResult>> {
    let runtime = runtime(&state)?;
    state.limit_auth(format!("plugin-discover:{}", auth.user_id), 10)?;
    if request.entry.len() > 4096 {
        return Err(ApiError::validation("Plugin entry is too long."));
    }
    let cards = discovery::discover_entry(&runtime.http, &request.entry, request.kind)
        .await
        .map_err(mcp_error)?;
    let saved: Vec<_> = cards
        .into_iter()
        .map(|card| SavedCandidate {
            id: Uuid::new_v4(),
            card,
        })
        .collect();
    let id = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::minutes(10);
    let kind = match request.kind {
        EntryKind::Card => "card",
        EntryKind::Catalog => "catalog",
        EntryKind::Page => "page",
        EntryKind::Domain => "domain",
    };
    let saved_json = json!(saved);
    if serde_json::to_vec(&saved_json)
        .map_err(|_| ApiError::internal())?
        .len()
        > 512 * 1024
    {
        return Err(ApiError::validation(
            "Discovered metadata exceeds the 512 KiB candidate limit. Use a specific Card URL.",
        ));
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('q.plugins:' || $1::text,731291))")
        .bind(auth.user_id.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM plugin_discoveries WHERE user_id=$1 AND expires_at<=now()")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_discoveries WHERE user_id=$1")
        .bind(auth.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= 20 {
        return Err(ApiError::conflict(
            "PLUGIN_DISCOVERY_LIMIT",
            "Too many active discoveries. Reuse a recent result or wait for its ten-minute expiry.",
        ));
    }
    sqlx::query("INSERT INTO plugin_discoveries(id,user_id,entry_kind,entry_url,candidates,expires_at) VALUES ($1,$2,$3,$4,$5,$6)")
        .bind(id).bind(auth.user_id).bind(kind).bind(request.entry).bind(saved_json).bind(expires_at).execute(&mut *tx).await?;
    tx.commit().await?;
    let candidates = saved
        .into_iter()
        .map(|item| CandidateView {
            candidate_id: item.id,
            card_url: item.card.card_url,
            name: item.card.name,
            title: item.card.title,
            description: item.card.description,
            version: item.card.version,
            endpoint_url: item.card.endpoint_url,
        })
        .collect();
    Ok(Json(DiscoveryResult {
        discovery_id: id,
        expires_at,
        candidates,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddRequest {
    discovery_id: Uuid,
    candidate_id: Uuid,
}
pub async fn add_connection(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<AddRequest>,
) -> ApiResult<(StatusCode, Json<Connection>)> {
    let runtime = runtime(&state)?;
    let record: Option<(Value, DateTime<Utc>)> = sqlx::query_as(
        "SELECT candidates,expires_at FROM plugin_discoveries WHERE id=$1 AND user_id=$2",
    )
    .bind(request.discovery_id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (value, expires) = record.ok_or_else(not_found)?;
    if expires <= Utc::now() {
        return Err(ApiError::conflict(
            "PLUGIN_DISCOVERY_EXPIRED",
            "Discover the service again before adding it.",
        ));
    }
    let saved: Vec<SavedCandidate> =
        serde_json::from_value(value).map_err(|_| ApiError::internal())?;
    let card = saved
        .into_iter()
        .find(|item| item.id == request.candidate_id)
        .ok_or_else(not_found)?
        .card;
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('q.plugins:' || $1::text,731291))")
        .bind(auth.user_id.to_string())
        .execute(&mut *tx)
        .await?;
    let service_id: Option<Uuid> = sqlx::query_scalar("INSERT INTO plugin_services(id,card_url,card_url_hash,anonymous_card) VALUES ($1,$2,$3,$4) ON CONFLICT(card_url_hash) DO UPDATE SET anonymous_card=EXCLUDED.anonymous_card,updated_at=now() WHERE plugin_services.card_url=EXCLUDED.card_url RETURNING id")
        .bind(Uuid::new_v4()).bind(&card.card_url).bind(hash(card.card_url.as_bytes())).bind(&card.card_json).fetch_optional(&mut *tx).await?;
    let service_id = service_id.ok_or_else(|| {
        ApiError::conflict(
            "PLUGIN_IDENTITY_CONFLICT",
            "Plugin identity could not be safely matched.",
        )
    })?;
    let existing: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM plugin_connections WHERE user_id=$1 AND service_id=$2)",
    )
    .bind(auth.user_id)
    .bind(service_id)
    .fetch_one(&mut *tx)
    .await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_connections WHERE user_id=$1")
        .bind(auth.user_id)
        .fetch_one(&mut *tx)
        .await?;
    if !existing && count >= 100 {
        return Err(ApiError::conflict(
            "PLUGIN_CONNECTION_LIMIT",
            "This account has reached its 100 saved connection limit.",
        ));
    }
    let id = Uuid::new_v4();
    let inserted: Option<Uuid> = sqlx::query_scalar("INSERT INTO plugin_connections(id,user_id,service_id,candidate) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,service_id) DO NOTHING RETURNING id")
        .bind(id).bind(auth.user_id).bind(service_id).bind(json!(card)).fetch_optional(&mut *tx).await?;
    let (id, should_probe) = if let Some(id) = inserted {
        (id, true)
    } else {
        let (id, status): (Uuid,String) = sqlx::query_as("SELECT id,status FROM plugin_connections WHERE user_id=$1 AND service_id=$2 FOR UPDATE").bind(auth.user_id).bind(service_id).fetch_one(&mut *tx).await?;
        if status == "revoked" {
            sqlx::query("UPDATE plugin_connections SET candidate=$3,pending_candidate=NULL,tools_snapshot=NULL,pending_tools=NULL,schema_fingerprint=NULL,revision=revision+1,status='ready',auth_status='none',auth_challenge=NULL,requested_scopes='{}',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2")
                .bind(id).bind(auth.user_id).bind(json!(card)).execute(&mut *tx).await?;
        }
        (id, status == "revoked")
    };
    tx.commit().await?;
    if should_probe {
        let connection = owned(&state, auth.user_id, id).await?;
        match runtime.client.discover(&card.endpoint_url, None).await {
            Ok(_) => {}
            Err(error) => {
                record_remote_error(&state, &connection, &error).await?;
            }
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(owned(&state, auth.user_id, id).await?.dto()?),
    ))
}

pub(crate) async fn owned(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<StoredConnection> {
    sqlx::query_as(&format!(
        "SELECT {CONNECTION_FIELDS} FROM plugin_connections WHERE id=$1 AND user_id=$2"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)
}
pub async fn connection(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Connection>> {
    Ok(Json(owned(&state, auth.user_id, id).await?.dto()?))
}
pub async fn connections(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<Items<Connection>>> {
    let rows:Vec<StoredConnection> = sqlx::query_as(&format!("SELECT {CONNECTION_FIELDS} FROM plugin_connections WHERE user_id=$1 AND status <> 'revoked' ORDER BY created_at DESC LIMIT 100"))
        .bind(auth.user_id).fetch_all(&state.pool).await?;
    Ok(Json(Items {
        items: rows
            .iter()
            .map(StoredConnection::dto)
            .collect::<ApiResult<_>>()?,
    }))
}
pub async fn revoke(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    let mut tx = state.pool.begin().await?;
    let changed=sqlx::query("UPDATE plugin_connections SET status='revoked',auth_status='none',revision=revision+1,auth_challenge=NULL,updated_at=now() WHERE id=$1 AND user_id=$2")
        .bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        return Err(not_found());
    }
    sqlx::query("DELETE FROM plugin_oauth_tokens WHERE connection_id=$1 AND user_id=$2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE plugin_oauth_attempts SET status='failed',error_code='PLUGIN_REVOKED',encrypted_verifier=NULL,updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND status IN ('pending','exchanging')").bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE plugin_invocations SET status='cancelled',error_code='PLUGIN_REVOKED',updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND status='awaiting_confirmation'").bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn refresh(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Connection>> {
    let runtime = runtime(&state)?;
    let connection = owned(&state, auth.user_id, id).await?;
    if connection.status == "revoked" {
        return Err(not_found());
    }
    let current = connection.card()?;
    let latest = discovery::fetch_card(&runtime.http, &current.card_url)
        .await
        .map_err(mcp_error)?;
    if latest.fingerprint != current.fingerprint || latest.endpoint_url != current.endpoint_url {
        mark_changed(&state, &connection, Some(json!(latest)), None).await?;
    } else if connection.status != "needs_review" {
        // Revalidate runtime identity without performing a business tool.
        let bearer = oauth::bearer_for(&state, &connection).await?;
        handle_remote(
            &state,
            &connection,
            runtime
                .client
                .discover(&current.endpoint_url, bearer.as_ref())
                .await,
        )
        .await?;
        sqlx::query("UPDATE plugin_connections SET status='ready',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status <> 'revoked'").bind(id).bind(auth.user_id).bind(connection.revision).execute(&state.pool).await?;
    }
    Ok(Json(owned(&state, auth.user_id, id).await?.dto()?))
}
pub(crate) async fn mark_changed(
    state: &AppState,
    connection: &StoredConnection,
    card: Option<Value>,
    tools: Option<Value>,
) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    let update=sqlx::query("UPDATE plugin_connections SET pending_candidate=COALESCE($4,pending_candidate),pending_tools=COALESCE($5,pending_tools),status='needs_review',revision=revision+1,auth_status=CASE WHEN auth_status='authorized' THEN 'required' ELSE auth_status END,last_error_code='PLUGIN_RECONFIRM_REQUIRED',updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status <> 'revoked'")
        .bind(connection.id).bind(connection.user_id).bind(connection.revision).bind(card).bind(tools).execute(&mut *tx).await?;
    if update.rows_affected() != 1 {
        return Err(changed());
    }
    sqlx::query("DELETE FROM plugin_oauth_tokens WHERE connection_id=$1 AND user_id=$2")
        .bind(connection.id)
        .bind(connection.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE plugin_oauth_attempts SET status='failed',error_code='PLUGIN_RECONFIRM_REQUIRED',encrypted_verifier=NULL,updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND status IN ('pending','exchanging')").bind(connection.id).bind(connection.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevisionRequest {
    revision: i64,
}
pub async fn accept_update(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<RevisionRequest>,
) -> ApiResult<Json<Connection>> {
    let current = owned(&state, auth.user_id, id).await?;
    if current.status != "needs_review" || current.revision != request.revision {
        return Err(changed());
    }
    let schema = current
        .pending_tools
        .as_ref()
        .map(fingerprint)
        .transpose()?;
    let updated=sqlx::query("UPDATE plugin_connections SET candidate=COALESCE(pending_candidate,candidate),tools_snapshot=COALESCE(pending_tools,tools_snapshot),schema_fingerprint=COALESCE($4,schema_fingerprint),pending_candidate=NULL,pending_tools=NULL,status=CASE WHEN auth_status IN ('required','blocked') THEN 'auth_required' ELSE 'ready' END,last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status='needs_review'")
        .bind(id).bind(auth.user_id).bind(request.revision).bind(schema).execute(&state.pool).await?;
    if updated.rows_affected() != 1 {
        return Err(changed());
    }
    Ok(Json(owned(&state, auth.user_id, id).await?.dto()?))
}

pub(crate) async fn record_remote_error(
    state: &AppState,
    connection: &StoredConnection,
    error: &McpError,
) -> ApiResult<()> {
    let auth =
        error.category == ErrorCategory::Authorization || matches!(error.status, Some(401 | 403));
    if auth {
        let configured = runtime(state)?.oauth_configured();
        let status = if configured {
            "auth_required"
        } else {
            "blocked"
        };
        let auth_status = if configured { "required" } else { "blocked" };
        let code = if configured {
            "PLUGIN_AUTH_REQUIRED"
        } else {
            "PLUGIN_OAUTH_NOT_CONFIGURED"
        };
        sqlx::query("UPDATE plugin_connections SET status=$4,auth_status=$5,auth_challenge=COALESCE($6,auth_challenge),last_error_code=$7,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status NOT IN ('revoked','needs_review')")
            .bind(connection.id).bind(connection.user_id).bind(connection.revision).bind(status).bind(auth_status).bind(error.auth_challenge.as_ref().map(|value|json!(value))).bind(code).execute(&state.pool).await?;
    } else {
        sqlx::query("UPDATE plugin_connections SET last_error_code=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3")
            .bind(connection.id).bind(connection.user_id).bind(connection.revision).bind(error.code).execute(&state.pool).await?;
    }
    Ok(())
}
pub(crate) async fn handle_remote<T>(
    state: &AppState,
    connection: &StoredConnection,
    result: Result<T, McpError>,
) -> ApiResult<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            record_remote_error(state, connection, &error).await?;
            Err(mcp_error(error))
        }
    }
}

pub async fn load_tools_for_user(state: &AppState, user: Uuid, id: Uuid) -> ApiResult<Vec<Tool>> {
    let connection = owned(state, user, id).await?;
    connection.usable()?;
    let runtime = runtime(state)?;
    let bearer = oauth::bearer_for(state, &connection).await?;
    let tools = handle_remote(
        state,
        &connection,
        runtime
            .client
            .tools(&connection.card()?.endpoint_url, bearer.as_ref())
            .await,
    )
    .await?;
    let value = json!(tools);
    let signature = fingerprint(&value)?;
    if connection
        .schema_fingerprint
        .as_ref()
        .is_some_and(|prior| prior != &signature)
    {
        mark_changed(state, &connection, None, Some(value)).await?;
        return Err(changed());
    }
    let updated=sqlx::query("UPDATE plugin_connections SET tools_snapshot=$4,schema_fingerprint=$5,status='ready',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND status NOT IN ('revoked','needs_review')")
        .bind(id).bind(user).bind(connection.revision).bind(value).bind(signature).execute(&state.pool).await?;
    if updated.rows_affected() != 1 {
        return Err(changed());
    }
    Ok(tools)
}
pub async fn tools(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Items<Tool>>> {
    Ok(Json(Items {
        items: load_tools_for_user(&state, auth.user_id, id).await?,
    }))
}
async fn authorized(
    state: &AppState,
    user: Uuid,
    id: Uuid,
) -> ApiResult<(StoredConnection, Option<RemoteBearer>)> {
    let connection = owned(state, user, id).await?;
    connection.usable()?;
    let bearer = oauth::bearer_for(state, &connection).await?;
    Ok((connection, bearer))
}
pub async fn resources(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let runtime = runtime(&state)?;
    let (connection, bearer) = authorized(&state, auth.user_id, id).await?;
    let values = handle_remote(
        &state,
        &connection,
        runtime
            .client
            .list_resources(&connection.card()?.endpoint_url, bearer.as_ref())
            .await,
    )
    .await?;
    Ok(Json(json!({"resultType":"complete","resources":values})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRequest {
    uri: String,
}
pub async fn read_resource(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<ResourceRequest>,
) -> ApiResult<Json<Value>> {
    if request.uri.is_empty() || request.uri.len() > 4096 || request.uri.contains('\0') {
        return Err(ApiError::validation("Invalid resource URI."));
    }
    let runtime = runtime(&state)?;
    let (connection, bearer) = authorized(&state, auth.user_id, id).await?;
    // A resource URI is only a parameter to this owner's MCP server, never an HTTP fetch target.
    Ok(Json(
        handle_remote(
            &state,
            &connection,
            runtime
                .client
                .read_resource(
                    &connection.card()?.endpoint_url,
                    &request.uri,
                    bearer.as_ref(),
                )
                .await,
        )
        .await?,
    ))
}
pub async fn prompts(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let runtime = runtime(&state)?;
    let (connection, bearer) = authorized(&state, auth.user_id, id).await?;
    let values = handle_remote(
        &state,
        &connection,
        runtime
            .client
            .list_prompts(&connection.card()?.endpoint_url, bearer.as_ref())
            .await,
    )
    .await?;
    Ok(Json(json!({"resultType":"complete","prompts":values})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptRequest {
    name: String,
    #[serde(default = "empty_arguments")]
    arguments: Value,
}
fn empty_arguments() -> Value {
    json!({})
}
pub async fn get_prompt(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
    ApiJson(request): ApiJson<PromptRequest>,
) -> ApiResult<Json<Value>> {
    if request.name.is_empty()
        || request.name.len() > 256
        || serde_json::to_vec(&request.arguments)
            .map_err(|_| ApiError::internal())?
            .len()
            > 64 * 1024
    {
        return Err(ApiError::validation("Invalid prompt parameters."));
    }
    let runtime = runtime(&state)?;
    let (connection, bearer) = authorized(&state, auth.user_id, id).await?;
    Ok(Json(
        handle_remote(
            &state,
            &connection,
            runtime
                .client
                .get_prompt(
                    &connection.card()?.endpoint_url,
                    &request.name,
                    &request.arguments,
                    bearer.as_ref(),
                )
                .await,
        )
        .await?,
    ))
}
