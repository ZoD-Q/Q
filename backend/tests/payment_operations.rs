//! Isolated PostgreSQL + loopback provider only. No paid supplier request or business database.
#![cfg(feature = "payments-test-fixtures")]
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
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
        jobs::{self},
        qixiang::{QixiangClient, QixiangConfig},
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
        let schema = format!("q_operations_test_{}", Uuid::new_v4().simple());
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
        assert!(self.schema.starts_with("q_operations_test_"));
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

use base64::{Engine, engine::general_purpose::STANDARD};
impl Harness {
    async fn paid(&self) -> Value {
        let order = self.order().await;
        self.tick().await;
        self.mark_paid().await;
        self.detail(order["payment_id"].as_str().unwrap()).await
    }
    async fn propose(&self, order: &Value) -> Value {
        let (s, p) = self
            .request(
                "POST",
                &format!(
                    "/v1/payments/orders/{}/proposals",
                    order["payment_id"].as_str().unwrap()
                ),
                Some(&self.maker_token),
                Some(json!({"evidence_version":order["evidence_version"]})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{p}");
        p
    }
    async fn credit(&self, order: &Value) -> Value {
        let p = self.propose(order).await;
        let(s,v)=self.request("POST",&format!("/v1/payments/orders/{}/approvals",order["payment_id"].as_str().unwrap()),Some(&self.checker_token),Some(json!({"proposal_id":p["proposal_id"],"evidence_version":order["evidence_version"]}))).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn refund(&self, order: &Value) -> Value {
        let(s,v)=self.request("POST",&format!("/v1/payments/operator/orders/{}/refunds",order["payment_id"].as_str().unwrap()),Some(&self.maker_token),Some(json!({"client_request_id":Uuid::new_v4(),"reason":"Full original payment return"}))).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn approve_refund(&self, r: &Value) -> Value {
        let (s, v) = self
            .request(
                "POST",
                &format!(
                    "/v1/payments/operator/refunds/{}/approve",
                    r["refund_id"].as_str().unwrap()
                ),
                Some(&self.checker_token),
                Some(json!({"version":r["version"]})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn attach_refund(&self, r: &Value) -> Value {
        let(s,v)=self.request("POST",&format!("/v1/payments/operator/refunds/{}/evidence",r["refund_id"].as_str().unwrap()),Some(&self.maker_token),Some(json!({"version":r["version"],"evidence_base64":STANDARD.encode(format!("external-original-receipt-{}",r["refund_id"])),"external_reference":format!("receipt-{}",r["refund_id"]),"executed_at":Utc::now(),"notes":"Operator-attached original receipt"}))).await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn finish_refund(&self, r: &Value) -> Value {
        let (s, v) = self
            .request(
                "POST",
                &format!(
                    "/v1/payments/operator/refunds/{}/verify",
                    r["refund_id"].as_str().unwrap()
                ),
                Some(&self.checker_token),
                Some(json!({"version":r["version"],"evidence_sha256":r["evidence_sha256"]})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
    async fn install_policy(&mut self, policy: PaymentPolicy) {
        let prior = self.state.payments.as_deref().unwrap();
        let runtime =
            PaymentRuntime::new(prior.client.clone(), prior.merchant_id.clone(), policy).unwrap();
        xiaoq_backend::payments::operator::sync_operator_policy(&self.pool, &runtime)
            .await
            .unwrap();
        self.state.payments = Some(Arc::new(runtime));
        self.router = app(self.state.clone(), vec![]);
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn operator_scope_queues_evidence_and_durable_audit() {
    let h = Harness::new().await;
    assert_eq!(
        h.request("GET", "/v1/payments/operator/me", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        h.request("GET", "/v1/payments/operator/orders", Some(&h.token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let order = h.order().await;
    let id = order["payment_id"].as_str().unwrap();
    let (s, me) = h
        .request(
            "GET",
            "/v1/payments/operator/me",
            Some(&h.maker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["roles"], json!(["checker", "maker"]));
    let (s, list) = h
        .request(
            "GET",
            "/v1/payments/operator/orders?queue=verification&limit=1",
            Some(&h.maker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{list}");
    assert_eq!(list["items"][0]["payment_id"], order["payment_id"]);
    h.tick().await;
    h.mark_paid().await;
    let paid = h.detail(id).await;
    let (_, list) = h
        .request(
            "GET",
            "/v1/payments/operator/orders?queue=first_review",
            Some(&h.maker_token),
            None,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    let proposal = h.propose(&paid).await;
    let (_, detail) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/orders/{id}"),
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(detail["proposal"]["proposal_id"], proposal["proposal_id"]);
    assert_eq!(detail["evidence_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(detail["audit"][0]["action"], "credit_proposed");
    let (_, list) = h
        .request(
            "GET",
            "/v1/payments/operator/orders?queue=second_review",
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    h.credit(&paid).await;
    let (_, list) = h
        .request(
            "GET",
            "/v1/payments/operator/orders?queue=credited",
            Some(&h.maker_token),
            None,
        )
        .await;
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert_eq!(h.count("payment_operation_audit").await, 2);
    assert!(
        sqlx::query("DELETE FROM payment_operation_audit")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert_eq!(
        h.request(
            "GET",
            "/v1/payments/operator/orders?queue=unknown",
            Some(&h.maker_token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.request(
            "GET",
            "/v1/payments/operator/orders?limit=51",
            Some(&h.maker_token),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn customer_cannot_self_propose_or_approve_even_if_configured_and_database_fences_it() {
    let mut h = Harness::new().await;
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.makers.insert(h.user);
    policy.checkers.insert(h.user);
    h.install_policy(policy).await;
    let order = h.paid().await;
    let id = order["payment_id"].as_str().unwrap();
    let evidence = order["evidence_version"].clone();
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/orders/{id}/proposals"),
            Some(&h.token),
            Some(json!({"evidence_version":evidence}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let proposal = h.propose(&order).await;
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/orders/{id}/approvals"),
            Some(&h.token),
            Some(json!({"proposal_id":proposal["proposal_id"],"evidence_version":evidence}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut tx = h.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO payment_approvals(id,payment_id,proposal_id,maker_id,checker_id,evidence_version,evidence_hash) SELECT $1,$2,$3,$4,$5,evidence_version,evidence_hash FROM payment_orders WHERE id=$2")
 .bind(Uuid::new_v4()).bind(id.parse::<Uuid>().unwrap()).bind(proposal["proposal_id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(h.maker).bind(h.user).execute(&mut *tx).await.unwrap();
    assert!(tx.commit().await.is_err());
    assert_eq!(h.count("real_hkd_transactions").await, 0);
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn full_refund_freezes_then_posts_exact_opposite_once_and_allows_zero_balance_delete() {
    let h = Harness::new().await;
    let order = h.paid().await;
    h.credit(&order).await;
    let refund = h.refund(&order).await;
    let (_, wallet) = h
        .request("GET", "/v1/payments/wallet", Some(&h.token), None)
        .await;
    assert_eq!(wallet["balance_minor"], 10000);
    assert_eq!(wallet["frozen_minor"], 10000);
    assert_eq!(wallet["available_minor"], 0);
    assert!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .is_err()
    );
    let approved = h.approve_refund(&refund).await;
    let evidence = h.attach_refund(&approved).await;
    let finished = h.finish_refund(&evidence).await;
    assert_eq!(finished["status"], "refunded");
    assert_eq!(finished["frozen_minor_hkd"], 0);
    let repeated = h.finish_refund(&evidence).await;
    assert_eq!(repeated["refund_id"], finished["refund_id"]);
    assert_eq!(h.count("real_hkd_transactions").await, 1);
    assert_eq!(h.count("real_hkd_entries").await, 2);
    assert_eq!(h.count("real_hkd_reversals").await, 1);
    assert_eq!(h.count("real_hkd_reversal_entries").await, 2);
    let (_, wallet) = h
        .request("GET", "/v1/payments/wallet", Some(&h.token), None)
        .await;
    assert_eq!(wallet["balance_minor"], 0);
    assert_eq!(wallet["frozen_minor"], 0);
    assert_eq!(wallet["available_minor"], 0);
    let (_, ledger) = h
        .request("GET", "/v1/payments/ledger", Some(&h.token), None)
        .await;
    let entries = ledger["items"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["kind"], "refund_reversal");
    assert_eq!(entries[0]["amount_minor"], -10000);
    assert_eq!(entries[0]["refund_id"], refund["refund_id"]);
    let receipt = h.detail(order["payment_id"].as_str().unwrap()).await;
    assert_eq!(receipt["status"], "credited");
    assert_eq!(receipt["refund_status"], "refunded");
    assert_eq!(receipt["refund_version"], finished["version"]);
    assert!(receipt["refunded_at"].is_string());
    assert!(
        sqlx::query("UPDATE real_hkd_reversal_entries SET delta_minor=1")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .is_ok()
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn uncredited_suspended_customer_refund_preserves_unknown_notes_checks_time_and_resolves_slot()
 {
    let h = Harness::new().await;
    let order = h.paid().await;
    let proposal = h.propose(&order).await;
    let id = order["payment_id"].as_str().unwrap();
    account_lifecycle::operator_status(&h.pool, h.user, true)
        .await
        .unwrap();
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/quotes",
            Some(&h.token),
            Some(json!({"channel":"wechat","credit_amount_minor_hkd":1000}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(h.request("POST",&format!("/v1/payments/orders/{id}/approvals"),Some(&h.checker_token),Some(json!({"proposal_id":proposal["proposal_id"],"evidence_version":order["evidence_version"]}))).await.0,StatusCode::CONFLICT);
    let r = h.refund(&order).await;
    let approved = h.approve_refund(&r).await;
    let(s,unknown)=h.request("POST",&format!("/v1/payments/operator/refunds/{}/unknown",r["refund_id"].as_str().unwrap()),Some(&h.maker_token),Some(json!({"version":approved["version"],"notes":"External return still awaiting confirmation"}))).await;
    assert_eq!(s, StatusCode::OK, "{unknown}");
    assert_eq!(
        unknown["notes"],
        "External return still awaiting confirmation"
    );
    let wrong = json!({"version":unknown["version"],"evidence_base64":STANDARD.encode(b"external receipt"),"external_reference":"unique-reference","executed_at":order["created_at"],"notes":"This timestamp predates refund approval"});
    assert_eq!(
        h.request(
            "POST",
            &format!(
                "/v1/payments/operator/refunds/{}/evidence",
                r["refund_id"].as_str().unwrap()
            ),
            Some(&h.maker_token),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let evidence = h.attach_refund(&unknown).await;
    h.finish_refund(&evidence).await;
    assert_eq!(h.count("real_hkd_transactions").await, 0);
    assert_eq!(h.count("real_hkd_reversals").await, 0);
    assert_eq!(h.count("payment_checkout_slots").await, 0);
    assert_eq!(h.count("payment_jobs").await, 0);
    let row: (String, bool, String) =
        sqlx::query_as("SELECT status,resolved,error_code FROM payment_orders WHERE id=$1")
            .bind(id.parse::<Uuid>().unwrap())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(row, ("failed".into(), true, "refunded".into()));
    assert!(
        account_lifecycle::operator_delete(&h.pool, h.user)
            .await
            .is_ok()
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn approval_races_refund_and_never_credits_an_unreserved_return() {
    let h = Harness::new().await;
    let order = h.paid().await;
    let p = h.propose(&order).await;
    let id = order["payment_id"].as_str().unwrap();
    let refund_request =
        json!({"client_request_id":Uuid::new_v4(),"reason":"Original full return"});
    let approval_path = format!("/v1/payments/orders/{id}/approvals");
    let refund_path = format!("/v1/payments/operator/orders/{id}/refunds");
    let (approval, refund) = tokio::join!(
        h.request(
            "POST",
            &approval_path,
            Some(&h.checker_token),
            Some(
                json!({"proposal_id":p["proposal_id"],"evidence_version":order["evidence_version"]})
            )
        ),
        h.request(
            "POST",
            &refund_path,
            Some(&h.maker_token),
            Some(refund_request)
        )
    );
    assert_eq!(refund.0, StatusCode::OK, "{}", refund.1);
    assert!([StatusCode::OK, StatusCode::CONFLICT].contains(&approval.0));
    let posted = approval.0 == StatusCode::OK;
    assert_eq!(refund.1["frozen_minor_hkd"], if posted { 10000 } else { 0 });
    let r = h.approve_refund(&refund.1).await;
    let r = h.attach_refund(&r).await;
    h.finish_refund(&r).await;
    let balance: i64 = sqlx::query_scalar(
        "SELECT coalesce((SELECT balance_minor FROM real_hkd_accounts WHERE user_id=$1),0)",
    )
    .bind(h.user)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(balance, 0);
    assert_eq!(
        h.count("real_hkd_transactions").await,
        if posted { 1 } else { 0 }
    );
    assert_eq!(
        h.count("real_hkd_reversals").await,
        if posted { 1 } else { 0 }
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn revoked_policy_fences_old_process_waiting_on_identity_and_suspension_blocks_operator() {
    let h = Harness::new().await;
    let order = h.paid().await;
    let p = h.propose(&order).await;
    let id = order["payment_id"].as_str().unwrap();
    let mut lock = h.pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM identities WHERE id=$1 FOR UPDATE")
        .bind(h.user)
        .fetch_one(&mut *lock)
        .await
        .unwrap();
    let router = h.router.clone();
    let token = h.checker_token.clone();
    let path = format!("/v1/payments/orders/{id}/approvals");
    let payload =
        json!({"proposal_id":p["proposal_id"],"evidence_version":order["evidence_version"]});
    let waiting = tokio::spawn(async move {
        router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    });
    let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
    policy.checkers = BTreeSet::from([h.user]);
    let old = h.state.payments.as_ref().unwrap();
    let changed = PaymentRuntime::new(old.client.clone(), old.merchant_id.clone(), policy).unwrap();
    xiaoq_backend::payments::operator::sync_operator_policy(&h.pool, &changed)
        .await
        .unwrap();
    lock.commit().await.unwrap();
    let response = waiting.await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(h.count("real_hkd_transactions").await, 0);
    assert_eq!(
        h.request(
            "GET",
            "/v1/payments/operator/me",
            Some(&h.maker_token),
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    xiaoq_backend::payments::operator::sync_operator_policy(&h.pool, old)
        .await
        .unwrap();
    account_lifecycle::operator_status(&h.pool, h.checker, true)
        .await
        .unwrap();
    assert_eq!(
        h.request(
            "GET",
            "/v1/payments/operator/me",
            Some(&h.checker_token),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn unknown_unpaid_refund_refused_available_guard_and_duplicate_create_payload_conflict() {
    let h = Harness::new().await;
    let order = h.order().await;
    let id = order["payment_id"].as_str().unwrap();
    let key = Uuid::new_v4();
    let path = format!("/v1/payments/operator/orders/{id}/refunds");
    let request = json!({"client_request_id":key,"reason":"Full refund"});
    assert_eq!(
        h.request("POST", &path, Some(&h.maker_token), Some(request.clone()))
            .await
            .0,
        StatusCode::CONFLICT
    );
    h.tick().await;
    h.mark_paid().await;
    let paid = h.detail(id).await;
    h.credit(&paid).await;
    let (s, a) = h
        .request("POST", &path, Some(&h.maker_token), Some(request.clone()))
        .await;
    assert_eq!(s, StatusCode::OK, "{a}");
    let (s, b) = h
        .request("POST", &path, Some(&h.maker_token), Some(request))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(a["refund_id"], b["refund_id"]);
    assert_eq!(
        h.request(
            "POST",
            &path,
            Some(&h.maker_token),
            Some(json!({"client_request_id":key,"reason":"different payload"}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut tx = h.pool.begin().await.unwrap();
    let error = xiaoq_backend::ledger::real_hkd::lock_available(&mut tx, h.user, 1)
        .await
        .unwrap_err();
    assert_eq!(error.code, "PAYMENT_REFUND_INSUFFICIENT_AVAILABLE");
    tx.rollback().await.unwrap();
    assert_eq!(h.count("payment_refunds").await, 1);
    h.finish().await;
}

impl Harness {
    async fn statement(&self, order: &Value, kind: &str) -> Value {
        let id = order["payment_id"]
            .as_str()
            .unwrap()
            .parse::<Uuid>()
            .unwrap();
        let (no, trade): (String, String) =
            sqlx::query_as("SELECT merchant_no,provider_trade_no FROM payment_orders WHERE id=$1")
                .bind(id)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let amount = order["pay_amount_minor_cny"].as_i64().unwrap();
        let fee = amount / 100;
        let net = amount - fee;
        let mapping = json!({"currency":"CNY","rows":[{"merchant_order_no":no,"provider_trade_no":trade,"gross_minor":amount,"channel_fee_minor":fee,"net_minor":net}]});
        let source =
            format!("merchant,provider,gross,fee,net\n{no},{trade},{amount},{fee},{net}\n");
        json!({"client_request_id":Uuid::new_v4(),"kind":kind,"source":"Original restricted bank/provider CSV fixture","bank_reference":if kind=="bank_settlement"{Some(format!("bank-{id}"))}else{None},"bank_amount_minor":if kind=="bank_settlement"{Some(net)}else{None},"evidence_base64":STANDARD.encode(mapping.to_string()),"source_document_base64":STANDARD.encode(source),"source_document_media_type":"text/csv"})
    }
    async fn import_statement(&self, payload: Value) -> Value {
        let (s, v) = self
            .request(
                "POST",
                "/v1/payments/operator/settlements",
                Some(&self.maker_token),
                Some(payload),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        v
    }
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn settlement_original_document_reused_across_layers_both_hashes_and_readonly_key_recovery() {
    let h = Harness::new().await;
    let order = h.paid().await;
    h.credit(&order).await;
    let payload = h.statement(&order, "order_reconciliation").await;
    let key = payload["client_request_id"].as_str().unwrap();
    let first = h.import_statement(payload.clone()).await;
    let id = first["settlement_id"].as_str().unwrap();
    assert_eq!(first["source_validation"], "operator_supplied");
    assert_eq!(first["status"], "awaiting_verification");
    let repeat = h.import_statement(payload.clone()).await;
    assert_eq!(repeat["settlement_id"], first["settlement_id"]);
    let count = h.count("payment_settlements").await;
    let (s, recovered) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/settlements/by-client-key/{key}"),
            Some(&h.maker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{recovered}");
    assert_eq!(recovered["settlement_id"], first["settlement_id"]);
    assert_eq!(h.count("payment_settlements").await, count);
    assert_eq!(
        h.request(
            "GET",
            &format!("/v1/payments/operator/settlements/by-client-key/{key}"),
            Some(&h.checker_token),
            None
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut changed = payload.clone();
    changed["source"] = json!("Different payload, same request");
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/operator/settlements",
            Some(&h.maker_token),
            Some(changed)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut duplicate = payload.clone();
    duplicate["client_request_id"] = json!(Uuid::new_v4());
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/operator/settlements",
            Some(&h.maker_token),
            Some(duplicate)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let bank_payload = h.statement(&order, "bank_settlement").await;
    let bank = h.import_statement(bank_payload).await;
    assert_eq!(bank["evidence_sha256"], first["evidence_sha256"]);
    assert_eq!(bank["mapping_sha256"], first["mapping_sha256"]);
    assert_ne!(bank["settlement_id"], first["settlement_id"]);
    let request = json!({"mapping_sha256":first["mapping_sha256"],"evidence_sha256":first["evidence_sha256"]});
    let path = format!("/v1/payments/operator/settlements/{id}/verify");
    assert_eq!(
        h.request("POST", &path, Some(&h.maker_token), Some(request.clone()))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong = request.clone();
    wrong["mapping_sha256"] = json!("0".repeat(64));
    assert_eq!(
        h.request("POST", &path, Some(&h.checker_token), Some(wrong))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (s, verified) = h
        .request("POST", &path, Some(&h.checker_token), Some(request.clone()))
        .await;
    assert_eq!(s, StatusCode::OK, "{verified}");
    assert_eq!(verified["status"], "operator_verified");
    assert_eq!(
        h.request("POST", &path, Some(&h.checker_token), Some(request))
            .await
            .0,
        StatusCode::OK
    );
    for (part, expected, media) in [
        (
            "source",
            STANDARD
                .decode(payload["source_document_base64"].as_str().unwrap())
                .unwrap(),
            "text/csv",
        ),
        (
            "mapping",
            STANDARD
                .decode(payload["evidence_base64"].as_str().unwrap())
                .unwrap(),
            "application/json",
        ),
    ] {
        let response = h
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/v1/payments/operator/settlements/{id}/document?part={part}"
                    ))
                    .header("authorization", format!("Bearer {}", h.checker_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], media);
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            to_bytes(response.into_body(), 400000)
                .await
                .unwrap()
                .as_ref(),
            expected
        );
    }
    let (s, audit) = h
        .request(
            "GET",
            "/v1/payments/operator/audit?limit=1",
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{audit}");
    assert!(audit["next_cursor"].is_string());
    assert!(audit["items"][0]["payment_id"].is_null());
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn settlement_differences_cannot_be_overridden_and_original_payment_remains_a_fact() {
    let h = Harness::new().await;
    let order = h.paid().await;
    h.credit(&order).await;
    let payload = h.statement(&order, "bank_settlement").await;
    let good = h.import_statement(payload.clone()).await;
    let mut wrong = payload.clone();
    wrong["client_request_id"] = json!(Uuid::new_v4());
    wrong["bank_reference"] = json!("bank-other-record");
    wrong["bank_amount_minor"] = json!(1);
    let mut mapping: Value = serde_json::from_slice(
        &STANDARD
            .decode(payload["evidence_base64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    mapping["rows"][0]["merchant_order_no"] = json!("not-a-q-order");
    wrong["evidence_base64"] = json!(STANDARD.encode(mapping.to_string()));
    let bad = h.import_statement(wrong).await;
    assert_eq!(bad["status"], "discrepancy");
    assert_eq!(bad["differences"].as_array().unwrap().len(), 2);
    assert_eq!(h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",bad["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":bad["mapping_sha256"],"evidence_sha256":bad["evidence_sha256"]}))).await.0,StatusCode::CONFLICT);
    h.refund(&order).await;
    assert_eq!(h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",good["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":good["mapping_sha256"],"evidence_sha256":good["evidence_sha256"]}))).await.0,StatusCode::OK);
    let mut malformed = payload;
    malformed["evidence_base64"] =
        json!(STANDARD.encode("{\"currency\":\"CNY\",\"rows\":[],\"extra\":1}"));
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/operator/settlements",
            Some(&h.maker_token),
            Some(malformed)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(h.count("payment_settlements").await, 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn refund_external_reference_and_receipt_cannot_complete_two_orders() {
    let h = Harness::new().await;
    let first = h.paid().await;
    h.credit(&first).await;
    let first = h.refund(&first).await;
    let first = h.approve_refund(&first).await;
    let first_evidence = h.attach_refund(&first).await;
    let second_order = h.paid().await;
    h.credit(&second_order).await;
    let second = h.refund(&second_order).await;
    let second = h.approve_refund(&second).await;
    let original_bytes =
        STANDARD.encode(format!("external-original-receipt-{}", first["refund_id"]));
    let mut payload = json!({"version":second["version"],"evidence_base64":original_bytes,"external_reference":format!("different-{}",Uuid::new_v4()),"executed_at":Utc::now(),"notes":"Duplicate receipt rejected"});
    let path = format!(
        "/v1/payments/operator/refunds/{}/evidence",
        second["refund_id"].as_str().unwrap()
    );
    assert_eq!(
        h.request("POST", &path, Some(&h.maker_token), Some(payload.clone()))
            .await
            .0,
        StatusCode::CONFLICT
    );
    payload["evidence_base64"] = json!(STANDARD.encode(b"different-receipt"));
    payload["external_reference"] = first_evidence["external_reference"].clone();
    assert_eq!(
        h.request("POST", &path, Some(&h.maker_token), Some(payload))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let second_evidence = h.attach_refund(&second).await;
    h.finish_refund(&first_evidence).await;
    h.finish_refund(&second_evidence).await;
    let (_, wallet) = h
        .request("GET", "/v1/payments/wallet", Some(&h.token), None)
        .await;
    assert_eq!(wallet["balance_minor"], 0);
    assert_eq!(h.count("real_hkd_reversals").await, 2);
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn reserve_evidence_remains_operator_supplied_and_cannot_credit_wallet_or_claim_fx_execution()
{
    let h = Harness::new().await;
    let original_accounts = h.count("real_hkd_accounts").await;
    let request = json!({"client_request_id":Uuid::new_v4(),"kind":"hkd_reserve","source":"Original HKD bank statement fixture","bank_reference":"bank-reserve-reference-1","bank_amount_minor":100000,"evidence_base64":STANDARD.encode(json!({"currency":"HKD","rows":[]}).to_string()),"source_document_base64":STANDARD.encode("currency,balance\nHKD,1000.00\n"),"source_document_media_type":"text/csv"});
    let record = h.import_statement(request.clone()).await;
    assert_eq!(record["source_validation"], "operator_supplied");
    assert_eq!(record["currency"], "HKD");
    assert_eq!(record["record_count"], 0);
    let(s,verified)=h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",record["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":record["mapping_sha256"],"evidence_sha256":record["evidence_sha256"]}))).await;
    assert_eq!(s, StatusCode::OK, "{verified}");
    assert_eq!(verified["status"], "operator_verified");
    // A later original HKD statement has the same empty mapping but is a different real batch.
    let mut later = request.clone();
    later["client_request_id"] = json!(Uuid::new_v4());
    later["bank_reference"] = json!("bank-reserve-reference-2");
    later["bank_amount_minor"] = json!(200000);
    later["source_document_base64"] = json!(STANDARD.encode("currency,balance\nHKD,2000.00\n"));
    let later = h.import_statement(later).await;
    assert_eq!(later["mapping_sha256"], record["mapping_sha256"]);
    assert_ne!(later["evidence_sha256"], record["evidence_sha256"]);
    assert_ne!(later["settlement_id"], record["settlement_id"]);
    let(s,later_verified)=h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",later["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":later["mapping_sha256"],"evidence_sha256":later["evidence_sha256"]}))).await;
    assert_eq!(s, StatusCode::OK, "{later_verified}");
    let mut malformed = request;
    malformed["evidence_base64"] =
        json!(STANDARD.encode(json!({"currency":"CNY","rows":[]}).to_string()));
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/operator/settlements",
            Some(&h.maker_token),
            Some(malformed)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(h.count("real_hkd_accounts").await, original_accounts);
    assert_eq!(h.count("real_hkd_transactions").await, 0);
    assert_eq!(h.count("payment_orders").await, 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn discrepancy_accepts_new_source_same_mapping_and_only_one_bank_reference_can_be_verified() {
    let h = Harness::new().await;
    let order = h.paid().await;
    h.credit(&order).await;
    let good = h.statement(&order, "bank_settlement").await;
    let mut incorrect = good.clone();
    incorrect["bank_amount_minor"] = json!(1);
    let bad = h.import_statement(incorrect.clone()).await;
    assert_eq!(bad["status"], "discrepancy");
    let mut corrected = good;
    corrected["client_request_id"] = json!(Uuid::new_v4());
    let original = String::from_utf8(
        STANDARD
            .decode(corrected["source_document_base64"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    corrected["source_document_base64"] =
        json!(STANDARD.encode(format!("{original}provider-corrected-original-statement\n")));
    let corrected = h.import_statement(corrected.clone()).await;
    assert_eq!(corrected["status"], "awaiting_verification");
    assert_eq!(corrected["bank_reference"], bad["bank_reference"]);
    assert_eq!(corrected["mapping_sha256"], bad["mapping_sha256"]);
    assert_ne!(corrected["evidence_sha256"], bad["evidence_sha256"]);
    let verify_path = format!(
        "/v1/payments/operator/settlements/{}/verify",
        corrected["settlement_id"].as_str().unwrap()
    );
    let(s,verified)=h.request("POST",&verify_path,Some(&h.checker_token),Some(json!({"mapping_sha256":corrected["mapping_sha256"],"evidence_sha256":corrected["evidence_sha256"]}))).await;
    assert_eq!(s, StatusCode::OK, "{verified}");
    let bad_replayed = h.import_statement(incorrect).await;
    assert_eq!(bad_replayed["settlement_id"], bad["settlement_id"]);
    assert_eq!(bad_replayed["status"], "discrepancy");
    let mut duplicate = h.statement(&order, "bank_settlement").await;
    duplicate["source_document_base64"] =
        json!(STANDARD.encode(format!("{original}second-copy-of-same-bank-reference\n")));
    let duplicate = h.import_statement(duplicate).await;
    assert_eq!(duplicate["status"], "awaiting_verification");
    let(s,error)=h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",duplicate["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":duplicate["mapping_sha256"],"evidence_sha256":duplicate["evidence_sha256"]}))).await;
    assert_eq!(s, StatusCode::CONFLICT, "{error}");
    assert_eq!(
        error["error"]["code"],
        "PAYMENT_BANK_REFERENCE_ALREADY_VERIFIED"
    );
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM payment_settlements WHERE kind='bank_settlement' AND status='operator_verified'").fetch_one(&h.pool).await.unwrap();
    assert_eq!(count, 1);
    // The database, independently of the pre-check, refuses a second confirmation of the same reference.
    assert!(sqlx::query("UPDATE payment_settlements SET status='operator_verified',checker_id=$2,verified_at=clock_timestamp() WHERE id=$1").bind(duplicate["settlement_id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(h.checker).execute(&h.pool).await.is_err());
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn wrong_refund_evidence_is_retained_rejected_corrected_and_old_hash_never_credits_twice() {
    let h = Harness::new().await;
    let order = h.paid().await;
    h.credit(&order).await;
    let r = h.refund(&order).await;
    let approved = h.approve_refund(&r).await;
    let id = r["refund_id"].as_str().unwrap();
    let wrong_reference = format!("wrong-reference-{id}");
    let wrong_bytes = b"WRONG EXTERNAL RECEIPT: retained for independent correction review";
    let(s,wrong)=h.request("POST",&format!("/v1/payments/operator/refunds/{id}/evidence"),Some(&h.maker_token),Some(json!({"version":approved["version"],"evidence_base64":STANDARD.encode(wrong_bytes),"external_reference":wrong_reference,"executed_at":Utc::now(),"notes":"Initial attachment later found incorrect"}))).await;
    assert_eq!(s, StatusCode::OK, "{wrong}");
    assert_eq!(wrong["evidence_version"], 1);
    let rejection = json!({"version":wrong["version"],"evidence_sha256":wrong["evidence_sha256"],"reason":"The original receipt does not identify this refund; attach corrected evidence only. Do not refund again."});
    let path = format!("/v1/payments/operator/refunds/{id}/evidence-rejections");
    assert_eq!(
        h.request("POST", &path, Some(&h.maker_token), Some(rejection.clone()))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (s, rejected) = h
        .request(
            "POST",
            &path,
            Some(&h.checker_token),
            Some(rejection.clone()),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{rejected}");
    assert_eq!(rejected["status"], "evidence_rejected");
    assert!(
        rejected["rejection_reason"]
            .as_str()
            .unwrap()
            .contains("Do not refund again")
    );
    assert_eq!(
        h.request("POST", &path, Some(&h.checker_token), Some(rejection))
            .await
            .0,
        StatusCode::OK
    );
    let old_verify = json!({"version":wrong["version"],"evidence_sha256":wrong["evidence_sha256"]});
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/operator/refunds/{id}/verify"),
            Some(&h.checker_token),
            Some(old_verify.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, wallet) = h
        .request("GET", "/v1/payments/wallet", Some(&h.token), None)
        .await;
    assert_eq!(wallet["balance_minor"], 10000);
    assert_eq!(wallet["frozen_minor"], 10000);
    // A DB write cannot reopen rejected evidence while keeping the old attachment pointer.
    assert!(sqlx::query("UPDATE payment_refunds SET status='evidence_pending',rejection_reason=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=$1").bind(id.parse::<Uuid>().unwrap()).execute(&h.pool).await.is_err());
    let corrected = h.attach_refund(&rejected).await;
    assert_eq!(corrected["evidence_version"], 2);
    assert_ne!(corrected["evidence_sha256"], wrong["evidence_sha256"]);
    assert!(corrected["rejection_reason"].is_null());
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/operator/refunds/{id}/verify"),
            Some(&h.checker_token),
            Some(old_verify)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (s, history) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/refunds/{id}/evidence?limit=1"),
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{history}");
    assert_eq!(history["items"][0]["evidence_version"], 2);
    assert_eq!(history["next_cursor"], "2");
    let (_, older) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/refunds/{id}/evidence?cursor=2"),
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(
        older["items"][0]["evidence_sha256"],
        wrong["evidence_sha256"]
    );
    assert!(older["items"][0]["rejection_reason"].is_string());
    let (s, original) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/refunds/{id}/document?version=1"),
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(original, String::from_utf8(wrong_bytes.to_vec()).unwrap());
    h.finish_refund(&corrected).await;
    h.finish_refund(&corrected).await;
    assert_eq!(h.count("real_hkd_reversals").await, 1);
    assert_eq!(h.count("payment_refund_evidence").await, 2);
    assert_eq!(h.count("payment_refund_evidence_rejections").await, 1);
    assert!(
        sqlx::query("UPDATE payment_refund_evidence SET notes='changed'")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM payment_refund_evidence_bindings")
            .execute(&h.pool)
            .await
            .is_err()
    );
    // Superseding a bad attachment cannot release its hash/reference to another payment.
    let second_order = h.paid().await;
    h.credit(&second_order).await;
    let second = h.refund(&second_order).await;
    let second = h.approve_refund(&second).await;
    let second_path = format!(
        "/v1/payments/operator/refunds/{}/evidence",
        second["refund_id"].as_str().unwrap()
    );
    let mut stolen = json!({"version":second["version"],"evidence_base64":STANDARD.encode(wrong_bytes),"external_reference":"new-reference-for-old-file","executed_at":Utc::now(),"notes":"Historical receipt cannot be moved"});
    assert_eq!(
        h.request(
            "POST",
            &second_path,
            Some(&h.maker_token),
            Some(stolen.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    stolen["evidence_base64"] =
        json!(STANDARD.encode(b"new bytes but a permanently bound old reference"));
    stolen["external_reference"] = json!(wrong_reference);
    assert_eq!(
        h.request("POST", &second_path, Some(&h.maker_token), Some(stolen))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.count("real_hkd_reversals").await, 1);
    h.finish().await;
}
#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn paid_and_uncredited_refunds_reconcile_mixed_signed_bank_net_with_original_frozen_cny() {
    for credited in [true, false] {
        let mut h = Harness::new().await;
        let order = h.paid().await;
        if credited {
            h.credit(&order).await;
        }
        let r = h.refund(&order).await;
        let r = h.approve_refund(&r).await;
        let r = h.attach_refund(&r).await;
        let refunded = h.finish_refund(&r).await;
        let mut policy = h.state.payments.as_ref().unwrap().policy.clone();
        policy.rate.rate_cny_per_100_hkd = "50.00000000".into();
        policy.fee_basis_points = 100;
        h.install_policy(policy).await;
        let original = h.statement(&order, "bank_settlement").await;
        let mut mapping: Value = serde_json::from_slice(
            &STANDARD
                .decode(original["evidence_base64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let pay = order["pay_amount_minor_cny"].as_i64().unwrap();
        let mut payment = mapping["rows"][0].clone();
        payment["entry_kind"] = json!("payment");
        payment["channel_fee_minor"] = json!(100);
        payment["net_minor"] = json!(pay - 100);
        let mut refund = payment.clone();
        refund["entry_kind"] = json!("refund");
        refund["refund_external_reference"] = refunded["external_reference"].clone();
        refund["gross_minor"] = json!(-pay);
        refund["channel_fee_minor"] = json!(-40);
        refund["net_minor"] = json!(-pay + 40);
        mapping["rows"] = json!([payment, refund.clone()]);
        let mut payload = original;
        payload["evidence_base64"] = json!(STANDARD.encode(mapping.to_string()));
        payload["bank_amount_minor"] = json!(-60);
        payload["source_document_base64"] = json!(STANDARD.encode(format!(
            "entry,gross,fee,net\npayment,{pay},100,{}\nrefund,{},-40,{}\n",
            pay - 100,
            -pay,
            -pay + 40
        )));
        let batch = h.import_statement(payload.clone()).await;
        assert_eq!(batch["status"], "awaiting_verification");
        assert_eq!(batch["matched_count"], 2);
        assert_eq!(batch["bank_amount_minor"], -60);
        let(s,verified)=h.request("POST",&format!("/v1/payments/operator/settlements/{}/verify",batch["settlement_id"].as_str().unwrap()),Some(&h.checker_token),Some(json!({"mapping_sha256":batch["mapping_sha256"],"evidence_sha256":batch["evidence_sha256"]}))).await;
        assert_eq!(s, StatusCode::OK, "{verified}");
        for (field, value, code) in [
            (
                "refund_external_reference",
                json!("wrong-original-return"),
                "REFUND_REFERENCE_MISMATCH",
            ),
            ("gross_minor", json!(-pay + 1), "REFUND_AMOUNT_MISMATCH"),
        ] {
            let mut wrong_map = mapping.clone();
            wrong_map["rows"][1][field] = value;
            if field == "gross_minor" {
                wrong_map["rows"][1]["net_minor"] = json!(-pay + 41);
            }
            let mut wrong = payload.clone();
            wrong["client_request_id"] = json!(Uuid::new_v4());
            wrong["evidence_base64"] = json!(STANDARD.encode(wrong_map.to_string()));
            let result = h.import_statement(wrong).await;
            assert_eq!(result["status"], "discrepancy");
            assert!(
                result["differences"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["code"] == code)
            );
        }
        let mut duplicate = payload;
        mapping["rows"].as_array_mut().unwrap().push(refund);
        duplicate["client_request_id"] = json!(Uuid::new_v4());
        duplicate["evidence_base64"] = json!(STANDARD.encode(mapping.to_string()));
        assert_eq!(
            h.request(
                "POST",
                "/v1/payments/operator/settlements",
                Some(&h.maker_token),
                Some(duplicate)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            h.count("real_hkd_reversals").await,
            if credited { 1 } else { 0 }
        );
        h.finish().await;
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn unchanged_original_materials_recheck_after_credit_retains_initial_difference_and_then_verifies()
 {
    let h = Harness::new().await;
    let order = h.paid().await;
    let request = h.statement(&order, "bank_settlement").await;
    let initial = h.import_statement(request.clone()).await;
    assert_eq!(initial["status"], "discrepancy");
    assert_eq!(initial["check_version"], 1);
    assert!(
        initial["differences"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "WALLET_NOT_CREDITED")
    );
    let id = initial["settlement_id"].as_str().unwrap();
    // Before the wallet entry exists, a recheck preserves the real difference rather than accepting it.
    let (s, still) = h
        .request(
            "POST",
            &format!("/v1/payments/operator/settlements/{id}/rechecks"),
            Some(&h.maker_token),
            Some(json!({})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{still}");
    assert_eq!(still["status"], "discrepancy");
    assert_eq!(still["check_version"], 2);
    let verify = json!({"mapping_sha256":initial["mapping_sha256"],"evidence_sha256":initial["evidence_sha256"]});
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/operator/settlements/{id}/verify"),
            Some(&h.checker_token),
            Some(verify.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    h.credit(&order).await;
    // Reimporting identical correct evidence is unnecessary: the original key still recovers it.
    let recovered = h.import_statement(request).await;
    assert_eq!(recovered["settlement_id"], initial["settlement_id"]);
    let (s, rechecked) = h
        .request(
            "POST",
            &format!("/v1/payments/operator/settlements/{id}/rechecks"),
            Some(&h.maker_token),
            Some(json!({})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{rechecked}");
    assert_eq!(rechecked["status"], "awaiting_verification");
    assert_eq!(rechecked["differences"], json!([]));
    assert_eq!(rechecked["matched_count"], 1);
    assert_eq!(rechecked["evidence_sha256"], initial["evidence_sha256"]);
    assert_eq!(rechecked["mapping_sha256"], initial["mapping_sha256"]);
    let (s, verified) = h
        .request(
            "POST",
            &format!("/v1/payments/operator/settlements/{id}/verify"),
            Some(&h.checker_token),
            Some(verify),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{verified}");
    assert_eq!(verified["status"], "operator_verified");
    let (s, history) = h
        .request(
            "GET",
            &format!("/v1/payments/operator/settlements/{id}/checks"),
            Some(&h.checker_token),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{history}");
    let versions = history["items"].as_array().unwrap();
    assert!(versions.len() >= 5);
    let original = versions.iter().find(|v| v["check_version"] == 1).unwrap();
    assert_eq!(original["differences"], initial["differences"]);
    assert_eq!(versions[0]["differences"], json!([]));
    assert!(
        sqlx::query("DELETE FROM payment_settlement_checks")
            .execute(&h.pool)
            .await
            .is_err()
    );
    assert_eq!(
        h.request(
            "POST",
            &format!("/v1/payments/operator/settlements/{id}/rechecks"),
            Some(&h.maker_token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(h.count("payment_settlements").await, 1);
    h.finish().await;
}
