use super::{
    Article, FRESH_SECONDS, FeedFetcher, FetchError, FetchResult, MAX_CACHE_SECONDS, NewsResponse,
    Source, SourceStatus, Topic, Validators,
};
use crate::error::ApiResult;
use chrono::{DateTime, Duration, Utc};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(FromRow)]
struct CacheRow {
    id: String,
    records: Option<serde_json::Value>,
    last_success_at: Option<DateTime<Utc>>,
    last_checked_at: Option<DateTime<Utc>>,
    next_attempt_at: DateTime<Utc>,
    consecutive_failures: i32,
    error_code: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    lease_token: Option<Uuid>,
    lease_expires_at: Option<DateTime<Utc>>,
}
#[derive(FromRow)]
struct ProviderRow {
    next_attempt_at: DateTime<Utc>,
    consecutive_failures: i32,
    error_code: Option<String>,
    lease_token: Option<Uuid>,
    lease_expires_at: Option<DateTime<Utc>>,
}
#[derive(Debug)]
pub struct Lease {
    pub source: Source,
    pub token: Uuid,
    pub validators: Validators,
}

pub(super) async fn scheduled_sources(pool: &PgPool) -> ApiResult<Vec<Source>> {
    // Oldest untried/due topic first: a failing first GDELT query cannot starve
    // the other two topics behind the provider-wide backoff.
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM market_news_sources ORDER BY next_attempt_at,id")
            .fetch_all(pool)
            .await?;
    Ok(ids
        .iter()
        .filter_map(|id| Source::ALL.into_iter().find(|s| s.id() == id))
        .collect())
}

/// An expiring per-source lease plus a GDELT-wide lease prevents multi-process overlap.
/// No process-local mutex or clock is relied on for ownership or retries.
pub async fn claim(pool: &PgPool, source: Source) -> ApiResult<Option<Lease>> {
    let mut tx = pool.begin().await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let row: Option<CacheRow> =
        sqlx::query_as("SELECT * FROM market_news_sources WHERE id=$1 FOR UPDATE SKIP LOCKED")
            .bind(source.id())
            .fetch_optional(&mut *tx)
            .await?;
    let Some(row) = row else { return Ok(None) };
    if row.next_attempt_at > now || row.lease_expires_at.is_some_and(|v| v > now) {
        return Ok(None);
    }
    if source.gdelt() {
        let provider:Option<ProviderRow>=sqlx::query_as("SELECT next_attempt_at,consecutive_failures,error_code,lease_token,lease_expires_at FROM market_news_provider_state WHERE id='gdelt' FOR UPDATE SKIP LOCKED").fetch_optional(&mut *tx).await?;
        let Some(provider) = provider else {
            return Ok(None);
        };
        if provider.next_attempt_at > now || provider.lease_expires_at.is_some_and(|v| v > now) {
            return Ok(None);
        }
    }
    let token = Uuid::new_v4();
    sqlx::query("UPDATE market_news_sources SET lease_token=$2,lease_expires_at=$3 WHERE id=$1")
        .bind(source.id())
        .bind(token)
        .bind(now + Duration::seconds(60))
        .execute(&mut *tx)
        .await?;
    if source.gdelt() {
        sqlx::query("UPDATE market_news_provider_state SET lease_token=$1,lease_expires_at=$2,next_attempt_at=GREATEST(next_attempt_at,$3) WHERE id='gdelt'").bind(token).bind(now+Duration::seconds(60)).bind(now+Duration::seconds(5)).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Some(Lease {
        source,
        token,
        validators: Validators {
            etag: row.etag,
            last_modified: row.last_modified,
        },
    }))
}
fn retry_delay(failures: i32) -> i64 {
    [60, 300, 900, 3600][(failures.saturating_sub(1) as usize).min(3)]
}

/// Fencing checks are applied before every write, including errors and 304 refreshes.
/// Aborted/expired workers may not overwrite a successor's success or cooldown.
pub async fn complete(
    pool: &PgPool,
    lease: Lease,
    mut result: Result<FetchResult, FetchError>,
) -> ApiResult<bool> {
    let mut tx = pool.begin().await?;
    let row: CacheRow = sqlx::query_as("SELECT * FROM market_news_sources WHERE id=$1 FOR UPDATE")
        .bind(lease.source.id())
        .fetch_one(&mut *tx)
        .await?;
    let provider: Option<ProviderRow> = if lease.source.gdelt() {
        Some(sqlx::query_as("SELECT next_attempt_at,consecutive_failures,error_code,lease_token,lease_expires_at FROM market_news_provider_state WHERE id='gdelt' FOR UPDATE").fetch_one(&mut *tx).await?)
    } else {
        None
    };
    // Read the wall clock after lock acquisition: waiting on a row may have
    // consumed the lease even when it was current when completion started.
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    if row.lease_token != Some(lease.token) || !row.lease_expires_at.is_some_and(|v| v > now) {
        return Ok(false);
    }
    if provider.as_ref().is_some_and(|p| {
        p.lease_token != Some(lease.token) || !p.lease_expires_at.is_some_and(|v| v > now)
    }) {
        return Ok(false);
    }
    if matches!(result, Ok(FetchResult::NotModified)) && row.records.is_none() {
        result = Err(FetchError::InvalidData);
    }
    let provider_failures = provider
        .as_ref()
        .map(|p| p.consecutive_failures)
        .unwrap_or(row.consecutive_failures);
    match result {
        Ok(value) => {
            let (records, validators) = match value {
                FetchResult::Modified(records, validators) => (
                    Some(
                        serde_json::to_value(records)
                            .map_err(|_| crate::error::ApiError::internal())?,
                    ),
                    validators,
                ),
                FetchResult::NotModified => (
                    None,
                    Validators {
                        etag: row.etag,
                        last_modified: row.last_modified,
                    },
                ),
            };
            sqlx::query("UPDATE market_news_sources SET records=COALESCE($2,records),last_success_at=$3,last_checked_at=$3,next_attempt_at=$4,consecutive_failures=0,error_code=NULL,etag=$5,last_modified=$6,lease_token=NULL,lease_expires_at=NULL WHERE id=$1")
                .bind(lease.source.id()).bind(records).bind(now).bind(now+Duration::seconds(FRESH_SECONDS)).bind(validators.etag).bind(validators.last_modified).execute(&mut *tx).await?;
            if lease.source.gdelt() {
                sqlx::query("UPDATE market_news_provider_state SET next_attempt_at=$1,consecutive_failures=0,error_code=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id='gdelt'").bind(now+Duration::seconds(5)).execute(&mut *tx).await?;
            }
        }
        Err(error) => {
            let failures = provider_failures.saturating_add(1).min(1_000_000);
            let mut retry_at = now + Duration::seconds(retry_delay(failures));
            if let FetchError::RateLimited(Some(retry_after)) = &error {
                retry_at = retry_at.max(retry_after.deadline(now));
            }
            sqlx::query("UPDATE market_news_sources SET last_checked_at=$2,next_attempt_at=$3,consecutive_failures=LEAST(consecutive_failures+1,1000000),error_code=$4,lease_token=NULL,lease_expires_at=NULL WHERE id=$1").bind(lease.source.id()).bind(now).bind(retry_at).bind(error.code()).execute(&mut *tx).await?;
            if lease.source.gdelt() {
                sqlx::query("UPDATE market_news_provider_state SET next_attempt_at=$1,consecutive_failures=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL WHERE id='gdelt'").bind(retry_at).bind(failures).bind(error.code()).execute(&mut *tx).await?;
            }
        }
    }
    tx.commit().await?;
    Ok(true)
}

pub async fn refresh_source(
    pool: &PgPool,
    source: Source,
    fetcher: &dyn FeedFetcher,
) -> ApiResult<bool> {
    let Some(lease) = claim(pool, source).await? else {
        return Ok(false);
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        fetcher.fetch(source, lease.validators.clone()),
    )
    .await
    .unwrap_or(Err(FetchError::Timeout));
    complete(pool, lease, result).await
}

/// This is the entire customer read path: bounded PostgreSQL reads, zero upstream calls.
pub async fn read_news(pool: &PgPool, topic: Topic) -> ApiResult<NewsResponse> {
    let mut tx = pool.begin().await?;
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&mut *tx)
        .await?;
    let ids = topic.sources().iter().map(|s| s.id()).collect::<Vec<_>>();
    let rows: Vec<CacheRow> = sqlx::query_as("SELECT * FROM market_news_sources WHERE id=ANY($1)")
        .bind(ids)
        .fetch_all(&mut *tx)
        .await?;
    let provider:ProviderRow=sqlx::query_as("SELECT next_attempt_at,consecutive_failures,error_code,lease_token,lease_expires_at FROM market_news_provider_state WHERE id='gdelt'").fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let mut records = Vec::new();
    let mut sources = Vec::new();
    for source in topic.sources() {
        let row = rows
            .iter()
            .find(|r| r.id == source.id())
            .ok_or_else(crate::error::ApiError::internal)?;
        let age = row.last_success_at.map(|t| (now - t).num_seconds());
        let usable = age.is_some_and(|age| (0..=MAX_CACHE_SECONDS).contains(&age));
        let status = if !usable {
            "unavailable"
        } else if age.is_some_and(|v| v > FRESH_SECONDS) || row.error_code.is_some() {
            "stale"
        } else {
            "ready"
        };
        if usable {
            let cached: Vec<Article> = serde_json::from_value(
                row.records
                    .clone()
                    .ok_or_else(crate::error::ApiError::internal)?,
            )
            .map_err(|_| crate::error::ApiError::internal())?;
            records.extend(cached);
        }
        let mut retry_at = row
            .next_attempt_at
            .max(row.lease_expires_at.unwrap_or(row.next_attempt_at));
        if source.gdelt() {
            retry_at = retry_at.max(provider.next_attempt_at).max(
                provider
                    .lease_expires_at
                    .unwrap_or(provider.next_attempt_at),
            );
        }
        sources.push(SourceStatus {
            id: source.id().into(),
            name: source.name().into(),
            url: source.url(),
            status: status.into(),
            last_checked_at: row.last_checked_at,
            last_success_at: row.last_success_at,
            retry_at,
            error_code: row.error_code.clone().or_else(|| {
                source
                    .gdelt()
                    .then(|| provider.error_code.clone())
                    .flatten()
            }),
        });
    }
    records.sort_by_key(|r| std::cmp::Reverse(r.published_at.or(r.indexed_at)));
    let mut seen = std::collections::HashSet::new();
    records.retain(|r| seen.insert(r.url.clone()));
    records.truncate(20);
    let ready = sources.iter().filter(|s| s.status == "ready").count();
    let status = if ready == sources.len() {
        "ready"
    } else if ready > 0 {
        "partial"
    } else if sources.iter().any(|s| s.status == "stale") {
        "stale"
    } else {
        "unavailable"
    };
    Ok(NewsResponse {
        version: 1,
        topic,
        server_time: now,
        status: status.into(),
        records,
        sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_backoff_has_explicit_progression() {
        assert_eq!(
            (1..=6).map(retry_delay).collect::<Vec<_>>(),
            vec![60, 300, 900, 3600, 3600, 3600]
        );
    }
}
