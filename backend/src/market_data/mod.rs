//! Fixed public news sources, durable shared cache and fenced background collection.
//! No account/session/AI content is sent to providers. HTTP reads never start collection.
mod fetch;
mod parse;
mod store;

pub use fetch::{FeedFetcher, FetchError, FetchResult, HttpFetcher, RetryAfter, Validators};
pub use parse::{Article, Source, parse_feed};
pub use store::{Lease, claim, complete, read_news, refresh_source};

use crate::{
    AppState,
    error::{ApiError, ApiResult},
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use tokio::task::JoinHandle;

pub const FRESH_SECONDS: i64 = 15 * 60;
pub const MAX_CACHE_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Topic {
    CentralBanks,
    Fed,
    Markets,
    Crypto,
    Technology,
}
impl Topic {
    pub fn sources(self) -> &'static [Source] {
        match self {
            Self::CentralBanks => &[Source::Fed, Source::Ecb],
            Self::Fed => &[Source::Fed],
            Self::Markets => &[Source::GdeltMarkets],
            Self::Crypto => &[Source::GdeltCrypto],
            Self::Technology => &[Source::GdeltTechnology],
        }
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct SourceStatus {
    pub id: String,
    pub name: String,
    pub url: String,
    pub status: String,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub retry_at: DateTime<Utc>,
    pub error_code: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NewsResponse {
    pub version: u8,
    pub topic: Topic,
    pub server_time: DateTime<Utc>,
    pub status: String,
    pub records: Vec<Article>,
    pub sources: Vec<SourceStatus>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewsQuery {
    topic: Topic,
}

async fn news(
    State(state): State<AppState>,
    query: Result<Query<NewsQuery>, axum::extract::rejection::QueryRejection>,
) -> ApiResult<(HeaderMap, Json<NewsResponse>)> {
    let Query(query) = query.map_err(|_| ApiError::validation("Choose a supported news topic."))?;
    let result = read_news(&state.pool, query.topic).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=30"),
    );
    Ok((headers, Json(result)))
}
pub fn router() -> Router<AppState> {
    Router::new().route("/v1/market-data/news", get(news))
}

/// The process owns the worker handle; abort and await it during shutdown.
/// Aborting in flight leaves a finite lease, not an unfenced late cache write.
pub fn spawn(pool: PgPool) -> Result<JoinHandle<()>, reqwest::Error> {
    let fetcher = HttpFetcher::new()?;
    Ok(tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Ok(sources) = store::scheduled_sources(&pool).await else {
                tracing::warn!("public news collection schedule could not be read");
                continue;
            };
            for source in sources {
                if refresh_source(&pool, source, &fetcher).await.is_err() {
                    // No upstream bodies, article text, URL query or account data in logs.
                    tracing::warn!(
                        source = source.id(),
                        "public news cache refresh database operation failed"
                    );
                }
            }
        }
    }))
}
