//! Real isolated PostgreSQL only; all provider I/O is a controlled in-process fixture.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::market_data::{
    self, Article, FeedFetcher, FetchError, FetchResult, Source, Topic, Validators,
};

struct Harness {
    pool: PgPool,
    admin: PgPool,
    schema: String,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("explicit isolated TEST_DATABASE_URL required");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let schema = format!("news_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .after_connect(move |connection, _| {
                let query = format!("SET search_path TO {search}");
                Box::pin(async move {
                    sqlx::query(&query).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../migrations/2026110503_market_news.sql"))
            .execute(&pool)
            .await
            .unwrap();
        Self {
            pool,
            admin,
            schema,
        }
    }
    async fn finish(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
    async fn due(&self, source: Source) {
        sqlx::query("UPDATE market_news_sources SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1").bind(source.id()).execute(&self.pool).await.unwrap();
        sqlx::query("UPDATE market_news_provider_state SET next_attempt_at=clock_timestamp()-interval '1 second'").execute(&self.pool).await.unwrap();
    }
}
fn sample(source: Source, title: &str) -> Article {
    Article {
        title: title.into(),
        url: format!("https://www.ecb.europa.eu/press/{title}.html"),
        source_id: source.id().into(),
        publisher: source.name().into(),
        published_at: Some(Utc::now() - Duration::hours(1)),
        indexed_at: None,
    }
}
struct Good {
    calls: AtomicUsize,
}
impl FeedFetcher for Good {
    fn fetch<'a>(
        &'a self,
        source: Source,
        _: Validators,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResult, FetchError>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            Ok(FetchResult::Modified(
                vec![sample(source, "good")],
                Validators::default(),
            ))
        })
    }
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn hundred_concurrent_reads_and_refreshes_share_one_collection() {
    let h = Harness::new().await;
    let fixture = Arc::new(Good {
        calls: AtomicUsize::new(0),
    });
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let pool = h.pool.clone();
        tasks.push(tokio::spawn(async move {
            market_data::read_news(&pool, Topic::CentralBanks)
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        assert!(task.await.unwrap().records.is_empty());
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let pool = h.pool.clone();
        let fixture = fixture.clone();
        tasks.push(tokio::spawn(async move {
            market_data::refresh_source(&pool, Source::Ecb, fixture.as_ref())
                .await
                .unwrap()
        }));
    }
    let mut writes = 0;
    for task in tasks {
        writes += usize::from(task.await.unwrap());
    }
    assert_eq!(writes, 1);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let pool = h.pool.clone();
        tasks.push(tokio::spawn(async move {
            market_data::read_news(&pool, Topic::CentralBanks)
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        let report = task.await.unwrap();
        assert_eq!(report.records.len(), 1);
        assert_eq!(report.status, "partial");
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn public_http_contract_rejects_extra_selectors_without_auth_or_collection() {
    let h = Harness::new().await;
    let state = xiaoq_backend::AppState::new(h.pool.clone()).await.unwrap();
    let router = xiaoq_backend::app(state, vec![]);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/market-data/news?topic=central_banks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "public, max-age=30");
    let json: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(json["status"], "unavailable");
    assert_eq!(json["sources"].as_array().unwrap().len(), 2);
    for uri in [
        "/v1/market-data/news?topic=central_banks&url=https%3A%2F%2Fevil.example",
        "/v1/market-data/news?topic=other",
        "/v1/market-data/news?topic=fed&topic=markets",
        "/v1/market-data/news",
    ] {
        let response = router
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let json: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(json["error"]["code"], "VALIDATION_ERROR");
    }
    let leases:i64=sqlx::query_scalar("SELECT COUNT(*) FROM market_news_sources WHERE lease_token IS NOT NULL OR last_checked_at IS NOT NULL").fetch_one(&h.pool).await.unwrap();
    assert_eq!(
        leases, 0,
        "public reads and rejected selectors did not collect anything"
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn expired_worker_cannot_replace_success_or_release_successors_lease() {
    let h = Harness::new().await;
    let old = market_data::claim(&h.pool, Source::Ecb)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE market_news_sources SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='ecb'").execute(&h.pool).await.unwrap();
    let next = market_data::claim(&h.pool, Source::Ecb)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !market_data::complete(&h.pool, old, Err(FetchError::Timeout))
            .await
            .unwrap()
    );
    assert!(
        market_data::complete(
            &h.pool,
            next,
            Ok(FetchResult::Modified(
                vec![sample(Source::Ecb, "new")],
                Validators::default()
            ))
        )
        .await
        .unwrap()
    );
    let report = market_data::read_news(&h.pool, Topic::CentralBanks)
        .await
        .unwrap();
    assert_eq!(report.records[0].title, "new");
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn completion_waiting_on_a_lock_rechecks_wall_clock_after_the_wait() {
    let h = Harness::new().await;
    let lease = market_data::claim(&h.pool, Source::Ecb)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE market_news_sources SET lease_expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id='ecb'").execute(&h.pool).await.unwrap();
    let mut blocker = h.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM market_news_sources WHERE id='ecb' FOR UPDATE")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let pool = h.pool.clone();
    let pending = tokio::spawn(async move {
        market_data::complete(
            &pool,
            lease,
            Ok(FetchResult::Modified(
                vec![sample(Source::Ecb, "late")],
                Validators::default(),
            )),
        )
        .await
        .unwrap()
    });
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    blocker.commit().await.unwrap();
    assert!(!pending.await.unwrap());
    assert!(
        market_data::read_news(&h.pool, Topic::CentralBanks)
            .await
            .unwrap()
            .records
            .is_empty()
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn gdelt_backoff_is_global_durable_and_honors_retry_after() {
    let h = Harness::new().await;
    let retry = Utc::now() + Duration::hours(2);
    let lease = market_data::claim(&h.pool, Source::GdeltMarkets)
        .await
        .unwrap()
        .unwrap();
    assert!(
        market_data::claim(&h.pool, Source::GdeltCrypto)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        market_data::complete(
            &h.pool,
            lease,
            Err(FetchError::RateLimited(Some(market_data::RetryAfter::At(
                retry
            ))))
        )
        .await
        .unwrap()
    );
    // New calls/pools/instances use the same database schedule, not a process memory timer.
    assert!(
        market_data::claim(&h.pool, Source::GdeltCrypto)
            .await
            .unwrap()
            .is_none()
    );
    let report = market_data::read_news(&h.pool, Topic::Crypto)
        .await
        .unwrap();
    assert_eq!(report.status, "unavailable");
    assert!(report.sources[0].retry_at >= retry);
    assert_eq!(
        report.sources[0].error_code.as_deref(),
        Some("rate_limited")
    );
    // A bad topic cannot alter the independent central-bank cache or its lease.
    assert!(
        market_data::claim(&h.pool, Source::Fed)
            .await
            .unwrap()
            .is_some()
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn relative_retry_after_is_anchored_to_database_time_not_skewed_instance_time() {
    let h = Harness::new().await;
    for skew_hours in [-6, 6] {
        h.due(Source::GdeltMarkets).await;
        let database_before: chrono::DateTime<Utc> = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        let instance_time = database_before + Duration::hours(skew_hours);
        // The old worker-side conversion would create this early/late deadline.
        // A delta header is now passed intact to completion, without that clock.
        let wrong_instance_deadline = instance_time + Duration::hours(2);
        let lease = market_data::claim(&h.pool, Source::GdeltMarkets)
            .await
            .unwrap()
            .unwrap();
        market_data::complete(
            &h.pool,
            lease,
            Err(FetchError::RateLimited(Some(
                market_data::RetryAfter::Delay(Duration::hours(2)),
            ))),
        )
        .await
        .unwrap();
        let (retry_at,database_after):(chrono::DateTime<Utc>,chrono::DateTime<Utc>)=sqlx::query_as("SELECT next_attempt_at,clock_timestamp() FROM market_news_provider_state WHERE id='gdelt'").fetch_one(&h.pool).await.unwrap();
        assert!(retry_at >= database_before + Duration::hours(2));
        assert!(retry_at <= database_after + Duration::hours(2));
        assert!(
            (retry_at - wrong_instance_deadline).num_hours().abs() >= 5,
            "the skewed process clock did not select the durable deadline"
        );
        assert!(
            market_data::claim(&h.pool, Source::GdeltCrypto)
                .await
                .unwrap()
                .is_none()
        );
    }
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn failure_preserves_last_success_and_expired_content_is_omitted() {
    let h = Harness::new().await;
    let first = market_data::claim(&h.pool, Source::Ecb)
        .await
        .unwrap()
        .unwrap();
    market_data::complete(
        &h.pool,
        first,
        Ok(FetchResult::Modified(
            vec![sample(Source::Ecb, "saved")],
            Validators::default(),
        )),
    )
    .await
    .unwrap();
    let saved = market_data::read_news(&h.pool, Topic::CentralBanks)
        .await
        .unwrap()
        .sources[1]
        .last_success_at;
    h.due(Source::Ecb).await;
    let lease = market_data::claim(&h.pool, Source::Ecb)
        .await
        .unwrap()
        .unwrap();
    market_data::complete(&h.pool, lease, Err(FetchError::InvalidData))
        .await
        .unwrap();
    let result = market_data::read_news(&h.pool, Topic::CentralBanks)
        .await
        .unwrap();
    assert_eq!(result.records[0].title, "saved");
    assert_eq!(result.status, "stale");
    assert_eq!(result.sources[1].last_success_at, saved);
    sqlx::query("UPDATE market_news_sources SET last_success_at=clock_timestamp()-interval '25 hours' WHERE id='ecb'").execute(&h.pool).await.unwrap();
    let result = market_data::read_news(&h.pool, Topic::CentralBanks)
        .await
        .unwrap();
    assert!(result.records.is_empty());
    assert_eq!(result.status, "unavailable");
    let stored: serde_json::Value =
        sqlx::query_scalar("SELECT records FROM market_news_sources WHERE id='ecb'")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(
        stored[0]["title"], "saved",
        "expiry is presentation policy, not destructive cleanup"
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn not_modified_requires_an_existing_cache_and_keeps_article_time() {
    let h = Harness::new().await;
    let lease = market_data::claim(&h.pool, Source::Fed)
        .await
        .unwrap()
        .unwrap();
    market_data::complete(&h.pool, lease, Ok(FetchResult::NotModified))
        .await
        .unwrap();
    let first = market_data::read_news(&h.pool, Topic::Fed).await.unwrap();
    assert_eq!(first.status, "unavailable");
    assert_eq!(first.sources[0].error_code.as_deref(), Some("invalid_data"));
    h.due(Source::Fed).await;
    let article = sample(Source::Fed, "policy");
    let published = article.published_at;
    let lease = market_data::claim(&h.pool, Source::Fed)
        .await
        .unwrap()
        .unwrap();
    market_data::complete(
        &h.pool,
        lease,
        Ok(FetchResult::Modified(
            vec![article],
            Validators {
                etag: Some("\"v1\"".into()),
                last_modified: None,
            },
        )),
    )
    .await
    .unwrap();
    h.due(Source::Fed).await;
    let lease = market_data::claim(&h.pool, Source::Fed)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.validators.etag.as_deref(), Some("\"v1\""));
    market_data::complete(&h.pool, lease, Ok(FetchResult::NotModified))
        .await
        .unwrap();
    let result = market_data::read_news(&h.pool, Topic::Fed).await.unwrap();
    assert_eq!(result.status, "ready");
    assert_eq!(result.records[0].published_at, published);
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn aborted_collection_expires_then_recovers_without_replaying_for_readers() {
    let h = Harness::new().await;
    let lease = market_data::claim(&h.pool, Source::GdeltMarkets)
        .await
        .unwrap()
        .unwrap();
    // Equivalent durable state to a killed worker: no completion has been written.
    assert!(
        market_data::claim(&h.pool, Source::GdeltTechnology)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE market_news_sources SET lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id='gdelt_markets'").execute(&h.pool).await.unwrap();
    sqlx::query("UPDATE market_news_provider_state SET lease_expires_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second'").execute(&h.pool).await.unwrap();
    let next = market_data::claim(&h.pool, Source::GdeltTechnology)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !market_data::complete(&h.pool, lease, Err(FetchError::Timeout))
            .await
            .unwrap()
    );
    market_data::complete(
        &h.pool,
        next,
        Ok(FetchResult::Modified(vec![], Validators::default())),
    )
    .await
    .unwrap();
    assert_eq!(
        market_data::read_news(&h.pool, Topic::Technology)
            .await
            .unwrap()
            .status,
        "ready"
    );
    h.finish().await;
}

struct PendingFetcher {
    started: tokio::sync::Notify,
    dropped: Arc<AtomicBool>,
}
struct DropMark(Arc<AtomicBool>);
impl Drop for DropMark {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}
impl FeedFetcher for PendingFetcher {
    fn fetch<'a>(
        &'a self,
        _: Source,
        _: Validators,
    ) -> Pin<Box<dyn Future<Output = Result<FetchResult, FetchError>> + Send + 'a>> {
        Box::pin(async move {
            let _guard = DropMark(self.dropped.clone());
            self.started.notify_one();
            std::future::pending().await
        })
    }
}
#[tokio::test]
#[ignore = "requires dedicated PostgreSQL; no real upstream"]
async fn cancelling_an_inflight_worker_drops_transport_and_leaves_a_finite_lease() {
    let h = Harness::new().await;
    let fetcher = Arc::new(PendingFetcher {
        started: tokio::sync::Notify::new(),
        dropped: Arc::new(AtomicBool::new(false)),
    });
    let worker_fetcher = fetcher.clone();
    let pool = h.pool.clone();
    let worker = tokio::spawn(async move {
        market_data::refresh_source(&pool, Source::Fed, worker_fetcher.as_ref()).await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        fetcher.started.notified(),
    )
    .await
    .unwrap();
    worker.abort();
    let _ = worker.await;
    assert!(fetcher.dropped.load(Ordering::SeqCst));
    let expiry: chrono::DateTime<Utc> =
        sqlx::query_scalar("SELECT lease_expires_at FROM market_news_sources WHERE id='fed'")
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(expiry > Utc::now() && expiry < Utc::now() + Duration::seconds(61));
    assert!(
        market_data::claim(&h.pool, Source::Fed)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        market_data::read_news(&h.pool, Topic::Fed)
            .await
            .unwrap()
            .records
            .is_empty()
    );
    sqlx::query("UPDATE market_news_sources SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='fed'").execute(&h.pool).await.unwrap();
    assert!(
        market_data::claim(&h.pool, Source::Fed)
            .await
            .unwrap()
            .is_some()
    );
    h.finish().await;
}
