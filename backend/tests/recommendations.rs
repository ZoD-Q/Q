//! Isolated PostgreSQL recommendation lifecycles; only explicit loopback model fixtures.
#![cfg(all(feature = "ai-test-fixtures", feature = "plugin-test-fixtures"))]
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState,
    ai::AiRuntime,
    app,
    plugins::{PluginRuntime, network::SafeHttp},
    recommendations::{catalog, matching},
};

struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
}

impl Harness {
    async fn new() -> Self {
        let url = std::env::var("TEST_DATABASE_URL").expect("dedicated TEST_DATABASE_URL required");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_recommendation_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .after_connect(move |connection, _| {
                let search_path = search_path.clone();
                Box::pin(async move {
                    sqlx::query(&search_path).execute(connection).await?;
                    Ok(())
                })
            })
            .connect(&url)
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let mut state = AppState::new(pool).await.unwrap();
        state.recommendations_enabled = true;
        state.plugins = Some(Arc::new(PluginRuntime::test_fixture(
            SafeHttp::default(),
            None,
            None,
        )));
        Self {
            state,
            admin,
            schema,
        }
    }

    fn router(&self) -> Router {
        app(
            self.state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        )
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if !token.is_empty() {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = self
            .router()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                    .unwrap(),
            )
            .await
            .unwrap();
        if path.starts_with("/v1/ai/recommendations") {
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        response
    }

    async fn json(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
        status: StatusCode,
    ) -> Value {
        let response = self.request(method, path, token, body).await;
        let actual = response.status();
        let body = read_json(response).await;
        assert_eq!(actual, status, "{method} {path}: {body}");
        body
    }

    async fn register(&self, handle: &str) -> (String, Uuid) {
        let body = self
            .json(
                "POST",
                "/v1/auth/register",
                "",
                Some(json!({"handle":handle,"display_name":handle,"password":"LocalQaPassword!"})),
                StatusCode::CREATED,
            )
            .await;
        let user: Uuid = sqlx::query_scalar("SELECT id FROM identities WHERE handle=$1")
            .bind(handle)
            .fetch_one(&self.state.pool)
            .await
            .unwrap();
        (body["token"].as_str().unwrap().to_owned(), user)
    }

    async fn save(&self, token: &str, prompt: &str) -> (Uuid, String, Value) {
        let id = Uuid::new_v4();
        let message = Uuid::new_v4().to_string();
        let body = json!({"request_id":Uuid::new_v4(),"expected_revision":0,"title":"Recommendation source","messages":[
            {"id":message,"role":"user","content":prompt,"status":"complete","toolInvocationIds":[]},
            {"id":Uuid::new_v4(),"role":"assistant","content":"","status":"pending"}
        ]});
        self.json(
            "POST",
            &format!("/v1/ai/conversations/{id}"),
            token,
            Some(body.clone()),
            StatusCode::OK,
        )
        .await;
        (id, message, body)
    }

    async fn recommend(&self, token: &str, conversation: Uuid, message: &str) -> Value {
        self.json(
            "POST",
            "/v1/ai/recommendations",
            token,
            Some(recommend_request(conversation, message)),
            StatusCode::OK,
        )
        .await
    }

    async fn select(
        &self,
        token: &str,
        record: &Value,
        candidate: &str,
        status: StatusCode,
    ) -> Value {
        self.json(
            "POST",
            &format!(
                "/v1/ai/recommendations/{}/select",
                record["id"].as_str().unwrap()
            ),
            token,
            Some(json!({"candidate_id":candidate})),
            status,
        )
        .await
    }

    async fn connect_bank(&self, token: &str) -> Uuid {
        let wallet = self
            .json(
                "POST",
                "/v1/banking/connect",
                token,
                Some(json!({"bank_ids":["hsbc"]})),
                StatusCode::OK,
            )
            .await;
        Uuid::parse_str(wallet["accounts"][0]["connection_id"].as_str().unwrap()).unwrap()
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

async fn read_json(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 2_000_000).await.unwrap()).unwrap()
}

fn recommend_request(conversation: Uuid, message: &str) -> Value {
    json!({"conversation_id":conversation,"source_message_id":message,"request_id":Uuid::new_v4(),"locale":"en"})
}

fn contains_candidate(record: &Value, id: &str) -> bool {
    record["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .any(|candidate| candidate["id"] == id)
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn selection_is_atomic_owner_scoped_recoverable_and_does_not_execute() {
    let h = Harness::new().await;
    let (token, owner) = h.register("reco_owner").await;
    let (other, _) = h.register("reco_other").await;
    h.connect_bank(&token).await;
    let (conversation, message, mut source) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    let request = recommend_request(conversation, &message);
    let record = h
        .json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::OK,
        )
        .await;
    assert!(contains_candidate(&record, "bank:hsbc"), "{record}");
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::OK
        )
        .await,
        record
    );
    h.json(
        "POST",
        "/v1/ai/recommendations",
        &other,
        Some(request),
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "GET",
        &format!("/v1/ai/recommendations?conversation_id={conversation}"),
        &other,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    h.select(&other, &record, "bank:hsbc", StatusCode::NOT_FOUND)
        .await;
    h.select(&token, &record, "connection:forged", StatusCode::NOT_FOUND)
        .await;

    // Streaming the answer changes history revision, but not this question's content digest.
    source["expected_revision"] = json!(1);
    source["request_id"] = json!(Uuid::new_v4());
    source["messages"][1]["content"] = json!("I can help with your demo bank account.");
    source["messages"][1]["status"] = json!("complete");
    h.json(
        "POST",
        &format!("/v1/ai/conversations/{conversation}"),
        &token,
        Some(source),
        StatusCode::OK,
    )
    .await;
    let (left, right) = tokio::join!(
        h.select(&token, &record, "bank:hsbc", StatusCode::OK),
        h.select(&token, &record, "bank:hsbc", StatusCode::OK)
    );
    assert_ne!(left["created"], right["created"]);
    assert_eq!(left["conversation"]["id"], right["conversation"]["id"]);
    assert_eq!(
        left["conversation"]["messages"].as_array().unwrap().len(),
        1
    );
    assert_eq!(left["conversation"]["revision"], 1);
    let target = left["conversation"]["id"].as_str().unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_invocations WHERE user_id=$1")
        .bind(owner)
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "selection must never invoke business tools");
    let selections: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ai_recommendation_selections WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(selections, 1);
    let mut messages = left["conversation"]["messages"].as_array().unwrap().clone();
    messages.push(json!({"id":Uuid::new_v4(),"role":"assistant","content":"Saved continuation","status":"complete"}));
    let mut continuation = json!({"request_id":Uuid::new_v4(),"expected_revision":1,"title":"Continued task","messages":messages,"plugin":left["conversation"]["plugin"]});
    h.json(
        "POST",
        &format!("/v1/ai/conversations/{target}"),
        &token,
        Some(continuation.clone()),
        StatusCode::OK,
    )
    .await;
    let restored = h.select(&token, &record, "bank:hsbc", StatusCode::OK).await;
    assert_eq!(restored["created"], false);
    assert_eq!(restored["conversation"]["revision"], 2);
    assert_eq!(
        restored["conversation"]["messages"][1]["content"],
        "Saved continuation"
    );
    let observed: (Option<String>, bool) = sqlx::query_as(
        "SELECT outcome,finished_at IS NOT NULL FROM ai_recommendation_selections WHERE user_id=$1",
    )
    .bind(owner)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(observed, (Some("answered".into()), true));
    continuation["request_id"] = json!(Uuid::new_v4());
    h.json(
        "POST",
        &format!("/v1/ai/conversations/{target}"),
        &token,
        Some(continuation),
        StatusCode::CONFLICT,
    )
    .await;
    // Exercise the FK cleanup directly; the current history API has no single-delete route.
    sqlx::query("DELETE FROM ai_conversations WHERE user_id=$1 AND id=$2")
        .bind(owner)
        .bind(Uuid::parse_str(target).unwrap())
        .execute(&h.state.pool)
        .await
        .unwrap();
    let deleted = h
        .select(&token, &record, "bank:hsbc", StatusCode::CONFLICT)
        .await;
    assert_eq!(deleted["error"]["code"], "RECOMMENDATION_STALE");
    let tombstone: Option<Uuid> = sqlx::query_scalar(
        "SELECT conversation_id FROM ai_recommendation_selections WHERE user_id=$1",
    )
    .bind(owner)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(tombstone, None);
    sqlx::query("DELETE FROM ai_conversations WHERE user_id=$1 AND id=$2")
        .bind(owner)
        .bind(conversation)
        .execute(&h.state.pool)
        .await
        .unwrap();
    let counts: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM ai_recommendations),(SELECT count(*) FROM ai_recommendation_selections)").fetch_one(&h.state.pool).await.unwrap();
    assert_eq!(counts, (0, 0));
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn connect_return_and_permission_changes_are_rechecked() {
    let h = Harness::new().await;
    let (token, _) = h.register("reco_connect").await;
    let (conversation, message, mut source) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    let record = h.recommend(&token, conversation, &message).await;
    let navigation = h.select(&token, &record, "bank:hsbc", StatusCode::OK).await;
    assert_eq!(navigation["kind"], "connect");
    assert_eq!(navigation["created"], false);
    let connection = h.connect_bank(&token).await;
    let first = h.select(&token, &record, "bank:hsbc", StatusCode::OK).await;
    assert_eq!(first["created"], true);
    assert_eq!(
        h.select(&token, &record, "bank:hsbc", StatusCode::OK).await["created"],
        false
    );
    // Reusing the original request after a source edit must not grant an old card authority.
    source["request_id"] = json!(Uuid::new_v4());
    source["expected_revision"] = json!(1);
    source["messages"][0]["content"] = json!("A different task");
    h.json(
        "POST",
        &format!("/v1/ai/conversations/{conversation}"),
        &token,
        Some(source),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        h.select(&token, &record, "bank:hsbc", StatusCode::CONFLICT)
            .await["error"]["code"],
        "RECOMMENDATION_STALE"
    );
    let (conversation, message, _) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    let ready = h.recommend(&token, conversation, &message).await;
    sqlx::query(
        "UPDATE plugin_connections SET revision=revision+1,status='needs_review' WHERE id=$1",
    )
    .bind(connection)
    .execute(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(
        h.select(&token, &ready, "bank:hsbc", StatusCode::CONFLICT)
            .await["error"]["code"],
        "RECOMMENDATION_STALE"
    );
    let (conversation, message, _) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    let review = h.recommend(&token, conversation, &message).await;
    assert_eq!(
        h.select(&token, &review, "bank:hsbc", StatusCode::OK).await["kind"],
        "review"
    );
    sqlx::query("UPDATE plugin_connections SET revision=revision+1,status='revoked' WHERE id=$1")
        .bind(connection)
        .execute(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(
        h.select(&token, &review, "bank:hsbc", StatusCode::CONFLICT)
            .await["error"]["code"],
        "RECOMMENDATION_STALE"
    );
    h.json("POST", "/v1/account/deletions", &token, Some(json!({"request_id":Uuid::new_v4(),"recovery_token":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","password":"LocalQaPassword!","confirmation":"DELETE"})), StatusCode::OK).await;
    let remaining: (i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM ai_recommendations),(SELECT count(*) FROM ai_recommendation_selections),(SELECT count(*) FROM ai_recommendation_requests)")
        .fetch_one(&h.state.pool).await.unwrap();
    assert_eq!(remaining, (0, 0, 0));
    h.finish().await;
}

async fn insert_private_plugin(h: &Harness, owner: Uuid) -> Uuid {
    let connection = Uuid::new_v4();
    let service = Uuid::new_v4();
    let url = format!("https://astronomy.example/{service}/card");
    let card = json!({"card_url":url,"discovery_url":url,"card_origin":"https://astronomy.example","endpoint_url":"https://astronomy.example/mcp",
        "name":"org.example/orbit-archive","title":"Orbit Archive","version":"1.0.0","description":"Organize astronomy observations and telescope images.",
        "fingerprint":"verified-card-1","card_json":{"name":"org.example/orbit-archive","title":"Orbit Archive","version":"1.0.0"}});
    sqlx::query(
        "INSERT INTO plugin_services(id,card_url,card_url_hash,anonymous_card) VALUES($1,$2,$3,$4)",
    )
    .bind(service)
    .bind(&url)
    .bind(Sha256::digest(url.as_bytes()).to_vec())
    .bind(&card)
    .execute(&h.state.pool)
    .await
    .unwrap();
    let tools = json!([{"name":"organize_observations","title":"Organize observations","description":"Organize astronomy observations and telescope images.","inputSchema":{"type":"object","properties":{"query":{"type":"string"}}},"annotations":{"readOnlyHint":true}}]);
    let fingerprint = Sha256::digest(serde_json::to_vec(&tools).unwrap())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    sqlx::query("INSERT INTO plugin_connections(id,user_id,service_id,candidate,tools_snapshot,schema_fingerprint) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(connection).bind(owner).bind(service).bind(card).bind(tools).bind(fingerprint).execute(&h.state.pool).await.unwrap();
    connection
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn dynamic_catalogue_uses_current_data_and_preserves_private_visibility() {
    let h = Harness::new().await;
    let (_, owner) = h.register("reco_dynamic").await;
    let (_, stranger) = h.register("reco_stranger").await;
    let before = catalog::load(&h.state, owner, "en").await.unwrap();
    let connection = insert_private_plugin(&h, owner).await;
    let id = format!("connection:{connection}");
    let after = catalog::load(&h.state, owner, "en").await.unwrap();
    assert_ne!(before.version, after.version);
    assert!(
        after
            .candidates
            .iter()
            .any(|candidate| candidate.id == id && candidate.access == "ready")
    );
    assert!(
        matching::recall(
            "Current user message:\nPlease organize astronomy observations and telescope images",
            &after.candidates
        )
        .iter()
        .any(|candidate| candidate.id == id)
    );
    assert!(
        matching::recall(
            "Current user message:\nHello, how are you?",
            &after.candidates
        )
        .is_empty()
    );
    let foreign = catalog::load(&h.state, stranger, "en").await.unwrap();
    assert!(
        !foreign
            .candidates
            .iter()
            .any(|candidate| candidate.id == id)
    );
    sqlx::query("UPDATE plugin_connections SET revision=revision+1,auth_status='required',status='auth_required' WHERE id=$1").bind(connection).execute(&h.state.pool).await.unwrap();
    let auth = catalog::load(&h.state, owner, "en").await.unwrap();
    assert_ne!(after.version, auth.version);
    assert_eq!(
        auth.candidates
            .iter()
            .find(|candidate| candidate.id == id)
            .unwrap()
            .access,
        "authorize"
    );
    sqlx::query("UPDATE plugin_connections SET revision=revision+1,status='revoked' WHERE id=$1")
        .bind(connection)
        .execute(&h.state.pool)
        .await
        .unwrap();
    let revoked = catalog::load(&h.state, owner, "en").await.unwrap();
    assert!(
        !revoked
            .candidates
            .iter()
            .any(|candidate| candidate.id == id && candidate.access != "unavailable")
    );
    h.finish().await;
}

struct ModelFixture {
    calls: Arc<AtomicUsize>,
    inputs: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl ModelFixture {
    async fn attach(h: &mut Harness, delay: Duration) -> Self {
        use axum::{Json, response::IntoResponse, routing::post};
        let calls = Arc::new(AtomicUsize::new(0));
        let inputs = Arc::new(Mutex::new(Vec::new()));
        let captured = inputs.clone();
        let counter = calls.clone();
        let router = Router::new().route("/chat", post(move |Json(body): Json<Value>| {
            let captured = captured.clone();
            let counter = counter.clone();
            async move {
                if body["stream"] == true {
                    let wire = format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                        json!({"choices":[{"delta":{"content":"Chat still works."},"finish_reason":null}]}),
                        json!({"choices":[{"delta":{},"finish_reason":"stop"}]}));
                    return ([("content-type","text/event-stream")], wire).into_response();
                }
                counter.fetch_add(1, Ordering::SeqCst);
                let input: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                captured.lock().unwrap().push(input.clone());
                tokio::time::sleep(delay).await;
                let chosen = input["candidates"].as_array().unwrap().iter()
                    .find(|candidate| candidate["id"].as_str().unwrap().starts_with("connection:"))
                    .or_else(|| input["candidates"].as_array().unwrap().first()).map(|candidate| candidate["id"].clone());
                Json(json!({"choices":[{"message":{"content":json!({"ids":chosen.into_iter().collect::<Vec<_>>()}).to_string()}}],"usage":{"total_tokens":12}})).into_response()
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/chat", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        h.state.ai = Some(Arc::new(
            AiRuntime::test_fixture(endpoint, Duration::from_secs(10), Duration::from_secs(3))
                .unwrap(),
        ));
        Self {
            calls,
            inputs,
            server,
        }
    }
}

impl Drop for ModelFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; model is a loopback fixture"]
async fn concurrent_generation_ranks_once_and_dynamic_plugin_needs_no_client_release() {
    let mut h = Harness::new().await;
    let model = ModelFixture::attach(&mut h, Duration::from_millis(200)).await;
    let (token, owner) = h.register("reco_rank").await;
    let connection = insert_private_plugin(&h, owner).await;
    let (conversation, message, _) = h
        .save(
            &token,
            "Please organize astronomy observations and telescope images",
        )
        .await;
    let request = recommend_request(conversation, &message);
    let (left, right) = tokio::join!(
        h.request(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone())
        ),
        h.request(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone())
        )
    );
    assert!([left.status(), right.status()].contains(&StatusCode::OK));
    for response in [left, right] {
        assert!(matches!(
            response.status(),
            StatusCode::OK | StatusCode::CONFLICT
        ));
    }
    let recovered = h
        .json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::OK,
        )
        .await;
    assert!(
        contains_candidate(&recovered, &format!("connection:{connection}")),
        "{recovered}"
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let seen = model.inputs.lock().unwrap()[0].clone();
    assert!(seen["candidates"].as_array().unwrap().len() <= 12);
    assert!(
        seen["conversation"]
            .as_str()
            .unwrap()
            .ends_with("Please organize astronomy observations and telescope images")
    );
    let selection = h
        .select(
            &token,
            &recovered,
            &format!("connection:{connection}"),
            StatusCode::OK,
        )
        .await;
    assert_eq!(selection["kind"], "conversation");
    assert_eq!(selection["conversation"]["plugin"]["id"], json!(connection));
    let (other, other_message, _) = h
        .save(&token, "Use HSBC demo account to check balance")
        .await;
    let mut reused = request;
    reused["conversation_id"] = json!(other);
    reused["source_message_id"] = json!(other_message);
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(reused),
            StatusCode::CONFLICT
        )
        .await["error"]["code"],
        "RECOMMENDATION_REQUEST_REUSED"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; model is a loopback fixture"]
async fn recommendation_timeout_does_not_interrupt_chat_or_retry_the_model() {
    let mut h = Harness::new().await;
    let model = ModelFixture::attach(&mut h, Duration::from_secs(8)).await;
    let (token, owner) = h.register("reco_timeout").await;
    insert_private_plugin(&h, owner).await;
    let (conversation, message, _) = h
        .save(
            &token,
            "Please organize astronomy observations and telescope images",
        )
        .await;
    let request = recommend_request(conversation, &message);
    let start = std::time::Instant::now();
    let record = h
        .json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::OK,
        )
        .await;
    assert!(start.elapsed() < Duration::from_millis(5500));
    assert_eq!(record["status"], "skipped");
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request),
            StatusCode::OK
        )
        .await,
        record
    );
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    let response = h.request("POST", "/v1/ai/chat", &token, Some(json!({"model":"deepseek-flash","messages":[{"role":"user","content":"Hello"}],"thinking":false}))).await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 100_000).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("Chat still works."));
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; model is a loopback fixture"]
async fn revoked_capability_is_removed_when_it_changes_during_ranking() {
    let mut h = Harness::new().await;
    let model = ModelFixture::attach(&mut h, Duration::from_millis(250)).await;
    let (token, owner) = h.register("reco_revalidate").await;
    let connection = insert_private_plugin(&h, owner).await;
    let (conversation, message, _) = h
        .save(
            &token,
            "Please organize astronomy observations and telescope images",
        )
        .await;
    let rank = h.recommend(&token, conversation, &message);
    let revoke = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            while model.calls.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        sqlx::query(
            "UPDATE plugin_connections SET revision=revision+1,status='revoked' WHERE id=$1",
        )
        .bind(connection)
        .execute(&h.state.pool)
        .await
        .unwrap();
    };
    let (record, ()) = tokio::join!(rank, revoke);
    assert_eq!(record["status"], "skipped");
    assert!(record["candidates"].as_array().unwrap().is_empty());
    assert_eq!(model.calls.load(Ordering::SeqCst), 1);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn pending_crash_expiry_capacity_paging_and_account_cleanup_are_safe() {
    let mut h = Harness::new().await;
    let (token, owner) = h.register("reco_pending").await;
    let (conversation, message, _) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    h.state.recommendations_enabled = false;
    h.json(
        "POST",
        "/v1/ai/recommendations",
        &token,
        Some(recommend_request(conversation, &message)),
        StatusCode::NOT_FOUND,
    )
    .await;
    let empty: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_recommendations")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(empty, 0);
    h.state.recommendations_enabled = true;
    let permit = h
        .state
        .recommendation_gate
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let request = recommend_request(conversation, &message);
    let skipped = h
        .json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::OK,
        )
        .await;
    assert_eq!(skipped["status"], "skipped");
    drop(permit);
    let id = Uuid::parse_str(skipped["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE ai_recommendations SET status='pending',lease_until=now()+interval '1 minute' WHERE id=$1").bind(id).execute(&h.state.pool).await.unwrap();
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request.clone()),
            StatusCode::CONFLICT
        )
        .await["error"]["code"],
        "RECOMMENDATION_PENDING"
    );
    sqlx::query("UPDATE ai_recommendations SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(id)
        .execute(&h.state.pool)
        .await
        .unwrap();
    let recovered = h
        .json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(request),
            StatusCode::OK,
        )
        .await;
    assert_eq!(recovered["status"], "skipped");
    assert!(!recovered["catalog_version"].as_str().unwrap().is_empty());
    let page = h
        .json(
            "GET",
            &format!("/v1/ai/recommendations?conversation_id={conversation}&limit=1"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    h.json(
        "GET",
        &format!("/v1/ai/recommendations?conversation_id={conversation}&limit=21"),
        &token,
        None,
        StatusCode::BAD_REQUEST,
    )
    .await;
    h.json(
        "GET",
        &format!(
            "/v1/ai/recommendations?conversation_id={conversation}&cursor={}",
            Uuid::new_v4()
        ),
        &token,
        None,
        StatusCode::BAD_REQUEST,
    )
    .await;
    h.json("POST", "/v1/account/deletions", &token, Some(json!({"request_id":Uuid::new_v4(),"recovery_token":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","password":"LocalQaPassword!","confirmation":"DELETE"})), StatusCode::OK).await;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM ai_recommendations WHERE user_id=$1")
        .bind(owner)
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL"]
async fn history_and_recommendation_quotas_are_bounded_and_pagination_is_stable() {
    let h = Harness::new().await;
    let (token, owner) = h.register("reco_quotas").await;
    h.connect_bank(&token).await;
    let (conversation, message, _) = h
        .save(&token, "Use HSBC to check my demo account balance")
        .await;
    // Seed old display-only cards to exercise retention without making 100 model requests.
    sqlx::query("INSERT INTO ai_recommendations(id,user_id,conversation_id,source_message_id,source_fingerprint,request_id,locale,status) SELECT gen_random_uuid(),$1,$2,'old-' || n,$3,gen_random_uuid(),'en','skipped' FROM generate_series(1,100) AS n")
        .bind(owner).bind(conversation).bind(vec![1_u8;32]).execute(&h.state.pool).await.unwrap();
    let record = h.recommend(&token, conversation, &message).await;
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ai_recommendations WHERE user_id=$1 AND conversation_id=$2",
    )
    .bind(owner)
    .bind(conversation)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 100);
    let first = h
        .json(
            "GET",
            &format!("/v1/ai/recommendations?conversation_id={conversation}&limit=1"),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(first["items"][0]["id"], record["id"]);
    let second = h
        .json(
            "GET",
            &format!(
                "/v1/ai/recommendations?conversation_id={conversation}&limit=1&cursor={}",
                first["next_cursor"].as_str().unwrap()
            ),
            &token,
            None,
            StatusCode::OK,
        )
        .await;
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    sqlx::query("INSERT INTO ai_conversations(user_id,id,revision,request_id,expected_revision,snapshot) SELECT $1,gen_random_uuid(),1,gen_random_uuid(),0,$2 FROM generate_series(1,99)")
        .bind(owner).bind(json!({"title":"Quota fixture","messages":[]})).execute(&h.state.pool).await.unwrap();
    assert_eq!(
        h.select(&token, &record, "bank:hsbc", StatusCode::CONFLICT)
            .await["error"]["code"],
        "AI_HISTORY_LIMIT"
    );
    let targets: i64 =
        sqlx::query_scalar("SELECT count(*) FROM ai_recommendation_selections WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(targets, 0);
    let alias = recommend_request(conversation, &message);
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(alias.clone()),
            StatusCode::OK
        )
        .await["id"],
        record["id"]
    );
    let mut mismatched = alias;
    mismatched["locale"] = json!("zh");
    assert_eq!(
        h.json(
            "POST",
            "/v1/ai/recommendations",
            &token,
            Some(mismatched),
            StatusCode::CONFLICT
        )
        .await["error"]["code"],
        "RECOMMENDATION_REQUEST_REUSED"
    );
    sqlx::query("UPDATE ai_recommendations SET expires_at=now()-interval '1 second' WHERE id=$1")
        .bind(Uuid::parse_str(record["id"].as_str().unwrap()).unwrap())
        .execute(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(
        h.select(&token, &record, "bank:hsbc", StatusCode::CONFLICT)
            .await["error"]["code"],
        "RECOMMENDATION_STALE"
    );
    h.finish().await;
}
