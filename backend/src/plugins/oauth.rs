//! OAuth credentials are confined to one owner, connection, revision and resource.
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{Html, IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rand::{RngCore, rngs::OsRng};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use uuid::Uuid;

use super::{
    PluginRuntime, auth_binding, auth_required, changed, hash, mcp_error, not_found,
    oauth_unconfigured, runtime,
    store::{self, StoredConnection},
    types::{AuthChallenge, RemoteBearer},
};
use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
};

const CALLBACK_PATH: &str = "/v1/plugins/oauth/callback";
const CLIENT_PATH: &str = "/oauth/client-metadata.json";

#[derive(Serialize)]
pub struct StartResult {
    pub attempt_id: Uuid,
    pub authorization_url: String,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize, FromRow)]
pub struct AttemptResult {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub status: String,
    pub error_code: Option<String>,
    pub expires_at: DateTime<Utc>,
}

fn invalid_metadata() -> ApiError {
    ApiError::conflict(
        "PLUGIN_OAUTH_METADATA_INVALID",
        "The plugin authorization metadata is invalid or unsupported.",
    )
}
fn exchange_failed() -> ApiError {
    ApiError::conflict(
        "PLUGIN_OAUTH_EXCHANGE_FAILED",
        "Plugin authorization could not be completed. Start a new authorization attempt.",
    )
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn public_urls(runtime: &PluginRuntime) -> ApiResult<(String, String)> {
    if !runtime.oauth_configured() {
        return Err(oauth_unconfigured());
    }
    let base = runtime
        .public_base
        .as_ref()
        .ok_or_else(oauth_unconfigured)?;
    Ok((
        format!("{base}{CLIENT_PATH}"),
        format!("{base}{CALLBACK_PATH}"),
    ))
}

pub async fn client_metadata(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let runtime = runtime(&state)?;
    let (client_id, redirect_uri) = public_urls(&runtime)?;
    Ok(Json(
        json!({"client_id":client_id,"client_name":"Q","redirect_uris":[redirect_uri],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}),
    ))
}

pub async fn complete() -> Response {
    let mut response = Html("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Q authorization</title><body><main><h1>Return to Q</h1><p>The authorization response has been processed. Return to Q to see its status.</p></main></body></html>").into_response();
    secure_headers(response.headers_mut());
    response
}

fn secure_headers(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

struct AuthorizationMetadata {
    issuer: String,
    resource: String,
    authorization_endpoint: String,
    token_endpoint: String,
    scopes: Vec<String>,
    require_response_iss: bool,
}

fn scopes(value: &str) -> ApiResult<Vec<String>> {
    if value.len() > 2048
        || !value
            .bytes()
            .all(|b| b == b' ' || (b.is_ascii_graphic() && b != b'"' && b != b'\\'))
    {
        return Err(invalid_metadata());
    }
    let mut values: Vec<String> = value
        .split(' ')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    values.sort();
    values.dedup();
    if values.len() > 64 {
        return Err(invalid_metadata());
    }
    Ok(values)
}
fn string_array(value: Option<&Value>) -> ApiResult<Vec<String>> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(values)) if values.len() <= 64 => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 8192)
                    .map(str::to_owned)
                    .ok_or_else(invalid_metadata)
            })
            .collect(),
        _ => Err(invalid_metadata()),
    }
}
fn contains(value: &Value, field: &str, expected: &str) -> ApiResult<bool> {
    Ok(string_array(value.get(field))?
        .iter()
        .any(|s| s == expected))
}

fn well_known(issuer: &Url, suffix: &str) -> String {
    let path = issuer.path().trim_end_matches('/');
    format!(
        "{}/.well-known/{suffix}{path}",
        issuer.origin().ascii_serialization()
    )
}

async fn metadata_at(runtime: &PluginRuntime, urls: &[String]) -> ApiResult<Value> {
    for url in urls {
        let response = runtime.http.get(url).await.map_err(mcp_error)?;
        if matches!(response.status, 404 | 405) {
            continue;
        }
        if response.status != 200 || response.media_type() != "application/json" {
            return Err(invalid_metadata());
        }
        let value = response.json().map_err(|_| invalid_metadata())?;
        if !value.is_object() {
            return Err(invalid_metadata());
        }
        return Ok(value);
    }
    Err(invalid_metadata())
}

async fn discover_metadata(
    runtime: &PluginRuntime,
    connection: &StoredConnection,
) -> ApiResult<AuthorizationMetadata> {
    let card = connection.card()?;
    let endpoint = runtime
        .http
        .canonical_url(&card.endpoint_url)
        .map_err(mcp_error)?;
    let endpoint_url = Url::parse(&endpoint).map_err(|_| invalid_metadata())?;
    let challenge: Option<AuthChallenge> = connection
        .auth_challenge
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid_metadata())?;
    let metadata_urls =
        if let Some(url) = challenge.as_ref().and_then(|c| c.resource_metadata.clone()) {
            vec![runtime.http.canonical_url(&url).map_err(mcp_error)?]
        } else {
            let specific = well_known(&endpoint_url, "oauth-protected-resource");
            let root = format!(
                "{}/.well-known/oauth-protected-resource",
                endpoint_url.origin().ascii_serialization()
            );
            if specific == root {
                vec![root]
            } else {
                vec![specific, root]
            }
        };
    let resource_metadata = metadata_at(runtime, &metadata_urls).await?;
    let resource = resource_metadata
        .get("resource")
        .and_then(Value::as_str)
        .ok_or_else(invalid_metadata)?;
    // Q's current connection model authorizes exactly one MCP endpoint, never sibling paths.
    if runtime.http.canonical_url(resource).map_err(mcp_error)? != endpoint {
        return Err(invalid_metadata());
    }
    let issuers = string_array(resource_metadata.get("authorization_servers"))?;
    let issuer = issuers.first().ok_or_else(invalid_metadata)?.clone();
    runtime.http.canonical_url(&issuer).map_err(mcp_error)?;
    let issuer_url = Url::parse(&issuer).map_err(|_| invalid_metadata())?;
    if issuer_url.query().is_some() {
        return Err(invalid_metadata());
    }
    let mut urls = vec![
        well_known(&issuer_url, "oauth-authorization-server"),
        well_known(&issuer_url, "openid-configuration"),
    ];
    if issuer_url.path() != "/" {
        urls.push(format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ));
    }
    let metadata = metadata_at(runtime, &urls).await?;
    // OAuth issuer comparison is deliberately an exact string comparison, not URL normalization.
    if metadata.get("issuer").and_then(Value::as_str) != Some(issuer.as_str())
        || metadata
            .get("client_id_metadata_document_supported")
            .and_then(Value::as_bool)
            != Some(true)
        || !contains(&metadata, "code_challenge_methods_supported", "S256")?
        || !contains(&metadata, "response_types_supported", "code")?
        || (metadata.get("grant_types_supported").is_some()
            && !contains(&metadata, "grant_types_supported", "authorization_code")?)
        || (metadata
            .get("token_endpoint_auth_methods_supported")
            .is_some()
            && !contains(&metadata, "token_endpoint_auth_methods_supported", "none")?)
    {
        return Err(invalid_metadata());
    }
    let authorization_endpoint = runtime
        .http
        .canonical_url(
            metadata
                .get("authorization_endpoint")
                .and_then(Value::as_str)
                .ok_or_else(invalid_metadata)?,
        )
        .map_err(mcp_error)?;
    let token_endpoint = runtime
        .http
        .canonical_url(
            metadata
                .get("token_endpoint")
                .and_then(Value::as_str)
                .ok_or_else(invalid_metadata)?,
        )
        .map_err(mcp_error)?;
    runtime
        .http
        .validate_destination(&authorization_endpoint)
        .await
        .map_err(mcp_error)?;
    runtime
        .http
        .validate_destination(&token_endpoint)
        .await
        .map_err(mcp_error)?;
    let mut requested = if let Some(scope) = challenge.as_ref().and_then(|c| c.scope.as_deref()) {
        scopes(scope)?
    } else {
        let values = string_array(resource_metadata.get("scopes_supported"))?;
        if values.iter().any(|s| s.contains(' ')) {
            return Err(invalid_metadata());
        }
        scopes(&values.join(" "))?
    };
    requested.extend(connection.requested_scopes.clone());
    let requested = scopes(&requested.join(" "))?;
    let require_response_iss = match metadata.get("authorization_response_iss_parameter_supported")
    {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err(invalid_metadata()),
    };
    Ok(AuthorizationMetadata {
        issuer,
        resource: resource.to_owned(),
        authorization_endpoint,
        token_endpoint,
        scopes: requested,
        require_response_iss,
    })
}

pub async fn start(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<StartResult>> {
    state.limit_auth(format!("plugin-oauth:{}", auth.user_id), 10)?;
    let runtime = runtime(&state)?;
    let (client_id, redirect_uri) = public_urls(&runtime)?;
    let connection = store::owned(&state, auth.user_id, id).await?;
    connection.usable()?;
    let metadata = discover_metadata(&runtime, &connection).await?;
    let state_secret = random_secret();
    let verifier = random_secret();
    let attempt_id = Uuid::new_v4();
    let encrypted_verifier = runtime.seal(
        auth.user_id,
        id,
        &format!("verifier:{attempt_id}"),
        &json!({"verifier":verifier}),
    )?;
    let expires_at = Utc::now() + Duration::minutes(10);
    let mut authorization_url =
        Url::parse(&metadata.authorization_endpoint).map_err(|_| invalid_metadata())?;
    let reserved = [
        "response_type",
        "client_id",
        "redirect_uri",
        "state",
        "code_challenge",
        "code_challenge_method",
        "resource",
        "scope",
        "response_mode",
    ];
    if authorization_url
        .query_pairs()
        .any(|(key, _)| reserved.contains(&key.as_ref()))
    {
        return Err(invalid_metadata());
    }
    authorization_url.query_pairs_mut().extend_pairs([
        ("response_type", "code"),
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("state", state_secret.as_str()),
        (
            "code_challenge",
            URL_SAFE_NO_PAD.encode(hash(verifier.as_bytes())).as_str(),
        ),
        ("code_challenge_method", "S256"),
        ("resource", metadata.resource.as_str()),
    ]);
    if !metadata.scopes.is_empty() {
        authorization_url
            .query_pairs_mut()
            .append_pair("scope", &metadata.scopes.join(" "));
    }
    let mut tx = state.pool.begin().await?;
    let current: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision,status FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if !current.is_some_and(|(revision, status)| {
        revision == connection.revision && !matches!(status.as_str(), "revoked" | "needs_review")
    }) {
        return Err(changed());
    }
    // The connection row lock serializes retention checks without adding a second lock order.
    // Expired random states cannot be reused and have no business idempotency significance.
    sqlx::query("DELETE FROM plugin_oauth_attempts WHERE connection_id=$1 AND user_id=$2 AND expires_at<=now()")
        .bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    let retained_attempts: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_oauth_attempts WHERE connection_id=$1 AND user_id=$2 AND expires_at>now()")
        .bind(id).bind(auth.user_id).fetch_one(&mut *tx).await?;
    if retained_attempts >= 20 {
        tx.commit().await?;
        return Err(ApiError::conflict(
            "PLUGIN_OAUTH_ATTEMPT_LIMIT",
            "Too many recent authorization attempts for this plugin. Wait for them to expire before starting again.",
        ));
    }
    // Explicit authorization can select a different provider account, even at the same issuer.
    // Invalidate old proposals and result reuse before new credentials become available.
    let authorization_revision: i64 = sqlx::query_scalar("UPDATE plugin_connections SET revision=revision+1,status='auth_required',auth_status='required',requested_scopes=$3,last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING revision")
        .bind(id).bind(auth.user_id).bind(&metadata.scopes).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE plugin_invocations SET status='cancelled',error_code='PLUGIN_AUTH_CHANGED',updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND connection_revision<$3 AND status='awaiting_confirmation'")
        .bind(id).bind(auth.user_id).bind(authorization_revision).execute(&mut *tx).await?;
    // Only the newest explicit authorization attempt may publish credentials.
    sqlx::query("UPDATE plugin_oauth_attempts SET status='failed',error_code='PLUGIN_OAUTH_SUPERSEDED',encrypted_verifier=NULL,updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND status IN ('pending','exchanging')")
        .bind(id).bind(auth.user_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM plugin_oauth_tokens WHERE connection_id=$1 AND user_id=$2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO plugin_oauth_attempts(id,user_id,connection_id,connection_revision,state_hash,encrypted_verifier,issuer,resource,token_endpoint,client_id,redirect_uri,scopes,require_response_iss,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)")
        .bind(attempt_id).bind(auth.user_id).bind(id).bind(authorization_revision).bind(hash(state_secret.as_bytes())).bind(encrypted_verifier)
        .bind(&metadata.issuer).bind(&metadata.resource).bind(&metadata.token_endpoint).bind(client_id).bind(redirect_uri).bind(&metadata.scopes).bind(metadata.require_response_iss).bind(expires_at).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(StartResult {
        attempt_id,
        authorization_url: authorization_url.to_string(),
        expires_at,
    }))
}

pub async fn attempt(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<AttemptResult>> {
    sqlx::query("UPDATE plugin_oauth_attempts SET status='expired',error_code='PLUGIN_OAUTH_EXPIRED',encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('pending','exchanging') AND expires_at<=now()")
        .bind(id).bind(auth.user_id).execute(&state.pool).await?;
    let value = sqlx::query_as("SELECT id,connection_id,status,error_code,expires_at FROM plugin_oauth_attempts WHERE id=$1 AND user_id=$2")
        .bind(id).bind(auth.user_id).fetch_optional(&state.pool).await?.ok_or_else(not_found)?;
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct CallbackParams {
    state: Option<String>,
    code: Option<String>,
    iss: Option<String>,
    error: Option<String>,
}
#[derive(FromRow)]
struct SavedAttempt {
    id: Uuid,
    user_id: Uuid,
    connection_id: Uuid,
    connection_revision: i64,
    encrypted_verifier: Option<Vec<u8>>,
    issuer: String,
    resource: String,
    token_endpoint: String,
    client_id: String,
    redirect_uri: String,
    scopes: Vec<String>,
    require_response_iss: bool,
}

pub async fn callback(
    State(state): State<AppState>,
    query: Result<Query<CallbackParams>, axum::extract::rejection::QueryRejection>,
) -> Response {
    if let Ok(Query(query)) = query {
        // Never reflect provider errors, authorization codes or state into a page or redirect.
        let _ = finish_callback(&state, query).await;
    }
    let mut response = Redirect::to("/oauth/complete").into_response();
    secure_headers(response.headers_mut());
    response
}

async fn fail_attempt(state: &AppState, id: Uuid, code: &'static str) -> ApiResult<()> {
    sqlx::query("UPDATE plugin_oauth_attempts SET status='failed',error_code=$2,encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND status IN ('pending','exchanging')")
        .bind(id).bind(code).execute(&state.pool).await?;
    Ok(())
}

async fn finish_callback(state: &AppState, query: CallbackParams) -> ApiResult<()> {
    let runtime = runtime(state)?;
    let (client_id, redirect_uri) = public_urls(&runtime)?;
    let state_value = query
        .state
        .as_deref()
        .filter(|s| {
            s.len() == 43
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or_else(exchange_failed)?;
    let saved: SavedAttempt = sqlx::query_as("SELECT id,user_id,connection_id,connection_revision,encrypted_verifier,issuer,resource,token_endpoint,client_id,redirect_uri,scopes,require_response_iss FROM plugin_oauth_attempts WHERE state_hash=$1")
        .bind(hash(state_value.as_bytes())).fetch_optional(&state.pool).await?.ok_or_else(exchange_failed)?;
    let mut tx = state.pool.begin().await?;
    let current: Option<(i64, String, Value)> = sqlx::query_as("SELECT revision,status,candidate FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE")
        .bind(saved.connection_id).bind(saved.user_id).fetch_optional(&mut *tx).await?;
    let valid_connection = current
        .as_ref()
        .is_some_and(|(revision, status, candidate)| {
            *revision == saved.connection_revision
                && !matches!(status.as_str(), "revoked" | "needs_review")
                && candidate
                    .get("endpoint_url")
                    .and_then(Value::as_str)
                    .is_some_and(|endpoint| {
                        runtime.http.canonical_url(&saved.resource).ok().as_deref()
                            == Some(endpoint)
                    })
        });
    if !valid_connection {
        sqlx::query("UPDATE plugin_oauth_attempts SET status='failed',error_code='PLUGIN_RECONFIRM_REQUIRED',encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND status IN ('pending','exchanging')").bind(saved.id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Err(changed());
    }
    let claim = sqlx::query("UPDATE plugin_oauth_attempts SET status='exchanging',encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND status='pending' AND expires_at>now()")
        .bind(saved.id).execute(&mut *tx).await?;
    if claim.rows_affected() != 1 {
        sqlx::query("UPDATE plugin_oauth_attempts SET status='expired',error_code='PLUGIN_OAUTH_EXPIRED',encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND status='pending' AND expires_at<=now()")
            .bind(saved.id).execute(&mut *tx).await?;
        tx.commit().await?;
        return Err(exchange_failed());
    }
    tx.commit().await?;
    let result = exchange_code(&runtime, &saved, &query, &client_id, &redirect_uri).await;
    let tokens = match result {
        Ok(tokens) => tokens,
        Err(error) => {
            fail_attempt(state, saved.id, error.code).await?;
            return Err(error);
        }
    };
    let encrypted = runtime.seal(
        saved.user_id,
        saved.connection_id,
        &token_purpose(saved.connection_revision, &saved.issuer, &saved.resource),
        &tokens.secret,
    )?;
    let mut tx = state.pool.begin().await?;
    let current: Option<(i64, String)> = sqlx::query_as(
        "SELECT revision,status FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(saved.connection_id)
    .bind(saved.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if !current.is_some_and(|(revision, status)| {
        revision == saved.connection_revision
            && !matches!(status.as_str(), "revoked" | "needs_review")
    }) {
        tx.rollback().await?;
        fail_attempt(state, saved.id, "PLUGIN_RECONFIRM_REQUIRED").await?;
        return Err(changed());
    }
    let updated = sqlx::query("UPDATE plugin_oauth_attempts SET status='succeeded',error_code=NULL,encrypted_verifier=NULL,updated_at=now() WHERE id=$1 AND status='exchanging' AND expires_at>now()")
        .bind(saved.id).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(exchange_failed());
    }
    sqlx::query("INSERT INTO plugin_oauth_tokens(connection_id,user_id,connection_revision,issuer,resource,token_endpoint,client_id,encrypted_tokens,scopes,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(connection_id) DO UPDATE SET user_id=EXCLUDED.user_id,connection_revision=EXCLUDED.connection_revision,issuer=EXCLUDED.issuer,resource=EXCLUDED.resource,token_endpoint=EXCLUDED.token_endpoint,client_id=EXCLUDED.client_id,encrypted_tokens=EXCLUDED.encrypted_tokens,scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,refresh_state='ready',refresh_deadline=NULL,updated_at=now()")
        .bind(saved.connection_id).bind(saved.user_id).bind(saved.connection_revision).bind(&saved.issuer).bind(&saved.resource).bind(&saved.token_endpoint).bind(&saved.client_id).bind(encrypted).bind(&tokens.scopes).bind(tokens.expires_at).execute(&mut *tx).await?;
    sqlx::query("UPDATE plugin_connections SET auth_status='authorized',status='ready',last_error_code=NULL,updated_at=now() WHERE id=$1 AND user_id=$2")
        .bind(saved.connection_id).bind(saved.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

struct TokenResponse {
    secret: Value,
    scopes: Vec<String>,
    expires_at: DateTime<Utc>,
}
fn token_purpose(revision: i64, issuer: &str, resource: &str) -> String {
    format!("tokens:{revision}:{}", auth_binding(issuer, resource))
}
fn secret_string(value: Option<&Value>) -> ApiResult<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192 && s.bytes().all(|b| b.is_ascii_graphic()))
        .map(str::to_owned)
        .ok_or_else(exchange_failed)
}
fn parse_token(
    value: Value,
    requested: &[String],
    old_refresh: Option<&str>,
) -> ApiResult<TokenResponse> {
    if !value
        .get("token_type")
        .and_then(Value::as_str)
        .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
        || value.get("error").is_some()
    {
        return Err(exchange_failed());
    }
    let access_token = secret_string(value.get("access_token"))?;
    let refresh_token = match value.get("refresh_token") {
        Some(value) => Some(secret_string(Some(value))?),
        None => old_refresh.map(str::to_owned),
    };
    let granted = match value.get("scope") {
        Some(Value::String(value)) => scopes(value).map_err(|_| exchange_failed())?,
        None => requested.to_vec(),
        _ => return Err(exchange_failed()),
    };
    if granted.iter().any(|scope| !requested.contains(scope)) {
        return Err(exchange_failed());
    }
    // A missing lifetime is treated conservatively; a token is never cached indefinitely.
    let lifetime = match value.get("expires_in") {
        None => 300,
        Some(value) => value
            .as_i64()
            .filter(|s| (1..=31_536_000).contains(s))
            .ok_or_else(exchange_failed)?,
    };
    Ok(TokenResponse {
        secret: json!({"access_token":access_token,"refresh_token":refresh_token}),
        scopes: granted,
        expires_at: Utc::now() + Duration::seconds(lifetime),
    })
}

async fn exchange_code(
    runtime: &PluginRuntime,
    saved: &SavedAttempt,
    query: &CallbackParams,
    client_id: &str,
    redirect_uri: &str,
) -> ApiResult<TokenResponse> {
    if saved.client_id != client_id
        || saved.redirect_uri != redirect_uri
        || query
            .iss
            .as_ref()
            .is_some_and(|issuer| issuer != &saved.issuer)
        || (saved.require_response_iss && query.iss.is_none())
    {
        return Err(ApiError::conflict(
            "PLUGIN_OAUTH_ISSUER_MISMATCH",
            "The authorization response does not match this attempt.",
        ));
    }
    if query.error.is_some() {
        return Err(ApiError::conflict(
            "PLUGIN_OAUTH_DENIED",
            "The plugin authorization was not granted.",
        ));
    }
    let code = query
        .code
        .as_deref()
        .filter(|s| !s.is_empty() && s.len() <= 8192 && s.bytes().all(|b| b.is_ascii_graphic()))
        .ok_or_else(exchange_failed)?;
    let verifier = runtime.open(
        saved.user_id,
        saved.connection_id,
        &format!("verifier:{}", saved.id),
        saved
            .encrypted_verifier
            .as_deref()
            .ok_or_else(exchange_failed)?,
    )?;
    let verifier = secret_string(verifier.get("verifier"))?;
    let form = vec![
        ("grant_type".into(), "authorization_code".into()),
        ("code".into(), code.into()),
        ("client_id".into(), saved.client_id.clone()),
        ("redirect_uri".into(), saved.redirect_uri.clone()),
        ("code_verifier".into(), verifier),
        ("resource".into(), saved.resource.clone()),
    ];
    let response = runtime
        .http
        .post_form(&saved.token_endpoint, &form, HeaderMap::new())
        .await
        .map_err(|_| exchange_failed())?;
    if response.status != 200 || response.media_type() != "application/json" {
        return Err(exchange_failed());
    }
    parse_token(
        response.json().map_err(|_| exchange_failed())?,
        &saved.scopes,
        None,
    )
}

#[derive(FromRow)]
struct SavedToken {
    connection_revision: i64,
    issuer: String,
    resource: String,
    token_endpoint: String,
    client_id: String,
    encrypted_tokens: Vec<u8>,
    scopes: Vec<String>,
    expires_at: DateTime<Utc>,
    refresh_state: String,
    refresh_deadline: Option<DateTime<Utc>>,
}

/// Returns only a token issued for this connection's own endpoint; Q credentials never enter here.
pub(crate) async fn bearer_for(
    state: &AppState,
    connection: &StoredConnection,
) -> ApiResult<Option<RemoteBearer>> {
    connection.usable()?;
    if connection.auth_status == "none" {
        return Ok(None);
    }
    if connection.auth_status != "authorized" {
        return Err(auth_required());
    }
    let runtime = runtime(state)?;
    let (client_id, _) = public_urls(&runtime)?;
    let endpoint = connection.card()?.endpoint_url;
    let mut tx = state.pool.begin().await?;
    let current: Option<(i64, String, String)> = sqlx::query_as("SELECT revision,status,auth_status FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE")
        .bind(connection.id).bind(connection.user_id).fetch_optional(&mut *tx).await?;
    if !current.is_some_and(|(revision, status, auth)| {
        revision == connection.revision
            && auth == "authorized"
            && !matches!(status.as_str(), "revoked" | "needs_review")
    }) {
        return Err(auth_required());
    }
    let saved: SavedToken = sqlx::query_as("SELECT connection_revision,issuer,resource,token_endpoint,client_id,encrypted_tokens,scopes,expires_at,refresh_state,refresh_deadline FROM plugin_oauth_tokens WHERE connection_id=$1 AND user_id=$2 FOR UPDATE")
        .bind(connection.id).bind(connection.user_id).fetch_optional(&mut *tx).await?.ok_or_else(auth_required)?;
    if saved.connection_revision != connection.revision
        || saved.client_id != client_id
        || runtime
            .http
            .canonical_url(&saved.resource)
            .map_err(mcp_error)?
            != endpoint
    {
        return Err(auth_required());
    }
    let secret = runtime.open(
        connection.user_id,
        connection.id,
        &token_purpose(connection.revision, &saved.issuer, &saved.resource),
        &saved.encrypted_tokens,
    )?;
    let now = Utc::now();
    if saved.refresh_state == "refreshing" {
        let stale = saved
            .refresh_deadline
            .is_none_or(|deadline| deadline <= now);
        tx.commit().await?;
        if stale {
            invalidate_tokens(state, connection, &saved.encrypted_tokens).await?;
            return Err(auth_required());
        }
        return Err(ApiError::conflict(
            "PLUGIN_OAUTH_REFRESH_IN_PROGRESS",
            "Plugin authorization is being refreshed. Try again shortly.",
        ));
    }
    if saved.expires_at > now + Duration::seconds(30) {
        let bearer = RemoteBearer::new(secret_string(secret.get("access_token"))?, &endpoint)
            .map_err(mcp_error)?;
        tx.commit().await?;
        return Ok(Some(bearer));
    }
    let refresh_token = match secret
        .get("refresh_token")
        .filter(|value| !value.is_null())
        .map(|value| secret_string(Some(value)))
        .transpose()?
    {
        Some(token) => token,
        None => {
            tx.commit().await?;
            invalidate_tokens(state, connection, &saved.encrypted_tokens).await?;
            return Err(auth_required());
        }
    };
    let deadline = now + Duration::seconds(60);
    sqlx::query("UPDATE plugin_oauth_tokens SET refresh_state='refreshing',refresh_deadline=$3,updated_at=now() WHERE connection_id=$1 AND user_id=$2")
        .bind(connection.id).bind(connection.user_id).bind(deadline).execute(&mut *tx).await?;
    tx.commit().await?;
    // Claim first and never retry a refresh with an unknown result: rotation may have consumed it.
    let result = refresh_token_request(&runtime, &saved, &refresh_token).await;
    let tokens = match result {
        Ok(tokens) => tokens,
        Err(error) => {
            invalidate_tokens(state, connection, &saved.encrypted_tokens).await?;
            return Err(error);
        }
    };
    let encrypted = runtime.seal(
        connection.user_id,
        connection.id,
        &token_purpose(connection.revision, &saved.issuer, &saved.resource),
        &tokens.secret,
    )?;
    let mut tx = state.pool.begin().await?;
    let current: Option<(i64, String, String)> = sqlx::query_as("SELECT revision,status,auth_status FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE")
        .bind(connection.id).bind(connection.user_id).fetch_optional(&mut *tx).await?;
    if !current.is_some_and(|(revision, status, auth)| {
        revision == connection.revision
            && auth == "authorized"
            && !matches!(status.as_str(), "revoked" | "needs_review")
    }) {
        return Err(auth_required());
    }
    let updated = sqlx::query("UPDATE plugin_oauth_tokens SET encrypted_tokens=$4,scopes=$5,expires_at=$6,refresh_state='ready',refresh_deadline=NULL,updated_at=now() WHERE connection_id=$1 AND user_id=$2 AND connection_revision=$3 AND encrypted_tokens=$7 AND refresh_state='refreshing' AND refresh_deadline=$8 AND refresh_deadline>now()")
        .bind(connection.id).bind(connection.user_id).bind(connection.revision).bind(encrypted).bind(tokens.scopes).bind(tokens.expires_at).bind(&saved.encrypted_tokens).bind(deadline).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(auth_required());
    }
    tx.commit().await?;
    Ok(Some(
        RemoteBearer::new(secret_string(tokens.secret.get("access_token"))?, &endpoint)
            .map_err(mcp_error)?,
    ))
}

async fn refresh_token_request(
    runtime: &PluginRuntime,
    saved: &SavedToken,
    refresh_token: &str,
) -> ApiResult<TokenResponse> {
    let mut form = vec![
        ("grant_type".into(), "refresh_token".into()),
        ("refresh_token".into(), refresh_token.into()),
        ("client_id".into(), saved.client_id.clone()),
        ("resource".into(), saved.resource.clone()),
    ];
    if !saved.scopes.is_empty() {
        form.push(("scope".into(), saved.scopes.join(" ")));
    }
    let response = runtime
        .http
        .post_form(&saved.token_endpoint, &form, HeaderMap::new())
        .await
        .map_err(|_| exchange_failed())?;
    if response.status != 200 || response.media_type() != "application/json" {
        return Err(exchange_failed());
    }
    parse_token(
        response.json().map_err(|_| exchange_failed())?,
        &saved.scopes,
        Some(refresh_token),
    )
}

async fn invalidate_tokens(
    state: &AppState,
    connection: &StoredConnection,
    ciphertext: &[u8],
) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    // Match the exact claimed token so a late failed refresh cannot erase a newer authorization.
    let current: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM plugin_connections WHERE id=$1 AND user_id=$2 FOR UPDATE",
    )
    .bind(connection.id)
    .bind(connection.user_id)
    .fetch_optional(&mut *tx)
    .await?;
    if current == Some(connection.revision) {
        let deleted = sqlx::query("DELETE FROM plugin_oauth_tokens WHERE connection_id=$1 AND user_id=$2 AND connection_revision=$3 AND encrypted_tokens=$4")
            .bind(connection.id).bind(connection.user_id).bind(connection.revision).bind(ciphertext).execute(&mut *tx).await?;
        if deleted.rows_affected() == 1 {
            sqlx::query("UPDATE plugin_connections SET auth_status='required',status='auth_required',last_error_code='PLUGIN_AUTH_REQUIRED',updated_at=now() WHERE id=$1 AND user_id=$2 AND status NOT IN ('revoked','needs_review')")
                .bind(connection.id).bind(connection.user_id).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{network::SafeHttp, protocol::McpClient};

    fn fixture_runtime(origin: &str) -> PluginRuntime {
        let http = SafeHttp::test_fixture(Url::parse(origin).expect("fixture URL"))
            .expect("fixture network");
        PluginRuntime {
            client: McpClient::new(http.clone()),
            http,
            key: Some([13; 32]),
            public_base: Some("https://q.example".into()),
        }
    }

    #[test]
    fn token_response_rejects_expansion_invalid_secrets_and_unbounded_lifetimes() {
        let requested = vec!["files:read".to_owned()];
        for value in [
            json!({"access_token":"fixture-only","token_type":"Bearer","scope":"files:write"}),
            json!({"access_token":"fixture\r\ninjection","token_type":"Bearer"}),
            json!({"access_token":"fixture-only","token_type":"Basic"}),
            json!({"access_token":"fixture-only","token_type":"Bearer","expires_in":0}),
            json!({"access_token":"fixture-only","token_type":"Bearer","expires_in":i64::MAX}),
            json!({"access_token":"fixture-only","token_type":"Bearer","scope":["files:read"]}),
        ] {
            assert!(parse_token(value, &requested, None).is_err());
        }
        let response = parse_token(json!({"access_token":"fixture-only","token_type":"bearer","scope":"files:read","expires_in":60}), &requested, Some("old-refresh-fixture")).expect("valid response");
        assert_eq!(response.secret["refresh_token"], "old-refresh-fixture");
        assert_eq!(response.scopes, requested);
        assert!(response.expires_at > Utc::now());
        let rotated = parse_token(json!({"access_token":"fixture-only","refresh_token":"rotated-fixture","token_type":"Bearer"}), &requested, Some("old-refresh-fixture")).expect("rotated token");
        assert_eq!(rotated.secret["refresh_token"], "rotated-fixture");
        assert!(rotated.expires_at <= Utc::now() + Duration::seconds(300));
    }

    #[test]
    fn token_ciphertext_cannot_cross_owner_connection_revision_or_resource() {
        let runtime = fixture_runtime("http://127.0.0.1:12345/");
        let owner = Uuid::new_v4();
        let connection = Uuid::new_v4();
        let purpose = token_purpose(1, "https://issuer.example", "https://plugin.example/mcp");
        let secret = json!({"access_token":"unit-test-token"});
        let encrypted = runtime
            .seal(owner, connection, &purpose, &secret)
            .expect("seal");
        assert_eq!(
            runtime
                .open(owner, connection, &purpose, &encrypted)
                .expect("open"),
            secret
        );
        assert!(
            runtime
                .open(Uuid::new_v4(), connection, &purpose, &encrypted)
                .is_err()
        );
        assert!(
            runtime
                .open(owner, Uuid::new_v4(), &purpose, &encrypted)
                .is_err()
        );
        assert!(
            runtime
                .open(
                    owner,
                    connection,
                    &token_purpose(2, "https://issuer.example", "https://plugin.example/mcp"),
                    &encrypted
                )
                .is_err()
        );
        assert!(
            runtime
                .open(
                    owner,
                    connection,
                    &token_purpose(1, "https://other.example", "https://plugin.example/mcp"),
                    &encrypted
                )
                .is_err()
        );
        assert!(
            runtime
                .open(
                    owner,
                    connection,
                    &token_purpose(1, "https://issuer.example", "https://plugin.example/other"),
                    &encrypted
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn issuer_validation_precedes_code_exchange_and_provider_errors() {
        let runtime = fixture_runtime("http://127.0.0.1:12345/");
        let (client_id, redirect_uri) = public_urls(&runtime).expect("urls");
        let saved = SavedAttempt {
            id: Uuid::new_v4(),
            user_id: Uuid::new_v4(),
            connection_id: Uuid::new_v4(),
            connection_revision: 1,
            encrypted_verifier: None,
            issuer: "https://issuer.example".into(),
            resource: "https://plugin.example/mcp".into(),
            token_endpoint: "http://127.0.0.1:12345/token".into(),
            client_id: client_id.clone(),
            redirect_uri: redirect_uri.clone(),
            scopes: vec![],
            require_response_iss: true,
        };
        for iss in [
            None,
            Some("https://ISSUER.example".into()),
            Some("https://issuer.example/".into()),
            Some("https://other.example".into()),
        ] {
            let query = CallbackParams {
                state: None,
                code: Some("fixture-code".into()),
                iss,
                error: Some("remote-error-text".into()),
            };
            let error = exchange_code(&runtime, &saved, &query, &client_id, &redirect_uri)
                .await
                .err()
                .expect("issuer rejection");
            assert_eq!(error.code, "PLUGIN_OAUTH_ISSUER_MISMATCH");
        }
        let query = CallbackParams {
            state: None,
            code: None,
            iss: Some(saved.issuer.clone()),
            error: Some("untrusted-provider-error".into()),
        };
        let error = exchange_code(&runtime, &saved, &query, &client_id, &redirect_uri)
            .await
            .err()
            .expect("denial");
        assert_eq!(error.code, "PLUGIN_OAUTH_DENIED");
        assert!(!error.message.contains("untrusted"));
    }

    #[test]
    fn discovery_paths_keep_tenant_and_scope_validation_is_bounded() {
        assert_eq!(
            well_known(
                &Url::parse("https://as.example/tenant/path").unwrap(),
                "oauth-authorization-server"
            ),
            "https://as.example/.well-known/oauth-authorization-server/tenant/path"
        );
        assert_eq!(
            well_known(
                &Url::parse("https://as.example/").unwrap(),
                "openid-configuration"
            ),
            "https://as.example/.well-known/openid-configuration"
        );
        assert_eq!(scopes("read write read").unwrap(), vec!["read", "write"]);
        assert!(scopes("read\nwrite").is_err());
        assert!(scopes("read\\write").is_err());
        assert!(scopes(&"s".repeat(2049)).is_err());
    }
}
