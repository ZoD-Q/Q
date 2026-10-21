//! PostgreSQL acceptance for owner-isolated, simulated HKD bank accounts.
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{AppState, app, banking, ledger::bank_demo};

struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl Harness {
    async fn new() -> Self {
        let url =
            std::env::var("TEST_DATABASE_URL").expect("use a dedicated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_bank_ledger_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .after_connect(move |connection, _| {
                let command = search_path.clone();
                Box::pin(async move {
                    sqlx::query(&command).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        Self {
            state: AppState::new(pool).await.unwrap(),
            admin,
            schema,
        }
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
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = app(self.state.clone(), vec![])
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        if path.starts_with("/v1/banking/") {
            assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
        }
        let bytes = to_bytes(response.into_body(), 2_000_000).await.unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"non_json":String::from_utf8_lossy(&bytes)}));
        (status, value)
    }
    async fn ok(&self, method: &str, path: &str, token: &str, body: Option<Value>) -> Value {
        let (status, value) = self.request(method, path, Some(token), body).await;
        assert!(status.is_success(), "{method} {path}: {status} {value}");
        value
    }
    async fn register(&self) -> (String, Uuid) {
        let body=self.ok("POST","/v1/auth/register","",Some(json!({"handle":format!("bk{}",&Uuid::new_v4().simple().to_string()[..16]),"password":"LocalBankQaPassword!","display_name":"Bank ledger QA"}))).await;
        (
            body["token"].as_str().unwrap().into(),
            Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        )
    }
    async fn connect(&self, token: &str, banks: Vec<&str>) -> Value {
        self.ok(
            "POST",
            "/v1/banking/connect",
            token,
            Some(json!({"bank_ids":banks})),
        )
        .await
    }
    async fn proposal(
        &self,
        token: &str,
        connection: &str,
        amount: i64,
        recipient: &str,
        key: Uuid,
    ) -> Value {
        self.ok("POST","/v1/plugins/invocations",token,Some(json!({"connection_id":connection,"tool_name":"bank_transfer","arguments":{"to_bank_id":"bochk","recipient":recipient,"amount_minor":amount,"memo":"private banking note"},"idempotency_key":key}))).await
    }
    async fn confirm(&self, token: &str, proposal: &Value) -> Value {
        self.ok(
            "POST",
            &format!(
                "/v1/plugins/invocations/{}/confirm",
                proposal["id"].as_str().unwrap()
            ),
            token,
            Some(json!({"confirmed":true})),
        )
        .await
    }
    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.state.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
fn connection(wallet: &Value, bank: &str) -> String {
    wallet["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["bank_id"] == bank)
        .unwrap()["connection_id"]
        .as_str()
        .unwrap()
        .into()
}
fn balance(wallet: &Value, bank: &str) -> i64 {
    wallet["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["bank_id"] == bank)
        .unwrap()["balance_minor"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn twenty_banks_initialize_once_per_owner_with_balanced_issuance_and_no_qdc_changes() {
    let h = Harness::new().await;
    let (token, user) = h.register().await;
    let (other, other_user) = h.register().await;
    assert_eq!(
        h.ok("GET", "/v1/banking/wallet", &token, None).await["accounts"],
        json!([])
    );
    let qdc = h.ok("GET", "/v1/wallet", &token, None).await;
    let banks = banking::BANKS.iter().map(|b| b.id).collect::<Vec<_>>();
    let w = h.connect(&token, banks.clone()).await;
    assert_eq!(w["accounts"].as_array().unwrap().len(), 20);
    assert_eq!(w["total_balance_minor"], 200_000_000_i64);
    for a in w["accounts"].as_array().unwrap() {
        assert_eq!(a["balance_minor"], 10_000_000);
        assert!(a["masked_number"].as_str().unwrap().starts_with("DEMO "));
    }
    assert_eq!(h.connect(&token, banks).await, w);
    assert_eq!(h.count("bank_demo_accounts").await, 41);
    assert_eq!(h.count("bank_demo_transactions").await, 40);
    assert_eq!(h.count("bank_demo_entries").await, 80);
    let net: i64 = sqlx::query_scalar(
        "SELECT sum(balance_minor)::bigint FROM bank_demo_accounts WHERE user_id=$1",
    )
    .bind(user)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(net, 0);
    assert_eq!(h.ok("GET", "/v1/wallet", &token, None).await, qdc);
    assert_eq!(
        h.ok("GET", "/v1/banking/wallet", &other, None).await["accounts"],
        json!([])
    );
    let other_wallet = h.connect(&other, vec!["hsbc"]).await;
    assert_ne!(w["accounts"][0]["id"], other_wallet["accounts"][0]["id"]);
    let other_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM bank_demo_accounts WHERE user_id=$1")
            .bind(other_user)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(other_count, 3);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn confirmed_transfer_receipt_and_wallet_entries_share_one_transaction_and_recover_after_reconnect()
 {
    let h = Harness::new().await;
    let (token, _) = h.register().await;
    let (other, _) = h.register().await;
    let wallet = h.connect(&token, vec!["hsbc", "bochk"]).await;
    let source = connection(&wallet, "hsbc");
    let key = Uuid::new_v4();
    let proposal = h.proposal(&token, &source, 50_000, "self", key).await;
    assert_eq!(proposal["status"], "awaiting_confirmation");
    assert_eq!(
        h.ok("GET", "/v1/banking/wallet", &token, None).await,
        wallet
    );
    let foreign = h
        .request(
            "POST",
            &format!(
                "/v1/plugins/invocations/{}/confirm",
                proposal["id"].as_str().unwrap()
            ),
            Some(&other),
            Some(json!({"confirmed":true})),
        )
        .await;
    assert_eq!(foreign.0, StatusCode::NOT_FOUND);
    let result = h.confirm(&token, &proposal).await;
    assert_eq!(result["status"], "succeeded");
    let receipt = &result["result"]["structuredContent"];
    assert_eq!(receipt["source_balance_minor"], 9_950_000);
    assert_eq!(receipt["destination_balance_minor"], 10_050_000);
    assert_eq!(h.confirm(&token, &proposal).await, result);
    assert_eq!(
        h.proposal(&token, &source, 50_000, "self", key).await,
        result
    );
    let changed=h.request("POST","/v1/plugins/invocations",Some(&token),Some(json!({"connection_id":source,"tool_name":"bank_transfer","arguments":{"to_bank_id":"bochk","recipient":"self","amount_minor":1},"idempotency_key":key}))).await;
    assert_eq!(changed.0, StatusCode::CONFLICT);
    let updated = h.ok("GET", "/v1/banking/wallet", &token, None).await;
    assert_eq!(balance(&updated, "hsbc"), 9_950_000);
    assert_eq!(balance(&updated, "bochk"), 10_050_000);
    assert_eq!(updated["total_balance_minor"], 20_000_000);
    let history = h.ok("GET", "/v1/banking/transactions", &token, None).await;
    assert_eq!(history["items"].as_array().unwrap().len(), 1);
    assert_eq!(history["items"][0]["id"], receipt["id"]);
    let entries = h.ok("GET", "/v1/banking/entries", &token, None).await;
    let posted = entries["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["kind"] == "transfer")
        .collect::<Vec<_>>();
    assert_eq!(posted.len(), 2);
    assert!(posted.iter().all(|e| e["transaction_id"] == receipt["id"]));
    assert!(posted.iter().any(|e| e["direction"] == "in"));
    assert!(posted.iter().any(|e| e["direction"] == "out"));
    h.ok(
        "DELETE",
        &format!("/v1/plugins/connections/{source}"),
        &token,
        None,
    )
    .await;
    let reconnected = h.connect(&token, vec!["hsbc"]).await;
    assert_eq!(balance(&reconnected, "hsbc"), 9_950_000);
    let chen = h
        .proposal(
            &token,
            &connection(&reconnected, "hsbc"),
            123,
            "demo_chen",
            Uuid::new_v4(),
        )
        .await;
    let received = h.confirm(&token, &chen).await;
    assert_eq!(received["status"], "succeeded");
    assert!(received["result"]["structuredContent"]["destination_balance_minor"].is_null());
    assert_eq!(
        h.ok("GET", "/v1/banking/transactions", &other, None).await["items"],
        json!([])
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn concurrent_transfers_cannot_overspend_and_cancellation_posts_no_entries() {
    let h = Harness::new().await;
    let (token, _) = h.register().await;
    let wallet = h.connect(&token, vec!["hsbc", "bochk"]).await;
    let source = connection(&wallet, "hsbc");
    let a = h
        .proposal(&token, &source, 7_000_000, "demo_chen", Uuid::new_v4())
        .await;
    let b = h
        .proposal(&token, &source, 7_000_000, "demo_chen", Uuid::new_v4())
        .await;
    let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        tokio::join!(h.confirm(&token, &a), h.confirm(&token, &b))
    })
    .await
    .unwrap();
    let statuses = [a["status"].as_str().unwrap(), b["status"].as_str().unwrap()];
    assert!(statuses.contains(&"succeeded"));
    assert!(statuses.contains(&"tool_error"));
    assert_eq!(
        balance(
            &h.ok("GET", "/v1/banking/wallet", &token, None).await,
            "hsbc"
        ),
        3_000_000
    );
    let entries = h.count("bank_demo_entries").await;
    let cancelled = h
        .proposal(&token, &source, 100, "self", Uuid::new_v4())
        .await;
    h.ok(
        "POST",
        &format!(
            "/v1/plugins/invocations/{}/cancel",
            cancelled["id"].as_str().unwrap()
        ),
        &token,
        Some(json!({})),
    )
    .await;
    assert_eq!(h.confirm(&token, &cancelled).await["status"], "cancelled");
    assert_eq!(h.count("bank_demo_entries").await, entries);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn immutable_journal_rejects_unbalanced_or_forged_cached_balances() {
    let h = Harness::new().await;
    let (token, user) = h.register().await;
    h.connect(&token, vec!["hsbc"]).await;
    assert!(
        sqlx::query("UPDATE bank_demo_transactions SET amount_minor=1 WHERE user_id=$1")
            .bind(user)
            .execute(&h.state.pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM bank_demo_entries WHERE user_id=$1")
            .bind(user)
            .execute(&h.state.pool)
            .await
            .is_err()
    );
    let mut tx = h.state.pool.begin().await.unwrap();
    sqlx::query("UPDATE bank_demo_accounts SET balance_minor=balance_minor+1 WHERE user_id=$1 AND participant='self'").bind(user).execute(&mut *tx).await.unwrap();
    assert!(tx.commit().await.is_err());
    let mut tx = h.state.pool.begin().await.unwrap();
    let own: Uuid = sqlx::query_scalar(
        "SELECT id FROM bank_demo_accounts WHERE user_id=$1 AND participant='self'",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let recipient: Uuid = sqlx::query_scalar(
        "SELECT id FROM bank_demo_accounts WHERE user_id=$1 AND participant='demo_chen'",
    )
    .bind(user)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO bank_demo_transactions(id,user_id,kind,invocation_id,request_fingerprint,source_account_id,destination_account_id,amount_minor,source_balance_after,destination_balance_after) VALUES($1,$2,'transfer',$3,$4,$5,$6,1,9999999,10000001)").bind(Uuid::new_v4()).bind(user).bind(Uuid::new_v4()).bind(vec![0_u8;32]).bind(own).bind(recipient).execute(&mut *tx).await.unwrap();
    assert!(tx.commit().await.is_err());
    assert_eq!(h.count("bank_demo_transactions").await, 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn pagination_keeps_all_entries_and_filters_do_not_expose_fictional_accounts() {
    let h = Harness::new().await;
    let (token, _) = h.register().await;
    h.connect(&token, banking::BANKS.iter().map(|b| b.id).collect())
        .await;
    let mut all = Vec::new();
    let mut cursor = None::<String>;
    loop {
        let path = format!(
            "/v1/banking/entries?limit=3{}",
            cursor
                .as_ref()
                .map_or(String::new(), |c| format!("&cursor={c}"))
        );
        let page = h.ok("GET", &path, &token, None).await;
        all.extend(page["items"].as_array().unwrap().iter().cloned());
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(all.len(), 20);
    let unique = all
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(unique.len(), 20);
    assert!(
        all.iter()
            .all(|e| e["direction"] == "in" && e["amount_minor"] == 10_000_000)
    );
    let filtered = h
        .ok("GET", "/v1/banking/entries?bank_id=hsbc", &token, None)
        .await;
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["bank_id"], "hsbc");
    for query in ["limit=0", "limit=101", "cursor=invalid", "bank_id=unknown"] {
        assert_eq!(
            h.request(
                "GET",
                &format!("/v1/banking/entries?{query}"),
                Some(&token),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated PostgreSQL test database"]
async fn account_deletion_erases_private_bank_notes_without_breaking_the_immutable_journal() {
    let h = Harness::new().await;
    let (token, user) = h.register().await;
    let wallet = h.connect(&token, vec!["hsbc", "bochk"]).await;
    let proposal = h
        .proposal(
            &token,
            &connection(&wallet, "hsbc"),
            100,
            "self",
            Uuid::new_v4(),
        )
        .await;
    h.confirm(&token, &proposal).await;
    let entries = h.count("bank_demo_entries").await;
    assert_eq!(h.count("bank_demo_private_memos").await, 1);
    let result=h.ok("POST","/v1/account/deletions",&token,Some(json!({"request_id":Uuid::new_v4(),"recovery_token":URL_SAFE_NO_PAD.encode([43_u8;32]),"password":"LocalBankQaPassword!","confirmation":"DELETE"}))).await;
    assert_eq!(result["status"], "deleted");
    assert_eq!(h.count("bank_demo_private_memos").await, 0);
    assert_eq!(h.count("bank_demo_entries").await, entries);
    assert_eq!(h.count("plugin_invocations").await, 0);
    assert_eq!(h.count("plugin_connections").await, 0);
    let enabled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM bank_demo_accounts WHERE user_id=$1 AND status='active'",
    )
    .bind(user)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(enabled, 0);
    assert_eq!(
        h.request("GET", "/v1/banking/wallet", Some(&token), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let mut tx = h.state.pool.begin().await.unwrap();
    assert!(
        bank_demo::ensure_accounts(&mut tx, user, &["hsbc".into()])
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    h.finish().await;
}
