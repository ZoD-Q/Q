//! Isolated PG and in-process FX fixtures only; no ECB, supplier or business DB.
#![cfg(feature = "payments-test-fixtures")]
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{collections::BTreeSet, sync::Arc};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, app,
    payments::{
        PaymentPolicy, PaymentRuntime, RateSnapshot,
        config::{ProviderVersion, quote_math},
        fx::{self, test_support},
        operator,
        qixiang::{QixiangClient, QixiangConfig},
    },
};

struct Harness {
    pool: PgPool,
    admin: PgPool,
    schema: String,
    state: AppState,
    user: Uuid,
    maker: Uuid,
    checker: Uuid,
    user_token: String,
    maker_token: String,
    checker_token: String,
}
fn runtime(maker: Uuid, checker: Uuid, automatic: bool) -> PaymentRuntime {
    let now = Utc::now();
    let date = now - Duration::days(1);
    let client = QixiangClient::with_test_fixture(
        QixiangConfig::new(
            "1001".into(),
            "fixture-fx-secret".into(),
            "https://q.example/notify",
            "https://q.example/return",
        )
        .unwrap(),
        "http://127.0.0.1:9/",
    )
    .unwrap();
    let policy = PaymentPolicy {
        rate: RateSnapshot {
            rate_cny_per_100_hkd: "100".into(),
            rate_source: "Trusted bootstrap fixture; not downloaded".into(),
            rate_source_url: fx::ECB_URL.into(),
            rate_source_date: date.date_naive().to_string(),
            rate_at: date,
            rate_fetched_at: date,
            rate_evidence_sha256: "a".repeat(64),
        },
        fee_basis_points: 100,
        min_credit_amount_minor_hkd: 1000,
        max_credit_amount_minor_hkd: 5_000_000,
        quote_ttl_seconds: 300,
        checkout_ttl_seconds: 600,
        rate_max_age_seconds: 345600,
        provider_utc_offset_seconds: Some(28800),
        makers: BTreeSet::from([maker]),
        checkers: BTreeSet::from([checker]),
    };
    let mut r = PaymentRuntime::new(client, "1001".into(), policy).unwrap();
    r.auto_fx_refresh = automatic;
    r
}
fn xml(date: chrono::NaiveDate, cny: &str, hkd: &str) -> Vec<u8> {
    format!(r#"<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time="{date}"><Cube currency="CNY" rate="{cny}"/><Cube currency="HKD" rate="{hkd}"/></Cube></Cube></gesmes:Envelope>"#).into_bytes()
}
async fn call(
    router: Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("Authorization", format!("Bearer {token}"));
    }
    if body.is_some() {
        request = request.header("Content-Type", "application/json");
    }
    let response = router
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 262144).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
impl Harness {
    async fn new(automatic: bool) -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("Dedicated FX test database required");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_fx_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .after_connect(move |c, _| {
                let p = path.clone();
                Box::pin(async move {
                    sqlx::query(&p).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let state = AppState::new(pool.clone()).await.unwrap();
        let mut actors = Vec::new();
        for name in ["fxpayer", "fxmaker", "fxchecker"] {
            let (status,d)=call(app(state.clone(),vec![]),"POST","/v1/auth/register",None,Some(json!({"handle":name,"password":"fixture-fx-password-only","display_name":name}))).await;
            assert_eq!(status, StatusCode::CREATED);
            actors.push((
                Uuid::parse_str(d["user"]["id"].as_str().unwrap()).unwrap(),
                d["token"].as_str().unwrap().to_owned(),
            ));
        }
        let mut h = Self {
            pool,
            admin,
            schema,
            state,
            user: actors[0].0,
            maker: actors[1].0,
            checker: actors[2].0,
            user_token: actors[0].1.clone(),
            maker_token: actors[1].1.clone(),
            checker_token: actors[2].1.clone(),
        };
        h.install(runtime(h.maker, h.checker, automatic)).await;
        h
    }
    fn r(&self) -> &PaymentRuntime {
        self.state.payments.as_deref().unwrap()
    }
    async fn install(&mut self, r: PaymentRuntime) {
        operator::sync_operator_policy(&self.pool, &r)
            .await
            .unwrap();
        fx::bootstrap(&self.pool, &r).await.unwrap();
        self.state.payments = Some(Arc::new(r));
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        call(
            app(self.state.clone(), vec![]),
            method,
            path,
            Some(token),
            body,
        )
        .await
    }
    async fn due(&self) {
        sqlx::query(
            "UPDATE payment_fx_state SET next_attempt_at=clock_timestamp()-interval '1 second'",
        )
        .execute(&self.pool)
        .await
        .unwrap();
    }
    async fn poll(&self, body: Vec<u8>) {
        self.due().await;
        let lease = test_support::claim_due(&self.pool, self.r())
            .await
            .unwrap()
            .unwrap();
        assert!(
            test_support::xml(&self.pool, self.r(), &lease, body)
                .await
                .unwrap()
        );
    }
    async fn status(&self) -> Value {
        let (status, d) = self
            .request("GET", "/v1/payments/fx/status", &self.maker_token, None)
            .await;
        assert_eq!(status, StatusCode::OK);
        d
    }
    async fn quote(&self) -> Value {
        let (status, d) = self
            .request(
                "POST",
                "/v1/payments/quotes",
                &self.user_token,
                Some(json!({"channel":"wechat","credit_amount_minor_hkd":1000})),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{d:?}");
        d
    }
    async fn legacy_quote(&self) -> Uuid {
        self.legacy_quote_for(self.user).await
    }
    async fn legacy_quote_for(&self, payer: Uuid) -> Uuid {
        let r = self.r();
        let id = Uuid::new_v4();
        let fingerprint = Sha256::digest(
            serde_json::to_vec(&(&r.merchant_id, &r.credential_version, &r.policy)).unwrap(),
        )
        .to_vec();
        let (base, fee, pay) = quote_math(
            1000,
            &r.policy.rate.rate_cny_per_100_hkd,
            r.policy.fee_basis_points,
        )
        .unwrap();
        sqlx::query("INSERT INTO payment_quotes(id,user_id,channel,credit_minor,base_minor,fee_minor,pay_minor,fee_bps,rate_snapshot,config_fingerprint,expires_at,merchant_id,credential_version) VALUES($1,$2,'wechat',1000,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(id).bind(payer).bind(base).bind(fee).bind(pay).bind(r.policy.fee_basis_points).bind(serde_json::to_value(&r.policy.rate).unwrap()).bind(fingerprint).bind(Utc::now()+Duration::seconds(300)).bind(&r.merchant_id).bind(&r.credential_version).execute(&self.pool).await.unwrap();
        id
    }
    async fn create(&self, quote: Uuid, key: Uuid) -> (StatusCode, Value) {
        self.request(
            "POST",
            "/v1/payments/orders",
            &self.user_token,
            Some(json!({"quote_id":quote,"client_request_id":key})),
        )
        .await
    }
    async fn close(self) {
        self.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn new_funding_is_fenced_by_reviewer_suspension_and_policy_rotation_at_commit() {
    let h = Harness::new(true).await;
    let quote = h.quote().await;
    let mut suspension = h.pool.begin().await.unwrap();
    let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *suspension)
        .await
        .unwrap();
    sqlx::query("UPDATE identities SET status='suspended' WHERE id=$1")
        .bind(h.checker)
        .execute(&mut *suspension)
        .await
        .unwrap();
    let router = app(h.state.clone(), vec![]);
    let payer = h.user_token.clone();
    let body = json!({"quote_id":quote["quote_id"],"client_request_id":Uuid::new_v4()});
    let original_body = body.clone();
    let request = tokio::spawn(async move {
        call(
            router,
            "POST",
            "/v1/payments/orders",
            Some(&payer),
            Some(body),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            assert!(
                !request.is_finished(),
                "new funding bypassed the active reviewer row lock"
            );
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))",
            )
            .bind(blocker)
            .fetch_one(&h.pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("creation should wait for the in-progress reviewer suspension");
    suspension.commit().await.unwrap();
    let (status, error) = request.await.unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["error"]["code"], "PAYMENT_REVIEWERS_UNAVAILABLE");

    // Restore the isolated identity, then model the window after role synchronization
    // but before the new process bootstraps its FX state. The old runtime must not fund.
    sqlx::query("UPDATE identities SET status='active' WHERE id=$1")
        .bind(h.checker)
        .execute(&h.pool)
        .await
        .unwrap();
    let replacement = runtime(h.user, h.checker, true);
    operator::sync_operator_policy(&h.pool, &replacement)
        .await
        .unwrap();
    let (status, error) = h
        .request(
            "POST",
            "/v1/payments/orders",
            &h.user_token,
            Some(original_body),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error["error"]["code"], "PAYMENT_REVIEWERS_UNAVAILABLE");
    for table in ["payment_orders", "payment_jobs", "payment_checkout_slots"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "a failed eligibility fence must not leave {table} rows"
        );
    }
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn payer_needs_two_other_reviewers_before_new_funding_but_original_orders_still_recover() {
    let mut h = Harness::new(false).await;
    let (code, capability) = h
        .request("GET", "/v1/payments/capabilities", &h.user_token, None)
        .await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(capability["enabled"], true);
    for (reviewer, token) in [(h.maker, &h.maker_token), (h.checker, &h.checker_token)] {
        let (code, capability) = h
            .request("GET", "/v1/payments/capabilities", token, None)
            .await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(capability["enabled"], false);
        assert_eq!(
            capability["unavailable_reason"],
            "PAYMENT_REVIEWERS_UNAVAILABLE"
        );
        assert!(
            capability["channels"]
                .as_array()
                .unwrap()
                .iter()
                .all(|c| c["enabled"] == false
                    && c["unavailable_reason"] == "PAYMENT_REVIEWERS_UNAVAILABLE")
        );
        let (code, denied) = h
            .request(
                "POST",
                "/v1/payments/quotes",
                token,
                Some(json!({"channel":"wechat","credit_amount_minor_hkd":1000})),
            )
            .await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(denied["error"]["code"], "PAYMENT_REVIEWERS_UNAVAILABLE");
        let quote_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM payment_quotes WHERE user_id=$1")
                .bind(reviewer)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        assert_eq!(quote_count, 0);
        // Pre-upgrade accepted quotes must also be stopped before a supplier obligation.
        let quote = h.legacy_quote_for(reviewer).await;
        let (code, denied) = h
            .request(
                "POST",
                "/v1/payments/orders",
                token,
                Some(json!({"quote_id":quote,"client_request_id":Uuid::new_v4()})),
            )
            .await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(denied["error"]["code"], "PAYMENT_REVIEWERS_UNAVAILABLE");
    }
    for table in ["payment_orders", "payment_checkout_slots", "payment_jobs"] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "rejected reviewer funding must not write {table}");
    }
    let quote = h.quote().await;
    let quote_id = Uuid::parse_str(quote["quote_id"].as_str().unwrap()).unwrap();
    let key = Uuid::new_v4();
    let (code, original) = h.create(quote_id, key).await;
    assert_eq!(code, StatusCode::OK);
    let unused_quote = h.quote().await;
    // A later role assignment makes the owner ineligible for new funding, never for recovery.
    let checker = h.checker;
    let user = h.user;
    h.install(runtime(user, checker, false)).await;
    let (_, capability) = h
        .request("GET", "/v1/payments/capabilities", &h.user_token, None)
        .await;
    assert_eq!(capability["enabled"], false);
    assert_eq!(
        capability["unavailable_reason"],
        "PAYMENT_REVIEWERS_UNAVAILABLE"
    );
    let (code, denied) = h
        .create(
            Uuid::parse_str(unused_quote["quote_id"].as_str().unwrap()).unwrap(),
            Uuid::new_v4(),
        )
        .await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(denied["error"]["code"], "PAYMENT_REVIEWERS_UNAVAILABLE");
    let (code, recovered) = h.create(quote_id, key).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(recovered["payment_id"], original["payment_id"]);
    assert_eq!(
        recovered["pay_amount_minor_cny"],
        original["pay_amount_minor_cny"]
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_orders")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM payment_jobs")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn first_switch_old_signature_and_new_quote_survive_normal_refresh_and_recovery() {
    let mut h = Harness::new(true).await;
    let old = h.legacy_quote().await;
    h.poll(xml(Utc::now().date_naive(), "8", "8")).await;
    let old_key = Uuid::new_v4();
    let (code, order) = h.create(old, old_key).await;
    assert_eq!(code, StatusCode::OK, "{order}");
    assert_eq!(order["pay_amount_minor_cny"], 1010);
    let id = order["payment_id"].clone();
    let fresh = h.quote().await;
    assert_eq!(fresh["rate_cny_per_100_hkd"], "100.00000000");
    assert_ne!(fresh["rate_evidence_sha256"], "a".repeat(64));
    h.state.payments = None;
    let (code, recovered) = h.create(old, old_key).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(recovered["payment_id"], id);
    assert_eq!(recovered["pay_amount_minor_cny"], 1010);
    let no_config = h
        .create(
            Uuid::parse_str(fresh["quote_id"].as_str().unwrap()).unwrap(),
            Uuid::new_v4(),
        )
        .await;
    assert_eq!(no_config.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM real_hkd_transactions")
            .fetch_one(&h.pool)
            .await
            .unwrap(),
        0
    );
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn immutable_evidence_304_same_xml_restart_and_old_xml_never_renew() {
    let h = Harness::new(true).await;
    let today = Utc::now().date_naive();
    let body = xml(today, "8", "8");
    h.poll(body.clone()).await;
    let before = h.status().await;
    assert_eq!(before["current"]["evidence_verified"], true);
    let id = before["current"]["snapshot_id"].clone();
    h.poll(body.clone()).await;
    h.due().await;
    let lease = test_support::claim_due(&h.pool, h.r())
        .await
        .unwrap()
        .unwrap();
    assert!(
        test_support::not_modified(&h.pool, h.r(), &lease)
            .await
            .unwrap()
    );
    fx::bootstrap(&h.pool, h.r()).await.unwrap();
    let after = h.status().await;
    for key in ["snapshot_id", "rate_at", "fetched_at", "expires_at"] {
        assert_eq!(after["current"][key], before["current"][key]);
    }
    let raw: Vec<u8> = sqlx::query_scalar(
        "SELECT raw_xml FROM payment_fx_evidence WHERE evidence_hash=sha256($1)",
    )
    .bind(&body)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(raw, body);
    let mut forged = serde_json::to_value(&h.r().policy.rate).unwrap();
    forged["rate_source_date"] = json!(today.to_string());
    forged["rate_evidence_sha256"] = json!("c".repeat(64));
    let unverified=sqlx::query("INSERT INTO payment_fx_snapshots(id,provenance,source_date,rate_snapshot,evidence_hash) VALUES($1,'ecb',$2,$3,$4)")
        .bind(Uuid::new_v4()).bind(today).bind(forged).bind(vec![0xcc_u8;32]).execute(&h.pool).await;
    assert!(
        unverified.is_err(),
        "An ECB snapshot cannot claim verified provenance without retained raw evidence"
    );
    let denied = sqlx::query("UPDATE payment_fx_evidence SET first_fetched_at=clock_timestamp()")
        .execute(&h.pool)
        .await;
    assert!(denied.is_err());
    h.poll(xml(today - Duration::days(1), "8", "8")).await;
    let held = h.status().await;
    assert_eq!(held["state"], "held");
    assert_eq!(held["current"]["snapshot_id"], id);
    assert_eq!(
        held["current"]["expires_at"],
        before["current"]["expires_at"]
    );
    h.poll(body).await;
    assert_eq!(h.status().await["state"], "ready");
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn bad_or_future_evidence_cannot_be_activated_and_clean_active_recovers_temporary_holds() {
    let h = Harness::new(true).await;
    let today = Utc::now().date_naive();
    let good = xml(today, "8", "8");
    h.poll(good.clone()).await;
    let original = h.status().await;
    for bad in [
        b"<!DOCTYPE x [<!ENTITY e 'bad'>]><x/>".to_vec(),
        xml(today + Duration::days(1), "8", "8"),
        xml(today, "0", "8"),
        String::from_utf8(xml(today, "8", "8"))
            .unwrap()
            .replace("currency=\"HKD\"", "currency=\"USD\"")
            .into_bytes(),
    ] {
        h.poll(bad).await;
        let status = h.status().await;
        assert_eq!(status["state"], "held");
        assert!(status["candidate"].is_null());
        let (code,_)=h.request("POST","/v1/payments/fx/activations",&h.maker_token,Some(json!({"candidate_id":Uuid::new_v4(),"evidence_sha256":"a".repeat(64),"expected_generation":status["generation"],"reason":"Do not allow invalid public evidence"}))).await;
        assert_eq!(code, StatusCode::CONFLICT);
        h.poll(good.clone()).await;
        let restored = h.status().await;
        assert_eq!(restored["state"], "ready");
        assert_eq!(
            restored["current"]["snapshot_id"],
            original["current"]["snapshot_id"]
        );
        assert_eq!(
            restored["current"]["expires_at"],
            original["current"]["expires_at"]
        );
    }
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn review_candidate_survives_bad_then_old_clean_xml_and_activation_is_fenced() {
    let h = Harness::new(true).await;
    let today = Utc::now().date_naive();
    let good = xml(today, "8", "8");
    h.poll(good.clone()).await;
    h.poll(xml(today, "8.01", "8")).await;
    let status = h.status().await;
    assert_eq!(status["hold_reason"], "same_date_rewrite");
    assert_eq!(status["candidate"]["manual_activation_allowed"], true);
    let candidate = status["candidate"]["id"].clone();
    h.poll(b"bad XML".to_vec()).await;
    h.poll(good).await;
    let held = h.status().await;
    assert_eq!(held["state"], "held");
    assert_eq!(held["candidate"]["id"], candidate);
    let (ordinary, _) = h
        .request("GET", "/v1/payments/fx/status", &h.user_token, None)
        .await;
    assert_eq!(ordinary, StatusCode::FORBIDDEN);
    let body = json!({"candidate_id":candidate,"evidence_sha256":held["candidate"]["evidence_sha256"],"expected_generation":held["generation"],"reason":"Verified the fixed ECB source and original XML evidence"});
    let mut stale = body.clone();
    stale["expected_generation"] = json!(0);
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/fx/activations",
            &h.maker_token,
            Some(stale)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/fx/activations",
            &h.maker_token,
            Some(body)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(h.status().await["state"], "ready");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM payment_fx_activations")
            .fetch_one(&h.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM real_hkd_transactions")
            .fetch_one(&h.pool)
            .await
            .unwrap(),
        0
    );
    let (audit_code, audit) = h
        .request("GET", "/v1/payments/operator/audit", &h.maker_token, None)
        .await;
    assert_eq!(audit_code, StatusCode::OK);
    let event = audit["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["action"] == "fx_candidate_activated")
        .unwrap();
    assert_eq!(event["details"]["snapshot_id"], candidate);
    assert!(event["details"]["evidence_sha256"].is_string());
    let mut revoked = runtime(h.user, h.checker, true);
    revoked.policy.rate = h.r().policy.rate.clone();
    operator::sync_operator_policy(&h.pool, &revoked)
        .await
        .unwrap();
    assert_eq!(
        h.request("GET", "/v1/payments/fx/status", &h.maker_token, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn shared_lease_expiry_and_policy_generation_reject_late_results() {
    let mut h = Harness::new(true).await;
    let (a, b) = tokio::join!(
        test_support::claim_due(&h.pool, h.r()),
        test_support::claim_due(&h.pool, h.r())
    );
    let lease = a.unwrap().or(b.unwrap()).unwrap();
    assert!(
        test_support::claim_due(&h.pool, h.r())
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE payment_fx_state SET leased_until=clock_timestamp()-interval '1 second'")
        .execute(&h.pool)
        .await
        .unwrap();
    let current = test_support::claim_due(&h.pool, h.r())
        .await
        .unwrap()
        .unwrap();
    let good = xml(Utc::now().date_naive(), "8", "8");
    assert!(
        !test_support::xml(&h.pool, h.r(), &lease, good.clone())
            .await
            .unwrap()
    );
    assert!(
        test_support::xml(&h.pool, h.r(), &current, good.clone())
            .await
            .unwrap()
    );
    h.due().await;
    let old = test_support::claim_due(&h.pool, h.r())
        .await
        .unwrap()
        .unwrap();
    let mut changed = runtime(h.maker, h.checker, true);
    changed.policy.fee_basis_points = 200;
    changed = PaymentRuntime::new(
        changed.client.clone(),
        changed.merchant_id.clone(),
        changed.policy.clone(),
    )
    .unwrap();
    changed.auto_fx_refresh = true;
    h.install(changed).await;
    assert!(!test_support::xml(&h.pool, h.r(), &old, good).await.unwrap());
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn business_policy_and_credential_changes_reject_old_quotes() {
    for credential_change in [false, true] {
        let mut h = Harness::new(true).await;
        let old = h.legacy_quote().await;
        let prior = h.r();
        let mut policy = prior.policy.clone();
        if !credential_change {
            policy.fee_basis_points += 1;
        }
        let version = if credential_change {
            "fixture-v2"
        } else {
            "fixture-v1"
        };
        let mut r = PaymentRuntime::new_versioned(
            vec![ProviderVersion {
                version: version.into(),
                merchant_id: prior.merchant_id.clone(),
                client: prior.client.clone(),
            }],
            version.into(),
            policy,
        )
        .unwrap();
        r.auto_fx_refresh = true;
        h.install(r).await;
        assert_eq!(h.create(old, Uuid::new_v4()).await.0, StatusCode::CONFLICT);
        h.close().await;
    }
}

#[tokio::test]
#[ignore]
async fn manual_rate_status_and_quotes_follow_the_same_current_config_with_alerts() {
    let mut h = Harness::new(false).await;
    let old = h.status().await;
    let mut p = h.r().policy.clone();
    p.rate.rate_cny_per_100_hkd = "110".into();
    p.rate.rate_at = Utc::now() - Duration::hours(91);
    p.rate.rate_fetched_at = p.rate.rate_at;
    p.rate.rate_source_date = p.rate.rate_at.date_naive().to_string();
    p.rate.rate_evidence_sha256 = "b".repeat(64);
    let r = PaymentRuntime::new(h.r().client.clone(), h.r().merchant_id.clone(), p).unwrap();
    h.install(r).await;
    let status = h.status().await;
    assert_eq!(status["mode"], "manual");
    assert_eq!(status["current"]["rate_cny_per_100_hkd"], "110");
    assert_ne!(
        status["current"]["rate_cny_per_100_hkd"],
        old["current"]["rate_cny_per_100_hkd"]
    );
    assert_eq!(status["alerts"]["within_24h"], true);
    assert_eq!(status["alerts"]["within_6h"], true);
    let q = h.quote().await;
    assert_eq!(q["rate_cny_per_100_hkd"], "110");
    assert_eq!(q["pay_amount_minor_cny"], 1111);
    assert_eq!(status["current"]["evidence_verified"], false);
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn v2_accepted_quote_keeps_original_amount_after_a_normal_new_daily_rate() {
    let h = Harness::new(true).await;
    let quote = h.quote().await;
    h.poll(xml(Utc::now().date_naive(), "8.04", "8")).await;
    let status = h.status().await;
    assert_eq!(status["state"], "ready");
    let (code, order) = h
        .create(
            Uuid::parse_str(quote["quote_id"].as_str().unwrap()).unwrap(),
            Uuid::new_v4(),
        )
        .await;
    assert_eq!(code, StatusCode::OK, "{order}");
    assert_eq!(order["pay_amount_minor_cny"], quote["pay_amount_minor_cny"]);
    assert_eq!(order["rate_evidence_sha256"], quote["rate_evidence_sha256"]);
    let next = h.quote().await;
    assert_eq!(next["rate_cny_per_100_hkd"], "100.50000000");
    assert_ne!(next["pay_amount_minor_cny"], quote["pay_amount_minor_cny"]);
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn jump_hold_is_a_safety_stop_and_same_day_reversion_still_requires_review() {
    let h = Harness::new(true).await;
    let quote = h.legacy_quote().await;
    let today = Utc::now().date_naive();
    h.poll(xml(today, "8.16", "8")).await;
    let status = h.status().await;
    assert_eq!(status["hold_reason"], "rate_jump");
    assert_eq!(status["candidate"]["manual_activation_allowed"], true);
    assert_eq!(
        h.create(quote, Uuid::new_v4()).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    h.poll(xml(today, "8", "8")).await;
    let changed = h.status().await;
    assert_eq!(changed["state"], "held");
    assert_eq!(changed["hold_reason"], "same_date_rewrite");
    assert!(changed["candidate"]["id"].is_string());
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn failure_backoff_and_disabling_auto_fence_a_running_worker_without_renewing_rate() {
    let mut h = Harness::new(true).await;
    let before = h.status().await;
    let lease = test_support::claim_due(&h.pool, h.r())
        .await
        .unwrap()
        .unwrap();
    assert!(
        test_support::network_failure(&h.pool, h.r(), &lease)
            .await
            .unwrap()
    );
    let after = h.status().await;
    assert_eq!(
        after["current"]["expires_at"],
        before["current"]["expires_at"]
    );
    assert_eq!(after["last_error_code"], "fx_network");
    assert!(
        test_support::claim_due(&h.pool, h.r())
            .await
            .unwrap()
            .is_none()
    );
    h.due().await;
    let old = test_support::claim_due(&h.pool, h.r())
        .await
        .unwrap()
        .unwrap();
    let r = runtime(h.maker, h.checker, false);
    h.install(r).await;
    assert!(
        !test_support::xml(&h.pool, h.r(), &old, xml(Utc::now().date_naive(), "8", "8"))
            .await
            .unwrap()
    );
    assert!(
        test_support::claim_due(&h.pool, h.r())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(h.status().await["mode"], "manual");
    h.close().await;
}

#[tokio::test]
#[ignore]
async fn stale_review_cannot_reactivate_a_recurring_candidate_after_another_decision() {
    let h = Harness::new(true).await;
    let today = Utc::now().date_naive();
    let good = xml(today, "8", "8");
    let amended = xml(today, "8.01", "8");
    h.poll(good.clone()).await;
    h.poll(amended.clone()).await;
    let a = h.status().await;
    let old_request = json!({"candidate_id":a["candidate"]["id"],"evidence_sha256":a["candidate"]["evidence_sha256"],"expected_generation":a["generation"],"reason":"Verified original public evidence for the first explicit decision"});
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/fx/activations",
            &h.maker_token,
            Some(old_request.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    h.poll(good).await;
    let b = h.status().await;
    let revert = json!({"candidate_id":b["candidate"]["id"],"evidence_sha256":b["candidate"]["evidence_sha256"],"expected_generation":b["generation"],"reason":"Verified the restored public evidence in a separate decision"});
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/fx/activations",
            &h.maker_token,
            Some(revert)
        )
        .await
        .0,
        StatusCode::OK
    );
    h.poll(amended).await;
    let current = h.status().await;
    assert_eq!(current["candidate"]["id"], a["candidate"]["id"]);
    assert_ne!(current["generation"], a["generation"]);
    assert_eq!(
        h.request(
            "POST",
            "/v1/payments/fx/activations",
            &h.maker_token,
            Some(old_request)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    h.close().await;
}
