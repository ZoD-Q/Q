//! Isolated PostgreSQL + loopback provider only. No paid supplier request or business database.
#![cfg(feature = "payments-test-fixtures")]
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use md5::{Digest, Md5};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use tokio::sync::Mutex;
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, account_lifecycle, app,
    payments::{
        PaymentPolicy, PaymentRuntime, RateSnapshot,
        jobs::{self, Outcome},
        qixiang::{PaidConfirmation, QixiangClient, QixiangConfig},
    },
};

#[derive(Default)]
struct Vendor {
    creates: AtomicUsize,
    queries: AtomicUsize,
    paid: AtomicBool,
    reject_create: AtomicBool,
    orders: Mutex<BTreeMap<String, String>>,
    endtime: Mutex<Option<String>>,
}
async fn provider_handler(
    State(v): State<Arc<Vendor>>,
    request: Request<Body>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(request.method(), "POST");
    assert!(!request.uri().to_string().contains("fixture-secret"));
    let path = request.uri().path().to_owned();
    let body = to_bytes(request.into_body(), 16384).await.unwrap();
    let params: BTreeMap<String, String> = form_urlencoded::parse(&body).into_owned().collect();
    let no = &params["out_trade_no"];
    let trade = format!("t{no}");
    if path == "/mapi.php" {
        v.creates.fetch_add(1, Ordering::SeqCst);
        assert!(!params.contains_key("key"));
        v.orders
            .lock()
            .await
            .insert(no.clone(), params["money"].clone());
        if v.reject_create.load(Ordering::SeqCst) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"untrusted":"not logged"})),
            );
        }
        (
            StatusCode::OK,
            Json(json!({"code":1,"trade_no":trade,"payurl":"https://api.payqixiang.cn/pay/test/"})),
        )
    } else {
        assert_eq!(path, "/api.php");
        assert_eq!(params["key"], "fixture-secret");
        v.queries.fetch_add(1, Ordering::SeqCst);
        let orders = v.orders.lock().await;
        let Some(money) = orders.get(no) else {
            return (StatusCode::OK, Json(json!({"code":-1})));
        };
        let mut body = json!({"code":1,"pid":1001,"out_trade_no":no,"trade_no":trade,"type":"wxpay","money":money,"status":if v.paid.load(Ordering::SeqCst){1}else{0}});
        if let Some(endtime) = v.endtime.lock().await.as_ref() {
            body["endtime"] = json!(endtime)
        }
        (StatusCode::OK, Json(body))
    }
}
struct Harness {
    pool: PgPool,
    admin: PgPool,
    schema: String,
    state: AppState,
    router: Router,
    vendor: Arc<Vendor>,
    server: tokio::task::JoinHandle<()>,
    origin: String,
    user: Uuid,
    maker: Uuid,
    checker: Uuid,
    token: String,
    maker_token: String,
    checker_token: String,
}
impl Harness {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("Dedicated PostgreSQL test URL required");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_payment_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .after_connect(move |c, _| {
                let path = path.clone();
                Box::pin(async move {
                    sqlx::query(&path).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let state = AppState::new(pool.clone()).await.unwrap();
        let router = app(state.clone(), vec![]);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let vendor = Arc::new(Vendor::default());
        let fixture = Router::new()
            .fallback(provider_handler)
            .with_state(vendor.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, fixture).await.unwrap();
        });
        let mut h = Self {
            pool,
            admin,
            schema,
            state,
            router,
            vendor,
            server,
            origin,
            user: Uuid::nil(),
            maker: Uuid::nil(),
            checker: Uuid::nil(),
            token: String::new(),
            maker_token: String::new(),
            checker_token: String::new(),
        };
        let (token, user) = h.register("payer").await;
        let (maker_token, maker) = h.register("maker").await;
        let (checker_token, checker) = h.register("checker").await;
        h.user = user;
        h.token = token;
        h.maker = maker;
        h.maker_token = maker_token;
        h.checker = checker;
        h.checker_token = checker_token;
        h.configure().await;
        h
    }
    async fn configure(&mut self) {
        let config = QixiangConfig::new(
            "1001".into(),
            "fixture-secret".into(),
            "https://q.example/notify",
            "https://q.example/return",
        )
        .unwrap();
        let client = QixiangClient::with_test_fixture(config, &self.origin).unwrap();
        let now = Utc::now();
        let policy = PaymentPolicy {
            rate: RateSnapshot {
                rate_cny_per_100_hkd: "91.12345678".into(),
                rate_source: "Explicit test fixture".into(),
                rate_source_url: "https://example.test/rates".into(),
                rate_source_date: now.format("%Y-%m-%d").to_string(),
                rate_at: now - Duration::seconds(1),
                rate_fetched_at: now,
                rate_evidence_sha256: "a".repeat(64),
            },
            fee_basis_points: 250,
            min_credit_amount_minor_hkd: 1,
            max_credit_amount_minor_hkd: 100_000_000,
            quote_ttl_seconds: 300,
            checkout_ttl_seconds: 600,
            rate_max_age_seconds: 86400,
            provider_utc_offset_seconds: None,
            makers: BTreeSet::from([self.maker]),
            checkers: BTreeSet::from([self.maker, self.checker]),
        };
        self.state.payments = Some(Arc::new(
            PaymentRuntime::new(client, "1001".into(), policy).unwrap(),
        ));
        xiaoq_backend::payments::operator::sync_operator_policy(
            &self.pool,
            self.state.payments.as_deref().unwrap(),
        )
        .await
        .unwrap();
        self.router = app(self.state.clone(), vec![]);
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"))
        }
        if body.is_some() {
            request = request.header("content-type", "application/json")
        }
        let response = self
            .router
            .clone()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(""),
            if path.starts_with("/v1/payments") {
                "no-store"
            } else {
                ""
            }
        );
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8(bytes.to_vec()).unwrap()));
        (status, value)
    }
    async fn register(&self, handle: &str) -> (String, Uuid) {
        let (status, body) = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({"handle":handle,"password":"TestPassword123!","display_name":handle})),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["token"].as_str().unwrap().into(),
            body["user"]["id"].as_str().unwrap().parse().unwrap(),
        )
    }
    async fn quote(&self) -> Value {
        let (s, v) = self
            .request(
                "POST",
                "/v1/payments/quotes",
                Some(&self.token),
                Some(json!({"channel":"wechat","credit_amount_minor_hkd":10000})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn order(&self) -> Value {
        let quote = self.quote().await;
        let (s, v) = self
            .request(
                "POST",
                "/v1/payments/orders",
                Some(&self.token),
                Some(json!({"quote_id":quote["quote_id"],"client_request_id":Uuid::new_v4()})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn tick(&self) {
        sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()")
            .execute(&self.pool)
            .await
            .unwrap();
        let r = self.state.payments.as_ref().unwrap();
        let claim = jobs::claim(&self.pool, r).await.unwrap().expect("due job");
        let outcome = jobs::execute(r, &claim).await;
        assert!(
            jobs::finalize(&self.pool, r, &claim, outcome)
                .await
                .unwrap()
        );
    }
    async fn detail(&self, id: &str) -> Value {
        let (s, v) = self
            .request(
                "GET",
                &format!("/v1/payments/orders/{id}"),
                Some(&self.token),
                None,
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn mark_paid(&self) {
        self.vendor.paid.store(true, Ordering::SeqCst);
        *self.vendor.endtime.lock().await = Some(Utc::now().to_rfc3339());
        self.tick().await;
    }
    async fn count(&self, table: &str) -> i64 {
        assert!(!table.chars().any(|c| !c.is_ascii_lowercase() && c != '_'));
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.server.abort();
        self.pool.close().await;
        assert!(self.schema.starts_with("q_payment_test_"));
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
fn notify_query(no: &str, money: &str) -> String {
    let mut fields = BTreeMap::from([
        ("pid".to_owned(), "1001".to_owned()),
        ("out_trade_no".into(), no.into()),
        ("trade_no".into(), format!("t{no}")),
        ("type".into(), "wxpay".into()),
        ("name".into(), "Deposit".into()),
        ("money".into(), money.into()),
        ("trade_status".into(), "TRADE_SUCCESS".into()),
    ]);
    let canonical = fields
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
        + "fixture-secret";
    fields.insert(
        "sign".into(),
        format!("{:x}", Md5::digest(canonical.as_bytes())),
    );
    fields.insert("sign_type".into(), "MD5".into());
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish()
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn missing_config_zero_wallet_and_owner_isolation() {
    let mut h = Harness::new().await;
    h.state.payments = None;
    h.router = app(h.state.clone(), vec![]);
    let (s, v) = h
        .request("GET", "/v1/payments/wallet", Some(&h.token), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["balance_minor"], 0);
    assert_eq!(v["currency"], "HKD");
    let (s, v) = h
        .request("GET", "/v1/payments/capabilities", Some(&h.token), None)
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["enabled"], false);
    assert_eq!(v["fee_basis_points"], Value::Null);
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/quotes",
            Some(&h.token),
            Some(json!({"channel":"wechat","credit_amount_minor_hkd":10000}))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(h.count("real_hkd_entries").await, 0);
    assert_eq!(h.count("bank_demo_entries").await, 0);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn full_flow_callback_is_hint_two_people_credit_once_and_demo_unchanged() {
    let h = Harness::new().await;
    let demo: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT id,balance_minor FROM ledger_accounts ORDER BY id")
            .fetch_all(&h.pool)
            .await
            .unwrap();
    let quote = h.quote().await;
    let request = json!({"quote_id":quote["quote_id"],"client_request_id":Uuid::new_v4()});
    let (a, b) = tokio::join!(
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(request.clone())
        ),
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(request.clone())
        )
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(a.1["payment_id"], b.1["payment_id"]);
    assert_eq!(h.count("payment_orders").await, 1);
    let id = a.1["payment_id"].as_str().unwrap();
    let mut changed = request;
    changed["quote_id"] = json!(Uuid::new_v4());
    assert_eq!(
        h.request("POST", "/v1/payments/orders", Some(&h.token), Some(changed))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.request(
            "GET",
            &format!("/v1/payments/orders/{id}"),
            Some(&h.maker_token),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    h.tick().await;
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 1);
    let no: String = sqlx::query_scalar("SELECT merchant_no FROM payment_orders WHERE id=$1")
        .bind(id.parse::<Uuid>().unwrap())
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let raw = notify_query(&no, "93.41");
    let path = format!("/v1/payments/qixiang/notify?{raw}");
    assert_eq!(
        h.request("GET", &path, None, None).await,
        (StatusCode::OK, json!("success"))
    );
    let reversed = raw.split('&').rev().collect::<Vec<_>>().join("&");
    assert_eq!(
        h.request(
            "GET",
            &format!("/v1/payments/qixiang/notify?{reversed}"),
            None,
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(h.count("payment_notifications").await, 1);
    assert_eq!(h.count("real_hkd_entries").await, 0);
    assert_eq!(
        h.request("GET", &(path + "&unknown=x"), None, None).await.0,
        StatusCode::BAD_REQUEST
    );
    h.tick().await;
    assert_eq!(h.count("real_hkd_entries").await, 0);
    h.mark_paid().await;
    let order = h.detail(id).await;
    assert_eq!(order["status"], "awaiting_credit_approval");
    let version = order["evidence_version"].clone();
    let proposal_path = format!("/v1/payments/orders/{id}/proposals");
    let approval_path = format!("/v1/payments/orders/{id}/approvals");
    assert_eq!(
        h.request(
            "POST",
            &proposal_path,
            Some(&h.token),
            Some(json!({"evidence_version":version}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, p) = h
        .request(
            "POST",
            &proposal_path,
            Some(&h.maker_token),
            Some(json!({"evidence_version":version})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{p}");
    let approval = json!({"proposal_id":p["proposal_id"],"evidence_version":version});
    assert_eq!(
        h.request(
            "POST",
            &approval_path,
            Some(&h.maker_token),
            Some(approval.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (a, b) = tokio::join!(
        h.request(
            "POST",
            &approval_path,
            Some(&h.checker_token),
            Some(approval.clone())
        ),
        h.request(
            "POST",
            &approval_path,
            Some(&h.checker_token),
            Some(approval)
        )
    );
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(h.count("real_hkd_transactions").await, 1);
    assert_eq!(h.count("real_hkd_entries").await, 2);
    assert_eq!(h.count("payment_approvals").await, 1);
    assert_eq!(
        h.request("GET", "/v1/payments/wallet", Some(&h.token), None)
            .await
            .1["balance_minor"],
        10000
    );
    let sum: i64 = sqlx::query_scalar("SELECT sum(delta_minor)::bigint FROM real_hkd_entries")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(sum, 0);
    let after: Vec<(Uuid, i64)> =
        sqlx::query_as("SELECT id,balance_minor FROM ledger_accounts ORDER BY id")
            .fetch_all(&h.pool)
            .await
            .unwrap();
    assert_eq!(demo, after);
    assert!(
        sqlx::query("UPDATE real_hkd_entries SET delta_minor=1")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM real_hkd_transactions")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE payment_quotes SET pay_minor=1")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert_eq!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .err()
            .unwrap()
            .code,
        "PAYMENT_ACCOUNT_UNRESOLVED"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn durable_once_send_unknown_queries_original_and_lease_fences_stale_results() {
    let h = Harness::new().await;
    let order = h.order().await;
    let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
    let runtime = h.state.payments.as_ref().unwrap();
    let claim = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
    assert!(claim.create);
    assert!(jobs::claim(&h.pool, runtime).await.unwrap().is_none());
    // Simulate a crash after the durable may-have-sent mark, without sending the request.
    sqlx::query("UPDATE payment_jobs SET leased_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE payment_id=$1").bind(id).execute(&h.pool).await.unwrap();
    let replacement = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
    assert!(!replacement.create);
    assert!(replacement.epoch > claim.epoch);
    assert!(
        !jobs::finalize(&h.pool, runtime, &claim, Outcome::Unpaid)
            .await
            .unwrap()
    );
    assert!(
        jobs::finalize(&h.pool, runtime, &replacement, Outcome::Unknown)
            .await
            .unwrap()
    );
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp() WHERE payment_id=$1")
        .bind(id)
        .execute(&h.pool)
        .await
        .unwrap();
    let claim = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
    assert!(!claim.create);
    let (s, _) = h
        .request(
            "POST",
            &format!("/v1/payments/orders/{id}/detach"),
            Some(&h.token),
            Some(json!({"acknowledge_old_payment_may_complete":true})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert!(
        !jobs::finalize(
            &h.pool,
            runtime,
            &claim,
            Outcome::Paid(PaidConfirmation {
                merchant_order_no: claim.order.merchant_no.clone(),
                provider_trade_no: "late-stale".into(),
                amount_minor_cny: 9341,
                provider_paid_at_raw: Some(Utc::now().to_rfc3339())
            })
        )
        .await
        .unwrap()
    );
    assert_eq!(h.count("real_hkd_entries").await, 0);
    assert_eq!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .err()
            .unwrap()
            .code,
        "PAYMENT_ACCOUNT_UNRESOLVED"
    );
    let second = h.order().await;
    assert_ne!(second["payment_id"], order["payment_id"]);
    assert_eq!(h.count("payment_orders").await, 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn paid_time_unknown_suspension_and_wrong_evidence_hold_credit() {
    let h = Harness::new().await;
    let order = h.order().await;
    let id = order["payment_id"].as_str().unwrap();
    h.tick().await;
    h.vendor.paid.store(true, Ordering::SeqCst);
    *h.vendor.endtime.lock().await = Some("2026-11-02 12:00:00".into());
    h.tick().await;
    let detail = h.detail(id).await;
    assert_eq!(detail["status"], "review_required");
    assert_eq!(detail["error_code"], "PAYMENT_TIME_REVIEW");
    let path = format!("/v1/payments/orders/{id}/proposals");
    assert_eq!(
        h.request(
            "POST",
            &path,
            Some(&h.maker_token),
            Some(json!({"evidence_version":detail["evidence_version"]}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.count("real_hkd_entries").await, 0);
    let (s, _) = h
        .request(
            "POST",
            &format!("/v1/payments/orders/{id}/detach"),
            Some(&h.token),
            Some(json!({"acknowledge_old_payment_may_complete":true})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let order = h.order().await;
    let id = order["payment_id"].as_str().unwrap();
    h.tick().await;
    account_lifecycle::operator_status(&h.pool, h.user, true)
        .await
        .unwrap();
    h.mark_paid().await;
    let state: (String, Option<Vec<u8>>) =
        sqlx::query_as("SELECT status,evidence_hash FROM payment_orders WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(state.0, "review_required");
    assert!(state.1.is_some());
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/orders/{id}/proposals"),
            Some(&h.maker_token),
            Some(json!({"evidence_version":1}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.count("real_hkd_entries").await, 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn wrong_token_expired_lease_and_changed_order_version_cannot_finalize() {
    let h = Harness::new().await;
    let value = h.order().await;
    let id: Uuid = value["payment_id"].as_str().unwrap().parse().unwrap();
    let runtime = h.state.payments.as_ref().unwrap();
    let claim = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
    let mut forged = claim.clone();
    forged.token = Uuid::new_v4();
    assert!(
        !jobs::finalize(&h.pool, runtime, &forged, Outcome::Unpaid)
            .await
            .unwrap()
    );
    sqlx::query("UPDATE payment_jobs SET leased_until=clock_timestamp()-interval '1 second' WHERE payment_id=$1").bind(id).execute(&h.pool).await.unwrap();
    assert!(
        !jobs::finalize(&h.pool, runtime, &claim, Outcome::Unpaid)
            .await
            .unwrap()
    );
    let replacement = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
    assert!(!replacement.create);
    sqlx::query("UPDATE payment_orders SET error_code='VERSION_FENCE_TEST',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&h.pool).await.unwrap();
    assert!(
        !jobs::finalize(&h.pool, runtime, &replacement, Outcome::Unpaid)
            .await
            .unwrap()
    );
    let token: Option<Uuid> =
        sqlx::query_scalar("SELECT token FROM payment_jobs WHERE payment_id=$1")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(token.is_none());
    assert_eq!(
        h.detail(&id.to_string()).await["error_code"],
        "VERSION_FENCE_TEST"
    );
    sqlx::query("UPDATE payment_orders SET status='expired',version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id).execute(&h.pool).await.unwrap();
    assert_eq!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .err()
            .unwrap()
            .code,
        "PAYMENT_ACCOUNT_UNRESOLVED"
    );
    h.tick().await;
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    assert_eq!(h.count("real_hkd_entries").await, 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn policy_change_invalidates_unused_quote_but_missing_configuration_preserves_original_replay()
 {
    let mut h = Harness::new().await;
    let original = h.order().await;
    let unused = h.quote().await;
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.rate.rate_cny_per_100_hkd = "92".into();
    // A public rate refresh preserves accepted quotes; changing the business fee does not.
    policy.fee_basis_points += 1;
    let config = QixiangConfig::new(
        "1001".into(),
        "fixture-secret".into(),
        "https://q.example/notify",
        "https://q.example/return",
    )
    .unwrap();
    let client = QixiangClient::with_test_fixture(config, &h.origin).unwrap();
    h.state.payments = Some(Arc::new(
        PaymentRuntime::new(client, "1001".into(), policy).unwrap(),
    ));
    h.router = app(h.state.clone(), vec![]);
    let (status, value) = h
        .request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(json!({"quote_id":unused["quote_id"],"client_request_id":Uuid::new_v4()})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(value["error"]["code"], "PAYMENT_QUOTE_CHANGED");
    let after = h.detail(original["payment_id"].as_str().unwrap()).await;
    assert_eq!(
        after["pay_amount_minor_cny"],
        original["pay_amount_minor_cny"]
    );
    assert_eq!(after["rate_cny_per_100_hkd"], "91.12345678");
    h.state.payments = None;
    h.router = app(h.state.clone(), vec![]);
    let(status,replayed)=h.request("POST","/v1/payments/orders",Some(&h.token),Some(json!({"quote_id":original["quote_id"],"client_request_id":original["client_request_id"]}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["payment_id"], original["payment_id"]);
    assert_eq!(h.count("payment_orders").await, 1);
    h.finish().await;
}

#[derive(Debug, PartialEq, Eq, sqlx::FromRow)]
struct LeaseSnapshot {
    next_attempt_at: chrono::DateTime<Utc>,
    epoch: i64,
    token: Option<Uuid>,
    leased_until: Option<chrono::DateTime<Utc>>,
    captured_version: Option<i64>,
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn duplicate_signed_notifications_preserve_query_backoff_and_lease() {
    let h = Harness::new().await;
    let order = h.order().await;
    let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
    h.tick().await;
    let no: String = sqlx::query_scalar("SELECT merchant_no FROM payment_orders WHERE id=$1")
        .bind(id)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    let path = format!("/v1/payments/qixiang/notify?{}", notify_query(&no, "93.41"));
    assert_eq!(h.request("GET", &path, None, None).await.0, StatusCode::OK);
    sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()+interval '1 hour',token=$2,leased_until=clock_timestamp()+interval '60 seconds',captured_version=(SELECT version FROM payment_orders WHERE id=$1) WHERE payment_id=$1").bind(id).bind(Uuid::new_v4()).execute(&h.pool).await.unwrap();
    let before: LeaseSnapshot =
        sqlx::query_as("SELECT next_attempt_at,epoch,token,leased_until,captured_version FROM payment_jobs WHERE payment_id=$1")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    for _ in 0..20 {
        assert_eq!(h.request("GET", &path, None, None).await.0, StatusCode::OK);
    }
    let after: LeaseSnapshot =
        sqlx::query_as("SELECT next_attempt_at,epoch,token,leased_until,captured_version FROM payment_jobs WHERE payment_id=$1")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
    assert_eq!(h.count("payment_notifications").await, 1);
    assert!(
        jobs::claim(&h.pool, h.state.payments.as_ref().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(h.vendor.queries.load(Ordering::SeqCst), 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn never_sent_detachment_resolves_but_racing_mark_sent_preserves_obligation() {
    let h = Harness::new().await;
    let order = h.order().await;
    let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
    let path = format!("/v1/payments/orders/{id}/detach");
    let (_, cancelled) = h
        .request(
            "POST",
            &path,
            Some(&h.token),
            Some(json!({"acknowledge_old_payment_may_complete":true})),
        )
        .await;
    assert_eq!(cancelled["payment"]["status"], "failed");
    assert_eq!(cancelled["payment"]["error_code"], "not_created");
    assert_eq!(cancelled["payment"]["terminal"], true);
    assert_eq!(h.count("payment_jobs").await, 0);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    assert!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .is_ok()
    );
    h.finish().await;
    let h = Harness::new().await;
    let order = h.order().await;
    let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
    let runtime = h.state.payments.as_ref().unwrap();
    let path = format!("/v1/payments/orders/{id}/detach");
    let (claimed, detached) = tokio::join!(
        jobs::claim(&h.pool, runtime),
        h.request(
            "POST",
            &path,
            Some(&h.token),
            Some(json!({"acknowledge_old_payment_may_complete":true}))
        )
    );
    assert_eq!(detached.0, StatusCode::OK);
    let sent: Option<chrono::DateTime<Utc>> =
        sqlx::query_scalar("SELECT may_have_sent_at FROM payment_orders WHERE id=$1")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    if let Some(claim) = claimed.unwrap() {
        assert!(sent.is_some());
        assert!(
            !jobs::finalize(&h.pool, runtime, &claim, Outcome::Unpaid)
                .await
                .unwrap()
        );
        assert_eq!(
            account_lifecycle::operator_delete(&h.pool, h.user)
                .await
                .err()
                .unwrap()
                .code,
            "PAYMENT_ACCOUNT_UNRESOLVED"
        );
    } else {
        assert!(sent.is_none());
        assert_eq!(h.detail(&id.to_string()).await["error_code"], "not_created");
        assert!(
            account_lifecycle::operator_delete(&h.pool, h.user)
                .await
                .is_ok()
        );
    }
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    h.finish().await;
}

fn provider_version(
    origin: &str,
    version: &str,
    pid: &str,
    key: &str,
) -> xiaoq_backend::payments::config::ProviderVersion {
    let config = QixiangConfig::new(
        pid.into(),
        key.into(),
        "https://q.example/notify",
        "https://q.example/return",
    )
    .unwrap();
    xiaoq_backend::payments::config::ProviderVersion {
        version: version.into(),
        merchant_id: pid.into(),
        client: QixiangClient::with_test_fixture(config, origin).unwrap(),
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn credential_rotation_same_and_different_merchant_uses_persisted_version() {
    for new_pid in ["1001", "2002"] {
        let mut h = Harness::new().await;
        let order = h.order().await;
        let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
        h.tick().await;
        let no: String = sqlx::query_scalar("SELECT merchant_no FROM payment_orders WHERE id=$1")
            .bind(id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
        let policy = h.state.payments.as_ref().unwrap().policy.clone();
        h.state.payments = Some(Arc::new(
            PaymentRuntime::new_versioned(
                vec![
                    provider_version(&h.origin, "fixture-v1", "1001", "fixture-secret"),
                    provider_version(&h.origin, "v2", new_pid, "rotated-secret"),
                ],
                "v2".into(),
                policy.clone(),
            )
            .unwrap(),
        ));
        h.router = app(h.state.clone(), vec![]);
        let path = format!("/v1/payments/qixiang/notify?{}", notify_query(&no, "93.41"));
        assert_eq!(h.request("GET", &path, None, None).await.0, StatusCode::OK);
        h.mark_paid().await;
        assert_eq!(
            h.detail(&id.to_string()).await["status"],
            "awaiting_credit_approval"
        );
        assert_eq!(h.vendor.queries.load(Ordering::SeqCst), 1);
        assert!(
            sqlx::query(
                "UPDATE payment_orders SET credential_version='v2',version=version+1 WHERE id=$1"
            )
            .bind(id)
            .execute(&h.pool)
            .await
            .is_err()
        );
        h.state.payments = Some(Arc::new(
            PaymentRuntime::new_versioned(
                vec![provider_version(&h.origin, "v2", new_pid, "rotated-secret")],
                "v2".into(),
                policy,
            )
            .unwrap(),
        ));
        h.router = app(h.state.clone(), vec![]);
        assert_eq!(
            h.request("GET", &path, None, None).await.0,
            StatusCode::BAD_REQUEST
        );
        h.finish().await;
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn seventeen_unavailable_credential_jobs_do_not_starve_valid_new_order() {
    let mut h = Harness::new().await;
    for _ in 0..17 {
        let order = h.order().await;
        let id: Uuid = order["payment_id"].as_str().unwrap().parse().unwrap();
        let runtime = h.state.payments.as_ref().unwrap();
        let claim = jobs::claim(&h.pool, runtime).await.unwrap().unwrap();
        assert!(claim.create);
        assert!(
            jobs::finalize(&h.pool, runtime, &claim, Outcome::Unknown)
                .await
                .unwrap()
        );
        let path = format!("/v1/payments/orders/{id}/detach");
        assert_eq!(
            h.request(
                "POST",
                &path,
                Some(&h.token),
                Some(json!({"acknowledge_old_payment_may_complete":true}))
            )
            .await
            .0,
            StatusCode::OK
        );
        sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()+interval '1 hour'")
            .execute(&h.pool)
            .await
            .unwrap();
    }
    let policy = h.state.payments.as_ref().unwrap().policy.clone();
    h.state.payments = Some(Arc::new(
        PaymentRuntime::new_versioned(
            vec![provider_version(&h.origin, "v2", "2002", "rotated-secret")],
            "v2".into(),
            policy,
        )
        .unwrap(),
    ));
    h.router = app(h.state.clone(), vec![]);
    let new = h.order().await;
    let id: Uuid = new["payment_id"].as_str().unwrap().parse().unwrap();
    sqlx::query("UPDATE payment_jobs SET next_attempt_at=clock_timestamp()-interval '1 hour' WHERE payment_id<>$1").bind(id).execute(&h.pool).await.unwrap();
    let claim = jobs::claim(&h.pool, h.state.payments.as_ref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.order.id, id);
    assert!(claim.create);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn expired_never_sent_checkout_is_provably_not_created_and_can_delete() {
    let mut h = Harness::new().await;
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.checkout_ttl_seconds = 1;
    let config = QixiangConfig::new(
        "1001".into(),
        "fixture-secret".into(),
        "https://q.example/notify",
        "https://q.example/return",
    )
    .unwrap();
    h.state.payments = Some(Arc::new(
        PaymentRuntime::new(
            QixiangClient::with_test_fixture(config, &h.origin).unwrap(),
            "1001".into(),
            policy,
        )
        .unwrap(),
    ));
    h.router = app(h.state.clone(), vec![]);
    let order = h.order().await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert!(
        jobs::claim(&h.pool, h.state.payments.as_ref().unwrap())
            .await
            .unwrap()
            .is_none()
    );
    let detail = h.detail(order["payment_id"].as_str().unwrap()).await;
    assert_eq!(detail["error_code"], "not_created");
    assert_eq!(detail["terminal"], true);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    assert_eq!(h.count("payment_jobs").await, 0);
    assert!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .is_ok()
    );
    h.finish().await;
}

#[derive(sqlx::FromRow)]
struct NoCreateReceipt {
    resolved: bool,
    may_have_sent_at: Option<chrono::DateTime<Utc>>,
    merchant_id: String,
    credential_version: String,
    created_at: chrono::DateTime<Utc>,
    checkout_expires_at: chrono::DateTime<Utc>,
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn expired_quote_persists_original_key_no_create_receipt_without_provider_configuration() {
    let mut h = Harness::new().await;
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.quote_ttl_seconds = 1;
    let config = QixiangConfig::new(
        "1001".into(),
        "fixture-secret".into(),
        "https://q.example/notify",
        "https://q.example/return",
    )
    .unwrap();
    h.state.payments = Some(Arc::new(
        PaymentRuntime::new(
            QixiangClient::with_test_fixture(config, &h.origin).unwrap(),
            "1001".into(),
            policy,
        )
        .unwrap(),
    ));
    h.router = app(h.state.clone(), vec![]);
    let quote = h.quote().await;
    let key = Uuid::new_v4();
    let request = json!({"quote_id":quote["quote_id"],"client_request_id":key});
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    h.state.payments = None;
    h.router = app(h.state.clone(), vec![]);
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.maker_token),
            Some(request.clone())
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(h.count("payment_orders").await, 0);
    let (first, second) = tokio::join!(
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(request.clone())
        ),
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(request.clone())
        )
    );
    for response in [&first, &second] {
        assert_eq!(response.0, StatusCode::OK, "{}", response.1);
        assert_eq!(response.1["status"], "failed");
        assert_eq!(response.1["error_code"], "not_created");
        assert_eq!(response.1["terminal"], true);
        assert_eq!(response.1["safe_to_start_new"], true);
        assert_eq!(response.1["checkout_url"], Value::Null);
        assert_eq!(
            response.1["pay_amount_minor_cny"],
            quote["pay_amount_minor_cny"]
        );
    }
    assert_eq!(first.1["payment_id"], second.1["payment_id"]);
    assert_eq!(first.1["created_at"], second.1["created_at"]);
    let id: Uuid = first.1["payment_id"].as_str().unwrap().parse().unwrap();
    let proof:NoCreateReceipt=sqlx::query_as("SELECT resolved,may_have_sent_at,merchant_id,credential_version,created_at,checkout_expires_at FROM payment_orders WHERE id=$1").bind(id).fetch_one(&h.pool).await.unwrap();
    assert!(proof.resolved);
    assert!(proof.may_have_sent_at.is_none());
    assert_eq!(proof.merchant_id, "1001");
    assert_eq!(proof.credential_version, "fixture-v1");
    assert_eq!(proof.created_at, proof.checkout_expires_at);
    assert_eq!(h.count("payment_jobs").await, 0);
    assert_eq!(h.count("payment_checkout_slots").await, 0);
    assert_eq!(h.count("real_hkd_entries").await, 0);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    assert_eq!(
        h.request(
            "GET",
            &format!("/v1/payments/orders/by-client-key/{key}"),
            Some(&h.token),
            None
        )
        .await
        .1["payment_id"],
        first.1["payment_id"]
    );
    assert_eq!(
        h.request("POST", "/v1/payments/orders", Some(&h.token), Some(request))
            .await
            .1["payment_id"],
        first.1["payment_id"]
    );
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(json!({"quote_id":quote["quote_id"],"client_request_id":Uuid::new_v4()}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    h.configure().await;
    let new = h.order().await;
    assert_eq!(new["status"], "creating");
    assert_ne!(new["payment_id"], first.1["payment_id"]);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn expired_quote_already_bound_to_possible_send_is_never_replaced() {
    let mut h = Harness::new().await;
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.quote_ttl_seconds = 1;
    let config = QixiangConfig::new(
        "1001".into(),
        "fixture-secret".into(),
        "https://q.example/notify",
        "https://q.example/return",
    )
    .unwrap();
    h.state.payments = Some(Arc::new(
        PaymentRuntime::new(
            QixiangClient::with_test_fixture(config, &h.origin).unwrap(),
            "1001".into(),
            policy,
        )
        .unwrap(),
    ));
    h.router = app(h.state.clone(), vec![]);
    let order = h.order().await;
    let id = order["payment_id"].as_str().unwrap();
    h.tick().await;
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/orders",
            Some(&h.token),
            Some(json!({"quote_id":order["quote_id"],"client_request_id":Uuid::new_v4()}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.count("payment_orders").await, 1);
    assert_eq!(h.count("payment_jobs").await, 1);
    assert_eq!(h.count("payment_checkout_slots").await, 1);
    let detail = h.detail(id).await;
    assert_eq!(detail["status"], "awaiting_payment");
    assert_eq!(detail["terminal"], false);
    assert_eq!(h.vendor.creates.load(Ordering::SeqCst), 1);
    h.state.payments = None;
    h.router = app(h.state.clone(), vec![]);
    let(s,replay)=h.request("POST","/v1/payments/orders",Some(&h.token),Some(json!({"quote_id":order["quote_id"],"client_request_id":order["client_request_id"]}))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(replay["payment_id"], order["payment_id"]);
    assert_eq!(replay["status"], "awaiting_payment");
    assert_eq!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .err()
            .unwrap()
            .code,
        "PAYMENT_ACCOUNT_UNRESOLVED"
    );
    h.finish().await;
}

fn normalize_openapi_nullable(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                normalize_openapi_nullable(item)
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                normalize_openapi_nullable(item)
            }
            if object.remove("nullable") == Some(Value::Bool(true)) {
                let nonnull = Value::Object(std::mem::take(object));
                *value = json!({"anyOf":[nonnull,{"type":"null"}]});
            }
        }
        _ => {}
    }
}

fn assert_payment_contract(
    schema_name: &str,
    body: &Value,
    samples: &mut BTreeMap<String, Vec<Value>>,
) {
    let mut document: Value =
        serde_json::from_str(include_str!("../contracts/openapi.json")).unwrap();
    normalize_openapi_nullable(&mut document);
    assert!(
        document["components"]["schemas"].get(schema_name).is_some(),
        "Missing concrete {schema_name}"
    );
    let root = json!({"$ref":format!("#/components/schemas/{schema_name}"),"components":document["components"]});
    let validator = jsonschema::options()
        .should_validate_formats(true)
        .build(&root)
        .unwrap();
    let failures = validator
        .iter_errors(body)
        .map(|error| error.to_string())
        .collect::<Vec<_>>();
    assert!(
        failures.is_empty(),
        "{schema_name}: {}\nSynthetic payment body: {body}",
        failures.join("; ")
    );
    samples
        .entry(schema_name.to_owned())
        .or_default()
        .push(body.clone());
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn actual_router_payment_responses_match_concrete_openapi_schemas() {
    let mut h = Harness::new().await;
    let mut samples = BTreeMap::new();
    // Disabled capabilities exercise genuine nullable fields, rather than permissive mocks.
    h.state.payments = None;
    h.router = app(h.state.clone(), vec![]);
    let (status, caps) = h
        .request("GET", "/v1/payments/capabilities", Some(&h.token), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_payment_contract("PaymentCapabilities", &caps, &mut samples);
    h.configure().await;
    for (route, schema) in [
        ("capabilities", "PaymentCapabilities"),
        ("wallet", "PaymentWallet"),
        ("orders/active", "PaymentActiveOrder"),
        ("orders?view=history", "PaymentOrdersPage"),
        ("ledger", "PaymentLedgerPage"),
    ] {
        let (status, body) = h
            .request(
                "GET",
                &format!("/v1/payments/{route}"),
                Some(&h.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_payment_contract(schema, &body, &mut samples);
    }
    let quote = h.quote().await;
    assert_payment_contract("PaymentQuote", &quote, &mut samples);
    let key = Uuid::new_v4();
    let request = json!({"quote_id":quote["quote_id"],"client_request_id":key});
    let (status, created) = h
        .request("POST", "/v1/payments/orders", Some(&h.token), Some(request))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_payment_contract("PaymentOrder", &created, &mut samples);
    let id = created["payment_id"].as_str().unwrap();
    for (path, schema) in [
        (format!("orders/{id}"), "PaymentOrder"),
        (format!("orders/by-client-key/{key}"), "PaymentOrder"),
        ("orders/active".into(), "PaymentActiveOrder"),
        ("orders?view=pending&limit=1".into(), "PaymentOrdersPage"),
    ] {
        let (status, body) = h
            .request("GET", &format!("/v1/payments/{path}"), Some(&h.token), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_payment_contract(schema, &body, &mut samples);
    }
    h.tick().await;
    let checkout = h.detail(id).await;
    assert!(checkout["checkout_url"].is_string());
    assert_payment_contract("PaymentOrder", &checkout, &mut samples);
    let (status, detached) = h
        .request(
            "POST",
            &format!("/v1/payments/orders/{id}/detach"),
            Some(&h.token),
            Some(json!({"acknowledge_old_payment_may_complete":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{detached}");
    assert_payment_contract("PaymentDetachResponse", &detached, &mut samples);
    h.mark_paid().await;
    let verified = h.detail(id).await;
    assert_payment_contract("PaymentOrder", &verified, &mut samples);
    let version = verified["evidence_version"].clone();
    let (status, proposal) = h
        .request(
            "POST",
            &format!("/v1/payments/orders/{id}/proposals"),
            Some(&h.maker_token),
            Some(json!({"evidence_version":version})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{proposal}");
    assert_payment_contract("PaymentProposal", &proposal, &mut samples);
    let (status, approved) = h
        .request(
            "POST",
            &format!("/v1/payments/orders/{id}/approvals"),
            Some(&h.checker_token),
            Some(json!({"proposal_id":proposal["proposal_id"],"evidence_version":version})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "credited");
    assert_payment_contract("PaymentOrder", &approved, &mut samples);
    for (route, schema) in [
        ("wallet", "PaymentWallet"),
        ("ledger?limit=1", "PaymentLedgerPage"),
        ("orders?view=history&limit=1", "PaymentOrdersPage"),
        ("orders/active", "PaymentActiveOrder"),
    ] {
        let (status, body) = h
            .request(
                "GET",
                &format!("/v1/payments/{route}"),
                Some(&h.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_payment_contract(schema, &body, &mut samples);
    }
    // Optional export is an explicit test-only destination. Only validated payment DTOs
    // above enter this map: no login response, Bearer token, provider key or raw callback.
    if let Ok(destination) = std::env::var("TEST_PAYMENT_SAMPLES_PATH") {
        assert!(!destination.is_empty());
        std::fs::write(destination, serde_json::to_vec_pretty(&samples).unwrap()).unwrap();
    }
    h.finish().await;
}
