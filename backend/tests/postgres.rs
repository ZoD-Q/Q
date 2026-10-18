//! Real PostgreSQL tests. Each test migrates its own schema and removes it afterward.
//! TEST_DATABASE_URL=postgresql://... cargo test --test postgres -- --ignored
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, app, identity,
    ledger::{TransferRequest, execute_transfer},
};

struct Harness {
    router: Router,
    state: AppState,
    admin: PgPool,
    schema: String,
}
impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("Set TEST_DATABASE_URL to a real PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |conn, _| {
                let search_path = search_path.clone();
                Box::pin(async move {
                    sqlx::query(&search_path).execute(conn).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let state = AppState::new(pool).await.unwrap();
        let router = app(
            state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        );
        Self {
            router,
            state,
            admin,
            schema,
        }
    }
    async fn finish(self) {
        self.state.pool.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
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
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("Content-Type", "application/json");
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
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
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
            body["token"].as_str().unwrap().to_owned(),
            Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        )
    }
    async fn balance(&self, token: &str) -> i64 {
        let (status, body) = self.request("GET", "/v1/wallet", Some(token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["currency"], "QDC");
        assert_eq!(body["mode"], "demo");
        body["balance_minor"].as_i64().unwrap()
    }
    async fn journal_count(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM ledger_entries")
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }
    async fn assert_balanced(&self) {
        let balanced: bool =
            sqlx::query_scalar("SELECT coalesce(sum(delta_minor),0) = 0 FROM ledger_entries")
                .fetch_one(&self.state.pool)
                .await
                .unwrap();
        assert!(balanced);
        let mismatched: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_accounts a WHERE a.balance_minor <> (SELECT coalesce(sum(e.delta_minor),0) FROM ledger_entries e WHERE e.account_id = a.id)").fetch_one(&self.state.pool).await.unwrap();
        assert_eq!(mismatched, 0);
        let negative_users: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM ledger_accounts WHERE kind = 'user' AND balance_minor < 0",
        )
        .fetch_one(&self.state.pool)
        .await
        .unwrap();
        assert_eq!(negative_users, 0);
    }
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn api_auth_profiles_privacy_transfers_and_revocation() {
    let h = Harness::new().await;
    assert_eq!(
        h.request("GET", "/health", None, None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        h.request("GET", "/v1/wallet", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (alice, alice_id) = h.register("Alice").await;
    let (bob, _) = h.register("bob").await;
    assert_eq!(h.balance(&alice).await, 100_000);
    assert_eq!(h.balance(&bob).await, 100_000);
    let (status, _) = h
        .request(
            "POST",
            "/v1/auth/register",
            None,
            Some(
                json!({"handle":"ALICE","password":"TestPassword123!","display_name":"duplicate"}),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, user) = h
        .request(
            "PATCH",
            "/v1/me",
            Some(&alice),
            Some(json!({"theme":"dark","locale":"en","display_name":"Alice edited","bio":"Hello"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(user["theme"], "dark");
    assert_eq!(user["display_name"], "Alice edited");
    assert!(user.get("password_hash").is_none());
    assert_eq!(
        h.request(
            "PATCH",
            "/v1/me",
            Some(&alice),
            Some(json!({"theme":"purple"}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        h.request(
            "PATCH",
            "/v1/me",
            Some(&alice),
            Some(json!({"balance_minor":1000000}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, recipient) = h
        .request("GET", "/v1/users/lookup?handle=BOB", Some(&alice), None)
        .await;
    assert_eq!(recipient.as_object().unwrap().len(), 4);
    assert!(recipient.get("theme").is_none());

    let key = Uuid::new_v4();
    let request = json!({"recipient_handle":"bob","amount_minor":1234,"memo":"test transfer","idempotency_key":key});
    let (status, first) = h
        .request(
            "POST",
            "/v1/wallet/transfers",
            Some(&alice),
            Some(request.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["replayed"], false);
    assert_eq!(h.balance(&alice).await, 98_766);
    assert_eq!(h.balance(&bob).await, 101_234);
    h.request(
        "PATCH",
        "/v1/me",
        Some(&bob),
        Some(json!({"display_name":"changed recipient name"})),
    )
    .await;
    let (status, replayed) = h
        .request(
            "POST",
            "/v1/wallet/transfers",
            Some(&alice),
            Some(request.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["transfer_id"], first["transfer_id"]);
    assert_eq!(replayed["balance_minor"], first["balance_minor"]);
    assert_eq!(replayed["replayed"], true);
    assert_eq!(h.journal_count().await, 6);
    for different in [
        json!({"recipient_handle":"missing_user","amount_minor":1234,"memo":"test transfer","idempotency_key":key}),
        json!({"recipient_handle":"bob","amount_minor":1235,"memo":"test transfer","idempotency_key":key}),
    ] {
        let (status, body) = h
            .request(
                "POST",
                "/v1/wallet/transfers",
                Some(&alice),
                Some(different),
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["error"]["code"], "IDEMPOTENCY_CONFLICT");
    }
    let (_, ahistory) = h
        .request("GET", "/v1/wallet/transactions", Some(&alice), None)
        .await;
    let (_, bhistory) = h
        .request("GET", "/v1/wallet/transactions", Some(&bob), None)
        .await;
    assert_eq!(ahistory["items"][0]["direction"], "out");
    assert_eq!(bhistory["items"][0]["direction"], "in");
    assert_eq!(ahistory["items"][0]["id"], bhistory["items"][0]["id"]);
    for (amount, recipient_handle, expected) in [
        (99_000, "bob", "INSUFFICIENT_FUNDS"),
        (1, "alice", "SELF_TRANSFER"),
    ] {
        let (_, body) = h.request("POST", "/v1/wallet/transfers", Some(&alice), Some(json!({"recipient_handle":recipient_handle,"amount_minor":amount,"memo":"","idempotency_key":Uuid::new_v4()}))).await;
        assert_eq!(body["error"]["code"], expected);
    }
    assert_eq!(h.journal_count().await, 6);
    h.assert_balanced().await;

    for handle in ["alice", "nobody_here"] {
        let (status, body) = h
            .request(
                "POST",
                "/v1/auth/login",
                None,
                Some(json!({"handle":handle,"password":"wrong password"})),
            )
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"]["code"], "INVALID_CREDENTIALS");
    }
    let (status, logged_in) = h
        .request(
            "POST",
            "/v1/auth/login",
            None,
            Some(json!({"handle":"alice","password":"TestPassword123!"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(logged_in["user"]["theme"], "dark");
    let second_token = logged_in["token"].as_str().unwrap();
    assert_ne!(second_token, alice);
    assert_eq!(
        h.request("POST", "/v1/auth/logout", Some(second_token), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        h.request("GET", "/v1/me", Some(second_token), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE user_id = $1").bind(alice_id).execute(&h.state.pool).await.unwrap();
    assert_eq!(
        h.request("GET", "/v1/me", Some(&alice), None).await.0,
        StatusCode::UNAUTHORIZED
    );
    h.finish().await;
}

fn transfer_request(recipient: &str, amount: i64, key: Uuid) -> TransferRequest {
    TransferRequest {
        recipient_handle: recipient.into(),
        amount_minor: amount,
        memo: "concurrency".into(),
        idempotency_key: key,
    }
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn concurrent_spending_duplicate_retries_and_sender_scoped_keys() {
    let h = Harness::new().await;
    let (alice, alice_id) = h.register("alice").await;
    let (bob, bob_id) = h.register("bob").await;
    let (carol, _) = h.register("carol").await;
    let pool = &h.state.pool;
    let (left, right) = tokio::join!(
        execute_transfer(
            pool,
            alice_id,
            transfer_request("bob", 80_000, Uuid::new_v4())
        ),
        execute_transfer(
            pool,
            alice_id,
            transfer_request("carol", 80_000, Uuid::new_v4())
        )
    );
    assert_eq!(usize::from(left.is_ok()) + usize::from(right.is_ok()), 1);
    assert_eq!(
        left.err().or_else(|| right.err()).unwrap().code,
        "INSUFFICIENT_FUNDS"
    );
    assert_eq!(h.balance(&alice).await, 20_000);
    assert_eq!(h.balance(&bob).await + h.balance(&carol).await, 280_000);
    assert_eq!(h.journal_count().await, 8);

    let key = Uuid::new_v4();
    let (a, b) = tokio::join!(
        execute_transfer(pool, alice_id, transfer_request("bob", 1_000, key)),
        execute_transfer(pool, alice_id, transfer_request("bob", 1_000, key))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.transfer_id, b.transfer_id);
    assert_ne!(a.replayed, b.replayed);
    assert_eq!(h.balance(&alice).await, 19_000);
    assert_eq!(h.journal_count().await, 10);
    // The same UUID belongs to a different sender namespace and is a new transfer.
    assert!(
        !execute_transfer(pool, bob_id, transfer_request("alice", 1_000, key))
            .await
            .unwrap()
            .replayed
    );
    let opposing = async {
        tokio::join!(
            execute_transfer(pool, alice_id, transfer_request("bob", 1, Uuid::new_v4())),
            execute_transfer(pool, bob_id, transfer_request("alice", 1, Uuid::new_v4()))
        )
    };
    let (a, b) = tokio::time::timeout(std::time::Duration::from_secs(5), opposing)
        .await
        .expect("opposing transfers must not deadlock");
    assert!(a.is_ok() && b.is_ok());
    h.assert_balanced().await;
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL (real PostgreSQL)"]
async fn database_rejects_mutations_unbalanced_posts_and_seed_recredits() {
    let h = Harness::new().await;
    identity::seed_demo(&h.state).await.unwrap();
    identity::seed_demo(&h.state).await.unwrap();
    assert_eq!(h.journal_count().await, 4);
    let pool = &h.state.pool;
    let treasury: i64 =
        sqlx::query_scalar("SELECT balance_minor FROM ledger_accounts WHERE kind = 'treasury'")
            .fetch_one(pool)
            .await
            .unwrap();
    assert_eq!(treasury, -200_000);
    assert!(
        sqlx::query("UPDATE ledger_entries SET delta_minor = 0")
            .execute(pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("DELETE FROM ledger_entries")
            .execute(pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE ledger_transactions SET memo = 'edited'")
            .execute(pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query(
            "UPDATE ledger_accounts SET balance_minor = balance_minor + 1 WHERE kind = 'user'"
        )
        .execute(pool)
        .await
        .is_err()
    );
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("INSERT INTO ledger_transactions(id,kind,sender_account_id,recipient_account_id,amount_minor,memo,sender_balance_after) SELECT $1,kind,sender_account_id,recipient_account_id,amount_minor,memo,sender_balance_after FROM ledger_transactions LIMIT 1")
        .bind(Uuid::new_v4()).execute(&mut *tx).await.unwrap();
    assert!(tx.commit().await.is_err());
    assert_eq!(h.journal_count().await, 4);
    h.assert_balanced().await;
    h.finish().await;
}
