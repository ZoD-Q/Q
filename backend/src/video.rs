//! Opt-in Kling legacy text-to-video adapter. Supplier secrets never leave this module.
//! A durable reservation precedes each submission; its idempotency key never submits twice.
use std::{env, net::IpAddr, sync::Arc, time::Duration};

use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use rand::{RngCore, rngs::OsRng};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::{self, ApiJson},
};

const MAX_PROVIDER_RESPONSE: usize = 256 * 1024;
const CONNECTION_FIELDS: &str = "id,name,provider,region,created_at,revoked";
const JOB_FIELDS: &str = "id,connection_id,prompt,model_name,mode,duration,aspect_ratio,status,provider_task_id,video_url,error_code,created_at,updated_at";

pub struct VideoRuntime {
    key: [u8; 32],
    client: Client,
    #[cfg(feature = "video-test-fixtures")]
    fixture_url: Option<Url>,
}

impl VideoRuntime {
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        match env::var("Q_VIDEO_ENCRYPTION_KEY") {
            Err(env::VarError::NotPresent) => Ok(None),
            Err(_) => Err("Q_VIDEO_ENCRYPTION_KEY must be a base64-encoded 32-byte key"),
            Ok(value) => {
                let decoded = STANDARD
                    .decode(value)
                    .map_err(|_| "Q_VIDEO_ENCRYPTION_KEY must be a base64-encoded 32-byte key")?;
                let key = decoded
                    .try_into()
                    .map_err(|_| "Q_VIDEO_ENCRYPTION_KEY must be a base64-encoded 32-byte key")?;
                Self::new(key).map(Some)
            }
        }
    }

    pub fn new(key: [u8; 32]) -> Result<Self, &'static str> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .https_only(true)
            .no_proxy()
            .build()
            .map_err(|_| "Could not initialize video provider transport")?;
        Ok(Self {
            key,
            client,
            #[cfg(feature = "video-test-fixtures")]
            fixture_url: None,
        })
    }

    /// Deliberately absent from default builds and never configured by HTTP or environment.
    #[cfg(feature = "video-test-fixtures")]
    pub fn with_test_fixture(mut self, url: Url) -> Result<Self, &'static str> {
        let loopback = url
            .host_str()
            .and_then(|h| h.parse::<IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        if !loopback
            || url.scheme() != "http"
            || url.path() != "/"
            || url.query().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("Test provider must be an HTTP loopback origin");
        }
        self.client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(3))
            .no_proxy()
            .build()
            .map_err(|_| "Could not initialize test transport")?;
        self.fixture_url = Some(url);
        Ok(self)
    }

    fn endpoint(&self, region: &str, task: Option<&str>) -> ApiResult<Url> {
        let origin = match region {
            "cn" => "https://api-beijing.klingai.com/",
            "global" => "https://api-singapore.klingai.com/",
            _ => return Err(ApiError::internal()),
        };
        let mut url = Url::parse(origin).map_err(|_| ApiError::internal())?;
        #[cfg(feature = "video-test-fixtures")]
        if let Some(fixture) = &self.fixture_url {
            url = fixture.clone();
        }
        url.set_path("/v1/videos/text2video");
        if let Some(task) = task {
            url.path_segments_mut()
                .map_err(|_| ApiError::internal())?
                .push(task);
        }
        Ok(url)
    }

    fn encrypt(&self, owner: Uuid, id: Uuid, credentials: &Credentials) -> ApiResult<Vec<u8>> {
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| ApiError::internal())?;
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let plain = serde_json::to_vec(credentials).map_err(|_| ApiError::internal())?;
        let aad = format!("q.video.v1:{owner}:{id}");
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plain,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| ApiError::internal())?;
        let mut result = nonce.to_vec();
        result.extend(encrypted);
        Ok(result)
    }

    fn decrypt(&self, owner: Uuid, id: Uuid, encrypted: &[u8]) -> ApiResult<Credentials> {
        if encrypted.len() <= 28 {
            return Err(unavailable());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| unavailable())?;
        let aad = format!("q.video.v1:{owner}:{id}");
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&encrypted[..12]),
                Payload {
                    msg: &encrypted[12..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| unavailable())?;
        serde_json::from_slice(&plain).map_err(|_| unavailable())
    }

    async fn call(
        &self,
        url: Url,
        credentials: &Credentials,
        body: Option<serde_json::Value>,
    ) -> Result<ProviderTask, ProviderError> {
        let request = if let Some(body) = body {
            self.client.post(url).json(&body)
        } else {
            self.client.get(url)
        };
        let mut response = request
            .bearer_auth(&credentials.api_key)
            .send()
            .await
            .map_err(|_| ProviderError::Unknown)?;
        let status = response.status();
        // Redirects must never forward credentials; 5xx/timeouts do not prove a write failed.
        if !status.is_success() {
            return Err(if status.is_client_error() && status.as_u16() != 408 {
                ProviderError::Rejected
            } else {
                ProviderError::Unknown
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_PROVIDER_RESPONSE as u64)
        {
            return Err(ProviderError::Unknown);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ProviderError::Unknown)? {
            if bytes.len() + chunk.len() > MAX_PROVIDER_RESPONSE {
                return Err(ProviderError::Unknown);
            }
            bytes.extend_from_slice(&chunk);
        }
        let envelope: ProviderResponse =
            serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unknown)?;
        if envelope.code != 0 {
            return Err(ProviderError::Rejected);
        }
        let task = envelope.data.ok_or(ProviderError::Unknown)?;
        if !valid_task_id(&task.task_id)
            || !matches!(
                task.task_status.as_str(),
                "submitted" | "processing" | "succeed" | "failed"
            )
        {
            return Err(ProviderError::Unknown);
        }
        Ok(task)
    }
}

#[derive(Serialize, Deserialize)]
struct Credentials {
    api_key: String,
}

#[derive(Serialize, FromRow)]
pub struct Connection {
    pub id: Uuid,
    pub name: String,
    pub provider: String,
    pub region: String,
    pub created_at: DateTime<Utc>,
    pub revoked: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionRequest {
    name: String,
    region: String,
    api_key: String,
}
#[derive(Serialize)]
pub struct Items<T> {
    items: Vec<T>,
}

pub async fn connections(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<Items<Connection>>> {
    let items = sqlx::query_as(&format!("SELECT {CONNECTION_FIELDS} FROM video_connections WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100"))
        .bind(auth.user_id).fetch_all(&state.pool).await?;
    Ok(Json(Items { items }))
}

pub async fn create_connection(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<ConnectionRequest>,
) -> ApiResult<(StatusCode, Json<Connection>)> {
    let runtime = runtime(&state)?;
    let name = request.name.trim();
    validation::text(name, 1, 48, "Connection name must contain 1–48 characters.")?;
    if !matches!(request.region.as_str(), "cn" | "global") || !valid_secret(&request.api_key) {
        return Err(ApiError::validation(
            "Choose a Kling region and enter a valid API key.",
        ));
    }
    state.limit_auth(format!("video-connect:{}", auth.user_id), 10)?;
    let id = Uuid::new_v4();
    let encrypted = runtime.encrypt(
        auth.user_id,
        id,
        &Credentials {
            api_key: request.api_key,
        },
    )?;
    let connection = sqlx::query_as(&format!("INSERT INTO video_connections(id,user_id,name,region,encrypted_credentials) VALUES ($1,$2,$3,$4,$5) RETURNING {CONNECTION_FIELDS}"))
        .bind(id).bind(auth.user_id).bind(name).bind(request.region).bind(encrypted).fetch_one(&state.pool).await?;
    Ok((StatusCode::CREATED, Json(connection)))
}

pub async fn revoke_connection(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = path_id(&id)?;
    let changed = sqlx::query("UPDATE video_connections SET revoked=true,encrypted_credentials=NULL WHERE id=$1 AND user_id=$2")
        .bind(id).bind(auth.user_id).execute(&state.pool).await?;
    if changed.rows_affected() == 0 {
        return Err(connection_missing());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Clone, FromRow)]
pub struct VideoJob {
    pub id: Uuid,
    pub connection_id: Uuid,
    pub prompt: String,
    pub model_name: String,
    pub mode: String,
    pub duration: String,
    pub aspect_ratio: String,
    pub status: String,
    pub provider_task_id: Option<String>,
    pub video_url: Option<String>,
    pub error_code: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JobRequest {
    connection_id: Uuid,
    prompt: String,
    model_name: String,
    mode: String,
    duration: String,
    aspect_ratio: String,
    idempotency_key: Uuid,
}
impl JobRequest {
    fn validate(&mut self) -> ApiResult<()> {
        self.prompt = self.prompt.trim().to_owned();
        validation::text(
            &self.prompt,
            1,
            2500,
            "Prompt must contain 1–2500 characters.",
        )?;
        if self.model_name != "kling-v2-6"
            || self.mode != "pro"
            || !matches!(self.duration.as_str(), "5" | "10")
            || !matches!(self.aspect_ratio.as_str(), "16:9" | "9:16" | "1:1")
        {
            return Err(ApiError::validation(
                "Choose a supported Kling model, mode, duration and aspect ratio.",
            ));
        }
        Ok(())
    }
    fn matches(&self, job: &VideoJob) -> bool {
        self.connection_id == job.connection_id
            && self.prompt == job.prompt
            && self.model_name == job.model_name
            && self.mode == job.mode
            && self.duration == job.duration
            && self.aspect_ratio == job.aspect_ratio
    }
    fn provider_body(&self, id: Uuid) -> serde_json::Value {
        json!({"model_name":self.model_name,"prompt":self.prompt,"mode":self.mode,"duration":self.duration,"aspect_ratio":self.aspect_ratio,"external_task_id":id.to_string(),"sound":"off"})
    }
}

pub async fn jobs(
    State(state): State<AppState>,
    auth: Authenticated,
) -> ApiResult<Json<Items<VideoJob>>> {
    let items = sqlx::query_as(&format!(
        "SELECT {JOB_FIELDS} FROM video_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50"
    ))
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Items { items }))
}

pub async fn create_job(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(mut request): ApiJson<JobRequest>,
) -> ApiResult<(StatusCode, Json<VideoJob>)> {
    request.validate()?;
    // The per-user row lock serializes conflicting reservations across connections/processes.
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT id FROM identities WHERE id=$1 FOR UPDATE")
        .bind(auth.user_id)
        .execute(&mut *tx)
        .await?;
    let existing: Option<VideoJob> = sqlx::query_as(&format!(
        "SELECT {JOB_FIELDS} FROM video_jobs WHERE user_id=$1 AND idempotency_key=$2"
    ))
    .bind(auth.user_id)
    .bind(request.idempotency_key)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        if !request.matches(&existing) {
            return Err(ApiError::conflict(
                "IDEMPOTENCY_CONFLICT",
                "This request key is already used for another video.",
            ));
        }
        tx.commit().await?;
        return Ok((StatusCode::OK, Json(existing)));
    }
    let runtime = runtime(&state)?;
    state.limit_auth(format!("video-start:{}", auth.user_id), 10)?;
    let connection: Option<(String, Option<Vec<u8>>, bool)> = sqlx::query_as("SELECT region,encrypted_credentials,revoked FROM video_connections WHERE id=$1 AND user_id=$2 FOR SHARE")
        .bind(request.connection_id).bind(auth.user_id).fetch_optional(&mut *tx).await?;
    let (region, encrypted, revoked) = connection.ok_or_else(connection_missing)?;
    if revoked {
        return Err(revoked_error());
    }
    let credentials = runtime.decrypt(
        auth.user_id,
        request.connection_id,
        &encrypted.ok_or_else(unavailable)?,
    )?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO video_jobs(id,user_id,connection_id,idempotency_key,prompt,model_name,mode,duration,aspect_ratio,status,last_poll_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'submitting',now())")
        .bind(id).bind(auth.user_id).bind(request.connection_id).bind(request.idempotency_key).bind(&request.prompt)
        .bind(&request.model_name).bind(&request.mode).bind(&request.duration).bind(&request.aspect_ratio).execute(&mut *tx).await?;
    tx.commit().await?;
    // The reservation is durable even if the process/request dies during this call.
    let result = runtime
        .call(
            runtime.endpoint(&region, None)?,
            &credentials,
            Some(request.provider_body(id)),
        )
        .await;
    match result {
        Ok(task) => apply_task(&state.pool, auth.user_id, id, &task, true).await?,
        Err(error) => {
            let (status, code) = match error {
                ProviderError::Rejected => ("failed", "VIDEO_PROVIDER_REJECTED"),
                ProviderError::Unknown => ("unknown", "VIDEO_SUBMISSION_UNKNOWN"),
            };
            sqlx::query("UPDATE video_jobs SET status=$3,error_code=$4,updated_at=now() WHERE id=$1 AND user_id=$2 AND status='submitting'")
                .bind(id).bind(auth.user_id).bind(status).bind(code).execute(&state.pool).await?;
        }
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(read_job(&state.pool, auth.user_id, id).await?),
    ))
}

pub async fn job(
    State(state): State<AppState>,
    auth: Authenticated,
    Path(id): Path<String>,
) -> ApiResult<Json<VideoJob>> {
    let id = path_id(&id)?;
    let saved = read_job(&state.pool, auth.user_id, id).await?;
    if saved.status == "failed" || (saved.status == "succeeded" && saved.video_url.is_some()) {
        return Ok(Json(saved));
    }
    let connection: Option<(String, Option<Vec<u8>>, bool)> = sqlx::query_as("SELECT region,encrypted_credentials,revoked FROM video_connections WHERE id=$1 AND user_id=$2")
        .bind(saved.connection_id).bind(auth.user_id).fetch_optional(&state.pool).await?;
    let (region, encrypted, revoked) = connection.ok_or_else(connection_missing)?;
    if revoked {
        return Ok(Json(saved));
    }
    let runtime = runtime(&state)?;
    let credentials = runtime.decrypt(
        auth.user_id,
        saved.connection_id,
        &encrypted.ok_or_else(unavailable)?,
    )?;
    // This database claim also throttles polling across browser tabs and API processes.
    let claimed = sqlx::query("UPDATE video_jobs SET last_poll_at=now() WHERE id=$1 AND user_id=$2 AND status <> 'failed' AND (status <> 'succeeded' OR video_url IS NULL) AND (last_poll_at IS NULL OR last_poll_at < now() - interval '3 seconds')")
        .bind(id).bind(auth.user_id).execute(&state.pool).await?.rows_affected() > 0;
    if !claimed {
        return Ok(Json(saved));
    }
    state.limit_auth(format!("video-poll:{}", auth.user_id), 60)?;
    let task_id = saved
        .provider_task_id
        .clone()
        .unwrap_or_else(|| id.to_string());
    let result = runtime
        .call(
            runtime.endpoint(&region, Some(&task_id))?,
            &credentials,
            None,
        )
        .await;
    match result {
        Ok(task)
            if saved
                .provider_task_id
                .as_ref()
                .is_none_or(|known| known == &task.task_id) =>
        {
            apply_task(&state.pool, auth.user_id, id, &task, false).await?
        }
        _ => {
            // A missing/unavailable lookup never authorizes another paid submission.
            sqlx::query("UPDATE video_jobs SET status=CASE WHEN status='submitting' THEN 'unknown' ELSE status END,error_code='VIDEO_POLL_UNAVAILABLE',updated_at=now() WHERE id=$1 AND user_id=$2 AND status NOT IN ('succeeded','failed')")
                .bind(id).bind(auth.user_id).execute(&state.pool).await?;
        }
    }
    Ok(Json(read_job(&state.pool, auth.user_id, id).await?))
}

async fn read_job(pool: &PgPool, owner: Uuid, id: Uuid) -> ApiResult<VideoJob> {
    sqlx::query_as(&format!(
        "SELECT {JOB_FIELDS} FROM video_jobs WHERE id=$1 AND user_id=$2"
    ))
    .bind(id)
    .bind(owner)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "VIDEO_JOB_NOT_FOUND",
            "This video task was not found.",
        )
    })
}

async fn apply_task(
    pool: &PgPool,
    owner: Uuid,
    id: Uuid,
    task: &ProviderTask,
    submission: bool,
) -> ApiResult<()> {
    let status = match task.task_status.as_str() {
        "succeed" => "succeeded",
        "failed" => "failed",
        "processing" => "processing",
        _ => "submitted",
    };
    let supplied_url = task
        .task_result
        .as_ref()
        .and_then(|r| r.videos.first())
        .map(|v| v.url.as_str());
    let url = supplied_url.filter(|u| safe_video_url(u));
    let error = match status {
        "failed" => Some("VIDEO_PROVIDER_FAILED"),
        "succeeded" if supplied_url.is_some() && url.is_none() => {
            Some("VIDEO_RESULT_URL_UNSUPPORTED")
        }
        "succeeded" if url.is_none() => Some("VIDEO_RESULT_UNAVAILABLE"),
        _ => None,
    };
    // Late submission/poll responses cannot overwrite an already-completed result.
    sqlx::query("UPDATE video_jobs SET status=$3,provider_task_id=$4,video_url=$5,error_code=$6,updated_at=now() WHERE id=$1 AND user_id=$2 AND (status NOT IN ('succeeded','failed') OR (status='succeeded' AND video_url IS NULL AND $3='succeeded')) AND (NOT $7 OR status IN ('submitting','unknown')) AND (status <> 'processing' OR $3 <> 'submitted')")
        .bind(id).bind(owner).bind(status).bind(&task.task_id).bind(url).bind(error).bind(submission).execute(pool).await?;
    Ok(())
}

#[derive(Deserialize)]
struct ProviderResponse {
    code: i64,
    data: Option<ProviderTask>,
}
#[derive(Deserialize)]
struct ProviderTask {
    task_id: String,
    task_status: String,
    task_result: Option<ProviderResult>,
}
#[derive(Deserialize)]
struct ProviderResult {
    videos: Vec<ProviderVideo>,
}
#[derive(Deserialize)]
struct ProviderVideo {
    url: String,
}
enum ProviderError {
    Rejected,
    Unknown,
}

fn runtime(state: &AppState) -> ApiResult<Arc<VideoRuntime>> {
    state.video.clone().ok_or_else(unavailable)
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "VIDEO_UNAVAILABLE",
        "Video API connections are not configured on this server.",
    )
}
fn connection_missing() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "VIDEO_CONNECTION_NOT_FOUND",
        "This video API connection was not found.",
    )
}
fn revoked_error() -> ApiError {
    ApiError::conflict(
        "VIDEO_CONNECTION_REVOKED",
        "This video API connection has been disconnected.",
    )
}
fn valid_secret(value: &str) -> bool {
    (1..=512).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_graphic())
}
fn path_id(value: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(value)
        .map_err(|_| ApiError::validation("Use a valid video task or connection ID."))
}
fn valid_task_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn safe_video_url(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if value.len() > 4096
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    // Official media hosts only: supplier data cannot turn the player into an arbitrary fetch.
    host.ends_with(".klingai.com") && host.parse::<IpAddr>().is_err()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_is_owner_bound_and_authenticated() {
        let runtime = VideoRuntime::new([9; 32]).unwrap();
        let owner = Uuid::new_v4();
        let id = Uuid::new_v4();
        let credentials = Credentials {
            api_key: "test-api-key".into(),
        };
        let first = runtime.encrypt(owner, id, &credentials).unwrap();
        let second = runtime.encrypt(owner, id, &credentials).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            runtime.decrypt(owner, id, &first).unwrap().api_key,
            "test-api-key"
        );
        assert!(runtime.decrypt(Uuid::new_v4(), id, &first).is_err());
        assert!(runtime.decrypt(owner, Uuid::new_v4(), &first).is_err());
        let mut tampered = first;
        tampered[20] ^= 1;
        assert!(runtime.decrypt(owner, id, &tampered).is_err());
    }
    #[test]
    fn media_urls_and_task_ids_cannot_escape_provider_boundary() {
        assert!(safe_video_url(
            "https://v1.klingai.com/video.mp4?token=signature"
        ));
        for bad in [
            "http://v1.klingai.com/video.mp4",
            "https://localhost/v",
            "https://127.0.0.1/v",
            "https://[::1]/v",
            "https://v1.klingai.com.evil.test/v",
            "https://user:password@v1.klingai.com/v",
            "https://v1.klingai.com:8443/v",
            "https://v1.klingai.com/v#fragment",
        ] {
            assert!(!safe_video_url(bad), "{bad}");
        }
        assert!(valid_task_id("123-abc_456"));
        assert!(!valid_task_id("../secrets?x"));
    }
}
