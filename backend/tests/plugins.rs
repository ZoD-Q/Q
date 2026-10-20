//! MCP integration boundaries against real isolated PostgreSQL and loopback HTTP.
#![cfg(feature = "plugin-test-fixtures")]

use axum::{
    Form, Json, Router,
    body::{Body, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, app,
    plugins::{PluginRuntime, network::SafeHttp},
};

struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
    origin: String,
    calls: Arc<AtomicUsize>,
    result_mode: Arc<AtomicUsize>,
    tool_revision: Arc<AtomicUsize>,
    card_revision: Arc<AtomicUsize>,
    card_owner: Arc<Mutex<Option<Value>>>,
    token_requests: Arc<Mutex<Vec<HashMap<String, String>>>>,
    business_tokens: Arc<Mutex<Vec<String>>>,
    model_calls: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Harness {
    async fn new() -> Self {
        Self::with_authorization(false).await
    }
    async fn with_authorization(require_authorization: bool) -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("TEST_DATABASE_URL must point to the dedicated PostgreSQL test database");
        let admin = PgPool::connect(&url).await.unwrap();
        let schema = format!("q_plugins_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let search_path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(8)
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let card_origin = origin.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let result_mode = Arc::new(AtomicUsize::new(0));
        let tool_revision = Arc::new(AtomicUsize::new(0));
        let card_revision = Arc::new(AtomicUsize::new(0));
        let card_owner = Arc::new(Mutex::new(None));
        let remote_owner = card_owner.clone();
        let token_requests = Arc::new(Mutex::new(Vec::new()));
        let business_tokens = Arc::new(Mutex::new(Vec::new()));
        let model_calls = Arc::new(AtomicUsize::new(0));
        let model_counter = model_calls.clone();
        let issued_accounts = Arc::new(AtomicUsize::new(0));
        let active_token = Arc::new(Mutex::new(String::new()));
        let mcp_token = active_token.clone();
        let business_capture = business_tokens.clone();
        let resource_origin = origin.clone();
        let issuer_origin = origin.clone();
        let token_origin = origin.clone();
        let challenge = format!(
            "Bearer resource_metadata=\"{origin}/resource-metadata\", scope=\"records:read\""
        );
        let token_capture = token_requests.clone();
        let (observed, mode, tools, card) = (
            calls.clone(),
            result_mode.clone(),
            tool_revision.clone(),
            card_revision.clone(),
        );
        let router = Router::new()
            .route("/card", get(move |headers:HeaderMap| {
                let (origin, card, owner) = (card_origin.clone(), card.clone(), remote_owner.clone());
                async move {
                    assert!(!headers.contains_key("authorization"));
                    let revision=card.load(Ordering::SeqCst);
                    let endpoint=if revision==0 {format!("{origin}/mcp")} else {format!("{origin}/mcp?card_revision={revision}")};
                    let mut value = json!({
                        "$schema":"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
                        "name":"io.example.fixture/records","title":format!("Fixture Records v{revision}"),"description":"Isolated local records",
                        "version":format!("1.0.{revision}"),
                        "remotes":[{"type":"streamable-http","url":endpoint,"supportedProtocolVersions":["2026-07-28"]}]
                    });
                    if let Some(owner) = owner.lock().unwrap().clone() {
                        value["_meta"] = json!({"com.kaicloudpay.q/owner": owner});
                    }
                    ([("content-type","application/mcp-server-card+json")], Json(value))
                }
            }))
            .route("/mcp", post(move |headers:HeaderMap, Json(request):Json<Value>| {
                let (observed, mode, tools) = (observed.clone(), mode.clone(), tools.clone());
                let (active_token,business_capture)=(mcp_token.clone(),business_capture.clone());
                let challenge=challenge.clone();
                async move {
                    if require_authorization {
                        let expected=format!("Bearer {}",active_token.lock().unwrap());
                        if headers.get("authorization").and_then(|value|value.to_str().ok())!=Some(expected.as_str()) {
                            assert!(headers.get("authorization").and_then(|value|value.to_str().ok()).is_none_or(|value|value.starts_with("Bearer fixture-token")),"Q credentials must stay within Q");
                            return (StatusCode::UNAUTHORIZED,[("www-authenticate",challenge)],"Fixture authorization needed").into_response();
                        }
                    } else {
                        assert!(!headers.contains_key("authorization"),"Q credentials must stay within Q");
                    }
                    assert!(!headers.contains_key("cookie"));
                    assert_eq!(headers["mcp-protocol-version"],"2026-07-28");
                    assert_eq!(request["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"],json!({}));
                    let query_limit=if tools.load(Ordering::SeqCst)==0 {100} else {200};
                    let result = match request["method"].as_str().unwrap() {
                        "server/discover" => json!({"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"ttlMs":0,"cacheScope":"private"}),
                        "tools/list" => json!({"resultType":"complete","tools":[{
                            "name":"fixture.lookup","description":format!("Find local records, schema revision {}",tools.load(Ordering::SeqCst)),
                            "inputSchema":{"type":"object","properties":{"query":{"type":"string","maxLength":query_limit}},"required":["query"],"additionalProperties":false},
                            "outputSchema":{"type":"object","properties":{"count":{"type":"integer"}},"required":["count"],"additionalProperties":false},
                            "annotations":{"readOnlyHint":true}
                        }],"ttlMs":0,"cacheScope":"private"}),
                        "tools/call" => {
                            assert_eq!(request["params"]["name"],"fixture.lookup");
                            business_capture.lock().unwrap().push(headers.get("authorization").and_then(|value|value.to_str().ok()).unwrap_or("anonymous").to_owned());
                            observed.fetch_add(1,Ordering::SeqCst);
                            // Ensure concurrent confirmations overlap while one durable claim runs.
                            tokio::time::sleep(Duration::from_millis(60)).await;
                            match mode.load(Ordering::SeqCst) {
                                1 => json!({"resultType":"complete","content":[{"type":"text","text":"Remote operation may have finished"}],"structuredContent":{"count":"invalid-output"}}),
                                2 => json!({"resultType":"input_required","inputRequests":{}}),
                                _ => json!({"resultType":"complete","content":[{"type":"text","text":"Full persisted fixture result"}],"structuredContent":{"count":3}}),
                            }
                        }
                        other => panic!("Unexpected method: {other}"),
                    };
                    Json(json!({"jsonrpc":"2.0","id":request["id"],"result":result})).into_response()
                }
            }))
            .route("/resource-metadata",get(move |headers:HeaderMap| {
                let origin=resource_origin.clone();
                async move {assert!(!headers.contains_key("authorization"));Json(json!({"resource":format!("{origin}/mcp"),"authorization_servers":[format!("{origin}/issuer")],"scopes_supported":["records:read"]}))}
            }))
            .route("/.well-known/oauth-authorization-server/issuer",get(move |headers:HeaderMap| {
                let origin=issuer_origin.clone();
                async move {assert!(!headers.contains_key("authorization"));Json(json!({"issuer":format!("{origin}/issuer"),"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"client_id_metadata_document_supported":true,"code_challenge_methods_supported":["S256"],"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"authorization_response_iss_parameter_supported":true}))}
            }))
            .route("/token",post(move |headers:HeaderMap,Form(form):Form<HashMap<String,String>>| {
                let (origin,capture)=(token_origin.clone(),token_capture.clone());
                let (issued,active)=(issued_accounts.clone(),active_token.clone());
                async move {
                    assert!(!headers.contains_key("authorization"));
                    assert_eq!(form.get("client_id").map(String::as_str),Some("https://q.example/oauth/client-metadata.json"));
                    assert_eq!(form.get("resource"),Some(&format!("{origin}/mcp")));
                    let refresh=form.get("grant_type").map(String::as_str)==Some("refresh_token");
                    if refresh {assert_eq!(form.get("refresh_token"),Some(&format!("fixture-refresh-account-{}",issued.load(Ordering::SeqCst))));}
                    else {
                        assert_eq!(form.get("code").map(String::as_str),Some("fixture-code"));
                        assert_eq!(form.get("redirect_uri").map(String::as_str),Some("https://q.example/v1/plugins/oauth/callback"));
                        assert_eq!(form.get("code_verifier").unwrap().len(),43);
                    }
                    capture.lock().unwrap().push(form);
                    let account=if refresh {issued.load(Ordering::SeqCst)} else {issued.fetch_add(1,Ordering::SeqCst)+1};
                    let token=if refresh {format!("fixture-token-refreshed-account-{account}")} else {format!("fixture-token-account-{account}")};
                    *active.lock().unwrap()=token.clone();
                    Json(json!({"access_token":token,"refresh_token":format!("fixture-refresh-account-{account}"),"token_type":"Bearer","expires_in":3600,"scope":"records:read"}))
                }
            }))
            .route("/model",post(move || {
                let counter=model_counter.clone();
                async move {counter.fetch_add(1,Ordering::SeqCst);(StatusCode::INTERNAL_SERVER_ERROR,"Model must not receive stale account history")}
            }));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut state = AppState::new(pool).await.unwrap();
        assert!(state.ai.is_none() && state.plugins.is_none());
        state.plugins = Some(Arc::new(PluginRuntime::test_fixture(
            SafeHttp::test_fixture(origin.parse().unwrap()).unwrap(),
            require_authorization.then_some([7; 32]),
            require_authorization.then(|| "https://q.example".into()),
        )));
        Self {
            state,
            admin,
            schema,
            origin,
            calls,
            result_mode,
            tool_revision,
            card_revision,
            card_owner,
            token_requests,
            business_tokens,
            model_calls,
            server,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        app(
            self.state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        )
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
    }
    async fn json(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
        expected: StatusCode,
    ) -> Value {
        let response = self.request(method, path, Some(token), body).await;
        let status = response.status();
        let result = read_json(response).await;
        assert_eq!(status, expected, "{result}");
        result
    }
    async fn register(&self, handle: &str) -> String {
        let response = self
            .request(
                "POST",
                "/v1/auth/register",
                None,
                Some(json!({"handle":handle,"password":"LocalQaPassword!","display_name":handle})),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        read_json(response).await["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn discover(&self, token: &str) -> Value {
        self.json(
            "POST",
            "/v1/plugins/discover",
            token,
            Some(json!({"entry":format!("{}/card",self.origin),"kind":"card"})),
            StatusCode::OK,
        )
        .await
    }
    async fn connect(&self, token: &str) -> String {
        let discovery = self.discover(token).await;
        let connection = self
            .json(
                "POST",
                "/v1/plugins/connections",
                token,
                Some(add_body(&discovery)),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(connection["status"], "ready");
        connection["id"].as_str().unwrap().to_owned()
    }
    async fn prepare(&self, token: &str, connection: &str, key: Uuid) -> Value {
        self.json(
            "POST",
            "/v1/plugins/invocations",
            token,
            Some(prepare_body(connection, key)),
            StatusCode::CREATED,
        )
        .await
    }
    async fn confirm(&self, token: &str, id: &str) -> Value {
        self.json(
            "POST",
            &format!("/v1/plugins/invocations/{id}/confirm"),
            token,
            Some(json!({"confirmed":true})),
            StatusCode::OK,
        )
        .await
    }
    async fn rebuild_state(&mut self) {
        let plugins = self.state.plugins.clone();
        self.state = AppState::new(self.state.pool.clone()).await.unwrap();
        self.state.plugins = plugins;
    }
    async fn finish(self) {
        self.server.abort();
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
fn add_body(discovery: &Value) -> Value {
    json!({"discovery_id":discovery["discovery_id"],"candidate_id":discovery["candidates"][0]["candidate_id"]})
}
fn prepare_body(connection: &str, key: Uuid) -> Value {
    json!({"connection_id":connection,"tool_name":"fixture.lookup","arguments":{"query":"local-fixture"},"idempotency_key":key})
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn declared_owner_and_automatic_discovery_preserve_identity_and_historical_metadata() {
    let h = Harness::new().await;
    let alice = h.register("owner_display_alice").await;
    let named_owner = h.register("mandow").await;
    let discovery = h
        .json(
            "POST",
            "/v1/plugins/discover",
            &alice,
            Some(json!({"entry":format!("{}/card?x=2&x=1",h.origin)})),
            StatusCode::OK,
        )
        .await;
    assert!(discovery["candidates"][0]["owner_name"].is_null());
    assert!(
        discovery["candidates"][0]["card_url"]
            .as_str()
            .unwrap()
            .ends_with("?x=2&x=1")
    );
    let resolved: String =
        sqlx::query_scalar("SELECT entry_kind FROM plugin_discoveries WHERE id=$1")
            .bind(Uuid::parse_str(discovery["discovery_id"].as_str().unwrap()).unwrap())
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(resolved, "card");
    let mut forged = add_body(&discovery);
    forged["owner_name"] = json!("mandow");
    h.json(
        "POST",
        "/v1/plugins/connections",
        &alice,
        Some(forged),
        StatusCode::BAD_REQUEST,
    )
    .await;
    let connection = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    assert!(connection["owner_name"].is_null());
    let connection = connection["id"].as_str().unwrap();
    let legacy_source = h.prepare(&alice, connection, Uuid::new_v4()).await;
    let legacy_id = Uuid::new_v4();
    // Insert an old-format fixture. Existing proposals must remain immutable,
    // including during a compatibility test.
    sqlx::query(
        "INSERT INTO plugin_invocations(id,user_id,connection_id,connection_revision,connection_snapshot,idempotency_key,request_fingerprint,tool_name,arguments,tool_snapshot,schema_fingerprint,expires_at) SELECT $1,user_id,connection_id,connection_revision,connection_snapshot-'owner_name',gen_random_uuid(),request_fingerprint,tool_name,arguments,tool_snapshot,schema_fingerprint,expires_at FROM plugin_invocations WHERE id=$2",
    )
    .bind(legacy_id)
    .bind(Uuid::parse_str(legacy_source["id"].as_str().unwrap()).unwrap())
    .execute(&h.state.pool)
    .await
    .unwrap();

    *h.card_owner.lock().unwrap() = Some(json!({"name":"mandow"}));
    let updated = h
        .json(
            "POST",
            &format!("/v1/plugins/connections/{connection}/refresh"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(updated["status"], "needs_review");
    assert!(updated["owner_name"].is_null());
    assert_eq!(
        updated["pending_update_details"]["candidate"]["owner_name"],
        "mandow"
    );
    let accepted = h
        .json(
            "POST",
            &format!("/v1/plugins/connections/{connection}/accept-update"),
            &alice,
            Some(json!({"revision":updated["revision"]})),
            StatusCode::OK,
        )
        .await;
    assert_eq!(accepted["owner_name"], "mandow");
    assert_eq!(
        h.json(
            "GET",
            "/v1/plugins/connections",
            &alice,
            None,
            StatusCode::OK
        )
        .await["items"][0]["owner_name"],
        "mandow"
    );
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}"),
        &named_owner,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    let proposal = h.prepare(&alice, connection, Uuid::new_v4()).await;
    assert_eq!(proposal["owner_name"], "mandow");
    let id = proposal["id"].as_str().unwrap();
    assert_eq!(h.confirm(&alice, id).await["status"], "succeeded");

    *h.card_owner.lock().unwrap() = Some(json!({"name":"next publisher"}));
    let changed = h
        .json(
            "POST",
            &format!("/v1/plugins/connections/{connection}/refresh"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    h.json(
        "POST",
        &format!("/v1/plugins/connections/{connection}/accept-update"),
        &alice,
        Some(json!({"revision":changed["revision"]})),
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        h.json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await["owner_name"],
        "mandow"
    );
    assert!(
        h.json(
            "GET",
            &format!("/v1/plugins/invocations/{legacy_id}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await["owner_name"]
            .is_null()
    );
    *h.card_owner.lock().unwrap() = Some(json!({"name":["invalid optional metadata"]}));
    let invalid_optional = h
        .json(
            "POST",
            "/v1/plugins/discover",
            &alice,
            Some(json!({"entry":format!("{}/card",h.origin),"kind":"auto"})),
            StatusCode::OK,
        )
        .await;
    assert!(invalid_optional["candidates"][0]["owner_name"].is_null());
    let resolved: String =
        sqlx::query_scalar("SELECT entry_kind FROM plugin_discoveries WHERE id=$1")
            .bind(Uuid::parse_str(invalid_optional["discovery_id"].as_str().unwrap()).unwrap())
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(resolved, "card");
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn owners_and_idempotency_are_enforced_and_concurrent_confirmation_dispatches_once() {
    let h = Harness::new().await;
    let alice = h.register("plugin_alice").await;
    let bob = h.register("plugin_bob").await;
    assert_eq!(
        h.request(
            "POST",
            "/v1/plugins/discover",
            None,
            Some(json!({"entry":format!("{}/card",h.origin),"kind":"card"}))
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let discovery = h.discover(&alice).await;
    h.json(
        "POST",
        "/v1/plugins/connections",
        &bob,
        Some(add_body(&discovery)),
        StatusCode::NOT_FOUND,
    )
    .await;
    let mut forged = add_body(&discovery);
    forged["candidate_id"] = json!(Uuid::new_v4());
    h.json(
        "POST",
        "/v1/plugins/connections",
        &alice,
        Some(forged),
        StatusCode::NOT_FOUND,
    )
    .await;
    let connection = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    let duplicate = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(connection["id"], duplicate["id"]);
    let connection = connection["id"].as_str().unwrap();
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}"),
        &bob,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &bob,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert!(
        h.json("GET", "/v1/plugins/connections", &bob, None, StatusCode::OK)
            .await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let key = Uuid::new_v4();
    let proposal = h.prepare(&alice, connection, key).await;
    assert_eq!(proposal["status"], "awaiting_confirmation");
    let duplicate = h.prepare(&alice, connection, key).await;
    assert_eq!(proposal["id"], duplicate["id"]);
    let id = proposal["id"].as_str().unwrap();
    let mut changed = prepare_body(connection, key);
    changed["arguments"]["query"] = json!("different");
    assert_eq!(
        h.json(
            "POST",
            "/v1/plugins/invocations",
            &alice,
            Some(changed),
            StatusCode::CONFLICT
        )
        .await["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
    h.json(
        "POST",
        "/v1/plugins/invocations",
        &bob,
        Some(prepare_body(connection, Uuid::new_v4())),
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "GET",
        &format!("/v1/plugins/invocations/{id}"),
        &bob,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "GET",
        &format!("/v1/plugins/invocations?connection_id={connection}"),
        &bob,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "POST",
        &format!("/v1/plugins/invocations/{id}/confirm"),
        &bob,
        Some(json!({"confirmed":true})),
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    let (first, second) = tokio::join!(h.confirm(&alice, id), h.confirm(&alice, id));
    assert!(["running", "succeeded"].contains(&first["status"].as_str().unwrap()));
    assert!(["running", "succeeded"].contains(&second["status"].as_str().unwrap()));
    let final_result = h.confirm(&alice, id).await;
    assert_eq!(final_result["status"], "succeeded");
    assert_eq!(
        final_result["result"]["structuredContent"],
        json!({"count":3})
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let summary = h
        .json(
            "GET",
            "/v1/plugins/invocations",
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(summary["items"][0]["id"], id);
    assert!(
        summary["items"][0]["result"].is_null(),
        "history lists must not aggregate full remote payloads"
    );
    let detail = h
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(detail["result"], final_result["result"]);
    let ledger: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_entries")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(ledger, 4);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn cancellation_card_schema_changes_and_revocation_invalidate_old_proposals() {
    let h = Harness::new().await;
    let alice = h.register("plugin_changes").await;
    let connection = h.connect(&alice).await;
    let cancelled = h.prepare(&alice, &connection, Uuid::new_v4()).await;
    let cancelled = cancelled["id"].as_str().unwrap();
    assert_eq!(
        h.json(
            "POST",
            &format!("/v1/plugins/invocations/{cancelled}/cancel"),
            &alice,
            None,
            StatusCode::OK
        )
        .await["status"],
        "cancelled"
    );
    assert_eq!(h.confirm(&alice, cancelled).await["status"], "cancelled");

    let old = h.prepare(&alice, &connection, Uuid::new_v4()).await;
    let old = old["id"].as_str().unwrap();
    h.tool_revision.store(1, Ordering::SeqCst);
    assert_eq!(
        h.json(
            "POST",
            &format!("/v1/plugins/invocations/{old}/confirm"),
            &alice,
            Some(json!({"confirmed":true})),
            StatusCode::CONFLICT
        )
        .await["error"]["code"],
        "PLUGIN_RECONFIRM_REQUIRED"
    );
    let update = h
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(update["status"], "needs_review");
    assert!(update["pending_update_details"]["tools"].is_array());
    h.json(
        "POST",
        &format!("/v1/plugins/connections/{connection}/accept-update"),
        &alice,
        Some(json!({"revision":update["revision"]})),
        StatusCode::OK,
    )
    .await;
    h.json(
        "POST",
        &format!("/v1/plugins/invocations/{old}/confirm"),
        &alice,
        Some(json!({"confirmed":true})),
        StatusCode::CONFLICT,
    )
    .await;

    let before_card = h.prepare(&alice, &connection, Uuid::new_v4()).await;
    let before_card = before_card["id"].as_str().unwrap();
    h.card_revision.store(1, Ordering::SeqCst);
    let updated = h
        .json(
            "POST",
            &format!("/v1/plugins/connections/{connection}/refresh"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(updated["status"], "needs_review");
    assert_eq!(
        updated["pending_update_details"]["candidate"]["version"],
        "1.0.1"
    );
    h.json(
        "POST",
        &format!("/v1/plugins/invocations/{before_card}/confirm"),
        &alice,
        Some(json!({"confirmed":true})),
        StatusCode::CONFLICT,
    )
    .await;
    h.json(
        "POST",
        &format!("/v1/plugins/connections/{connection}/accept-update"),
        &alice,
        Some(json!({"revision":updated["revision"]})),
        StatusCode::OK,
    )
    .await;
    h.json(
        "POST",
        &format!("/v1/plugins/invocations/{before_card}/confirm"),
        &alice,
        Some(json!({"confirmed":true})),
        StatusCode::CONFLICT,
    )
    .await;
    let historical = h
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{before_card}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(historical["connection_title"], "Fixture Records v0");
    assert_eq!(historical["endpoint_url"], format!("{}/mcp", h.origin));
    let revoked = h.prepare(&alice, &connection, Uuid::new_v4()).await;
    assert_eq!(revoked["connection_title"], "Fixture Records v1");
    assert_eq!(
        revoked["endpoint_url"],
        format!("{}/mcp?card_revision=1", h.origin)
    );
    let revoked = revoked["id"].as_str().unwrap();
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/v1/plugins/connections/{connection}"),
            Some(&alice),
            None
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(h.confirm(&alice, revoked).await["status"], "cancelled");
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &alice,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn post_dispatch_uncertainty_and_expired_execution_claims_survive_restart_without_retry() {
    let mut h = Harness::new().await;
    let alice = h.register("plugin_recovery").await;
    let connection = h.connect(&alice).await;
    for mode in [1, 2] {
        h.result_mode.store(mode, Ordering::SeqCst);
        let proposal = h.prepare(&alice, &connection, Uuid::new_v4()).await;
        let id = proposal["id"].as_str().unwrap();
        let result = h.confirm(&alice, id).await;
        assert_eq!(
            result["status"], "unknown",
            "a dispatched operation may have executed even when its output is unsupported or invalid"
        );
        assert!(result["result"].is_null());
        assert_eq!(h.calls.load(Ordering::SeqCst), mode);
        h.rebuild_state().await;
        let replay = h.confirm(&alice, id).await;
        assert_eq!(replay["status"], "unknown");
        assert_eq!(
            h.calls.load(Ordering::SeqCst),
            mode,
            "restart cannot make an uncertain call executable again"
        );
    }
    let proposal = h.prepare(&alice, &connection, Uuid::new_v4()).await;
    let id = Uuid::parse_str(proposal["id"].as_str().unwrap()).unwrap();
    // Simulate a process stopping after its durable claim but before recording an outcome.
    sqlx::query("UPDATE plugin_invocations SET status='running',confirmed_at=now()-interval '1 minute',execution_deadline=now()-interval '1 second' WHERE id=$1")
        .bind(id).execute(&h.state.pool).await.unwrap();
    h.rebuild_state().await;
    let recovered = h.confirm(&alice, &id.to_string()).await;
    assert_eq!(recovered["status"], "unknown");
    assert_eq!(recovered["error_code"], "PLUGIN_RESULT_UNKNOWN");
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    h.finish().await;
}

fn oauth_callback(state: &str, issuer: &str) -> String {
    let mut url = reqwest::Url::parse("https://q.example/v1/plugins/oauth/callback").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("state", state),
        ("iss", issuer),
        ("code", "fixture-code"),
    ]);
    format!("{}?{}", url.path(), url.query().unwrap())
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn reauthorization_changes_account_revision_and_cancels_old_proposals_and_model_context() {
    let h = Harness::with_authorization(true).await;
    let alice = h.register("plugin_account_change").await;
    let discovery = h.discover(&alice).await;
    let connection = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    let connection = connection["id"].as_str().unwrap();
    let start_path = format!("/v1/plugins/connections/{connection}/oauth/start");
    let initial = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let initial_url = reqwest::Url::parse(initial["authorization_url"].as_str().unwrap()).unwrap();
    let initial_query: HashMap<_, _> = initial_url.query_pairs().into_owned().collect();
    assert_eq!(
        h.request(
            "GET",
            &oauth_callback(&initial_query["state"], &format!("{}/issuer", h.origin)),
            None,
            None
        )
        .await
        .status(),
        StatusCode::SEE_OTHER
    );
    let completed = h.prepare(&alice, connection, Uuid::new_v4()).await;
    let completed_id = completed["id"].as_str().unwrap();
    let original_revision = completed["connection_revision"].as_i64().unwrap();
    assert_eq!(h.confirm(&alice, completed_id).await["status"], "succeeded");
    let pending = h.prepare(&alice, connection, Uuid::new_v4()).await;
    let pending_id = pending["id"].as_str().unwrap();
    assert_eq!(
        h.business_tokens.lock().unwrap().as_slice(),
        ["Bearer fixture-token-account-1"]
    );

    let second = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let changed = h
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    let next_revision = changed["revision"].as_i64().unwrap();
    assert!(next_revision > original_revision);
    let cancelled = h.confirm(&alice, pending_id).await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["error_code"], "PLUGIN_AUTH_CHANGED");
    assert_eq!(cancelled["connection_revision"], original_revision);
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let second_url = reqwest::Url::parse(second["authorization_url"].as_str().unwrap()).unwrap();
    let second_query: HashMap<_, _> = second_url.query_pairs().into_owned().collect();
    assert_eq!(
        h.request(
            "GET",
            &oauth_callback(&second_query["state"], &format!("{}/issuer", h.origin)),
            None,
            None
        )
        .await
        .status(),
        StatusCode::SEE_OTHER
    );
    let authorized = h
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(authorized["auth_status"], "authorized");
    assert_eq!(authorized["revision"], next_revision);
    assert_eq!(h.confirm(&alice, pending_id).await["status"], "cancelled");
    assert_eq!(
        h.calls.load(Ordering::SeqCst),
        1,
        "the prior-account proposal cannot execute after switching accounts"
    );
    let history = h
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{completed_id}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(history["status"], "succeeded");
    assert_eq!(history["connection_revision"], original_revision);

    #[cfg(feature = "ai-test-fixtures")]
    let h = {
        let mut h = h;
        h.state.ai = Some(Arc::new(
            xiaoq_backend::ai::AiRuntime::test_fixture(
                format!("{}/model", h.origin).parse().unwrap(),
                Duration::from_secs(3),
                Duration::from_secs(1),
            )
            .unwrap(),
        ));
        let rejected=h.json("POST","/v1/ai/chat",&alice,Some(json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"Continue from the prior account result"}],"plugin_connection_id":connection,"tool_invocation_ids":[completed_id]})),StatusCode::CONFLICT).await;
        assert_eq!(rejected["error"]["code"], "PLUGIN_RESULT_UNAVAILABLE");
        h
    };
    assert_eq!(
        h.model_calls.load(Ordering::SeqCst),
        0,
        "old-account results must be rejected before any model request"
    );
    let fresh = h.prepare(&alice, connection, Uuid::new_v4()).await;
    assert_eq!(fresh["connection_revision"], next_revision);
    assert_eq!(
        h.confirm(&alice, fresh["id"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    assert_eq!(
        h.business_tokens.lock().unwrap().as_slice(),
        [
            "Bearer fixture-token-account-1",
            "Bearer fixture-token-account-2"
        ]
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 2);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn invocation_storage_quota_preserves_replay_read_and_confirmation_and_is_owner_scoped() {
    let h = Harness::new().await;
    let alice = h.register("plugin_quota_alice").await;
    let bob = h.register("plugin_quota_bob").await;
    let connection = h.connect(&alice).await;
    let key = Uuid::new_v4();
    let original = h.prepare(&alice, &connection, key).await;
    let id = Uuid::parse_str(original["id"].as_str().unwrap()).unwrap();
    // Copy a valid proposal into this isolated test schema to reach the storage boundary
    // without defeating the separate request rate limiter or changing immutable rows.
    sqlx::query("INSERT INTO plugin_invocations(id,user_id,connection_id,connection_revision,connection_snapshot,idempotency_key,request_fingerprint,tool_name,arguments,tool_snapshot,schema_fingerprint,expires_at) SELECT gen_random_uuid(),source.user_id,source.connection_id,source.connection_revision,source.connection_snapshot,gen_random_uuid(),source.request_fingerprint,source.tool_name,source.arguments,source.tool_snapshot,source.schema_fingerprint,source.expires_at FROM plugin_invocations source CROSS JOIN generate_series(1,31) WHERE source.id=$1")
        .bind(id).execute(&h.state.pool).await.unwrap();
    let limited = h
        .json(
            "POST",
            "/v1/plugins/invocations",
            &alice,
            Some(prepare_body(&connection, Uuid::new_v4())),
            StatusCode::CONFLICT,
        )
        .await;
    assert_eq!(limited["error"]["code"], "PLUGIN_STORAGE_LIMIT");
    assert_eq!(
        h.prepare(&alice, &connection, key).await["id"],
        original["id"]
    );
    let saved = h
        .json(
            "GET",
            &format!("/v1/plugins/invocations/{id}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(saved["status"], "awaiting_confirmation");
    assert_eq!(
        h.confirm(&alice, &id.to_string()).await["status"],
        "succeeded"
    );
    assert_eq!(
        h.prepare(&alice, &connection, key).await["status"],
        "succeeded"
    );
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_invocations WHERE connection_id=$1")
            .bind(Uuid::parse_str(&connection).unwrap())
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(
        count, 32,
        "quota recovery cannot erase invocation tombstones"
    );
    let bob_connection = h.connect(&bob).await;
    assert_eq!(
        h.prepare(&bob, &bob_connection, Uuid::new_v4()).await["status"],
        "awaiting_confirmation"
    );
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn oauth_attempt_limit_preserves_current_authorization_and_cleans_expired_records() {
    let h = Harness::with_authorization(true).await;
    let alice = h.register("plugin_oauth_limit").await;
    let discovery = h.discover(&alice).await;
    let connection = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    let connection = connection["id"].as_str().unwrap();
    let connection_uuid = Uuid::parse_str(connection).unwrap();
    let start_path = format!("/v1/plugins/connections/{connection}/oauth/start");
    let started = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let attempt = Uuid::parse_str(started["attempt_id"].as_str().unwrap()).unwrap();
    let url = reqwest::Url::parse(started["authorization_url"].as_str().unwrap()).unwrap();
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        h.request(
            "GET",
            &oauth_callback(&query["state"], &format!("{}/issuer", h.origin)),
            None,
            None
        )
        .await
        .status(),
        StatusCode::SEE_OTHER
    );
    let authorized = h
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(authorized["auth_status"], "authorized");
    let original_ciphertext: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_tokens FROM plugin_oauth_tokens WHERE connection_id=$1",
    )
    .bind(connection_uuid)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    // Completed rows still count until expiry, so a cap does not erase replay protection.
    sqlx::query("INSERT INTO plugin_oauth_attempts(id,user_id,connection_id,connection_revision,state_hash,encrypted_verifier,issuer,resource,token_endpoint,client_id,redirect_uri,scopes,require_response_iss,status,expires_at) SELECT gen_random_uuid(),source.user_id,source.connection_id,source.connection_revision,decode(md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'hex'),NULL,source.issuer,source.resource,source.token_endpoint,source.client_id,source.redirect_uri,source.scopes,source.require_response_iss,'succeeded',source.expires_at FROM plugin_oauth_attempts source CROSS JOIN generate_series(1,19) WHERE source.id=$1")
        .bind(attempt).execute(&h.state.pool).await.unwrap();
    let limited = h
        .json("POST", &start_path, &alice, None, StatusCode::CONFLICT)
        .await;
    assert_eq!(limited["error"]["code"], "PLUGIN_OAUTH_ATTEMPT_LIMIT");
    let unchanged = h
        .json(
            "GET",
            &format!("/v1/plugins/connections/{connection}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(unchanged["revision"], authorized["revision"]);
    assert_eq!(unchanged["auth_status"], "authorized");
    let ciphertext: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_tokens FROM plugin_oauth_tokens WHERE connection_id=$1",
    )
    .bind(connection_uuid)
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(ciphertext, original_ciphertext);
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &alice,
        None,
        StatusCode::OK,
    )
    .await;
    sqlx::query("UPDATE plugin_oauth_attempts SET expires_at=now()-interval '1 second' WHERE connection_id=$1 AND id<>$2")
        .bind(connection_uuid).bind(attempt).execute(&h.state.pool).await.unwrap();
    h.json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_oauth_attempts WHERE connection_id=$1")
            .bind(connection_uuid)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(
        remaining, 2,
        "expired transient records are removed while unexpired replay protection remains"
    );
    assert_eq!(h.token_requests.lock().unwrap().len(), 1);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    h.finish().await;
}

#[tokio::test]
#[ignore = "requires dedicated TEST_DATABASE_URL; only contacts a loopback fixture"]
async fn oauth_binds_cimd_pkce_resource_owner_and_single_use_state_and_encrypts_tokens() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let h = Harness::with_authorization(true).await;
    let alice = h.register("plugin_oauth_alice").await;
    let bob = h.register("plugin_oauth_bob").await;
    let discovery = h.discover(&alice).await;
    let connection = h
        .json(
            "POST",
            "/v1/plugins/connections",
            &alice,
            Some(add_body(&discovery)),
            StatusCode::CREATED,
        )
        .await;
    assert_eq!(connection["status"], "auth_required");
    let connection = connection["id"].as_str().unwrap();
    let start_path = format!("/v1/plugins/connections/{connection}/oauth/start");
    h.json("POST", &start_path, &bob, None, StatusCode::NOT_FOUND)
        .await;
    let metadata = read_json(
        h.request("GET", "/oauth/client-metadata.json", None, None)
            .await,
    )
    .await;
    assert_eq!(
        metadata["client_id"],
        "https://q.example/oauth/client-metadata.json"
    );
    assert_eq!(metadata["token_endpoint_auth_method"], "none");
    assert!(metadata.get("client_secret").is_none());
    let first = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let first_url = reqwest::Url::parse(first["authorization_url"].as_str().unwrap()).unwrap();
    let first_query: HashMap<_, _> = first_url.query_pairs().into_owned().collect();
    assert_eq!(
        first_query["client_id"],
        "https://q.example/oauth/client-metadata.json"
    );
    assert_eq!(first_query["code_challenge_method"], "S256");
    assert_eq!(first_query["resource"], format!("{}/mcp", h.origin));
    assert_eq!(first_query["scope"], "records:read");
    assert!(!first_url.as_str().contains(&alice));
    let first_attempt = first["attempt_id"].as_str().unwrap();
    h.json(
        "GET",
        &format!("/v1/plugins/oauth/attempts/{first_attempt}"),
        &bob,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    let unknown = h
        .request(
            "GET",
            &oauth_callback(&"A".repeat(43), &format!("{}/issuer", h.origin)),
            None,
            None,
        )
        .await;
    assert_eq!(unknown.status(), StatusCode::SEE_OTHER);
    assert!(h.token_requests.lock().unwrap().is_empty());
    let wrong_issuer = h
        .request(
            "GET",
            &oauth_callback(&first_query["state"], "https://wrong-issuer.example"),
            None,
            None,
        )
        .await;
    assert_eq!(wrong_issuer.status(), StatusCode::SEE_OTHER);
    assert_eq!(wrong_issuer.headers()["cache-control"], "no-store");
    assert_eq!(wrong_issuer.headers()["referrer-policy"], "no-referrer");
    assert!(h.token_requests.lock().unwrap().is_empty());
    let failed = h
        .json(
            "GET",
            &format!("/v1/plugins/oauth/attempts/{first_attempt}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error_code"], "PLUGIN_OAUTH_ISSUER_MISMATCH");
    // A remote OAuth failure must not invalidate the independent Q login.
    h.json(
        "GET",
        "/v1/plugins/connections",
        &alice,
        None,
        StatusCode::OK,
    )
    .await;

    let start = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let url = reqwest::Url::parse(start["authorization_url"].as_str().unwrap()).unwrap();
    let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
    let attempt = start["attempt_id"].as_str().unwrap();
    let callback = oauth_callback(&query["state"], &format!("{}/issuer", h.origin));
    let response = h.request("GET", &callback, None, None).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers()["location"], "/oauth/complete");
    let completed = h
        .json(
            "GET",
            &format!("/v1/plugins/oauth/attempts/{attempt}"),
            &alice,
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(completed["status"], "succeeded");
    assert_eq!(h.token_requests.lock().unwrap().len(), 1);
    let token_request = h.token_requests.lock().unwrap()[0].clone();
    let verifier = &token_request["code_verifier"];
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        query["code_challenge"]
    );
    let (state_hash, encrypted_verifier): (Vec<u8>, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT state_hash,encrypted_verifier FROM plugin_oauth_attempts WHERE id=$1",
    )
    .bind(Uuid::parse_str(attempt).unwrap())
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(
        state_hash,
        Sha256::digest(query["state"].as_bytes()).to_vec()
    );
    assert!(encrypted_verifier.is_none());
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_tokens FROM plugin_oauth_tokens WHERE connection_id=$1",
    )
    .bind(Uuid::parse_str(connection).unwrap())
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert!(encrypted.len() > 28);
    assert!(
        !encrypted
            .windows(b"fixture-token".len())
            .any(|window| window == b"fixture-token")
    );
    assert!(
        !encrypted
            .windows(b"fixture-refresh".len())
            .any(|window| window == b"fixture-refresh")
    );
    let replay = h.request("GET", &callback, None, None).await;
    assert_eq!(replay.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        h.token_requests.lock().unwrap().len(),
        1,
        "callback replay must not exchange the code again"
    );
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &alice,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        h.calls.load(Ordering::SeqCst),
        0,
        "authorization and tools discovery cannot execute a business tool"
    );

    sqlx::query("UPDATE plugin_oauth_tokens SET expires_at=now()-interval '1 second' WHERE connection_id=$1")
        .bind(Uuid::parse_str(connection).unwrap()).execute(&h.state.pool).await.unwrap();
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &alice,
        None,
        StatusCode::OK,
    )
    .await;
    assert_eq!(h.token_requests.lock().unwrap().len(), 2);
    assert_eq!(
        h.token_requests.lock().unwrap()[1]["grant_type"],
        "refresh_token"
    );

    let pending = h
        .json("POST", &start_path, &alice, None, StatusCode::OK)
        .await;
    let pending_url = reqwest::Url::parse(pending["authorization_url"].as_str().unwrap()).unwrap();
    let pending_query: HashMap<_, _> = pending_url.query_pairs().into_owned().collect();
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/v1/plugins/connections/{connection}"),
            Some(&alice),
            None
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let late = h
        .request(
            "GET",
            &oauth_callback(&pending_query["state"], &format!("{}/issuer", h.origin)),
            None,
            None,
        )
        .await;
    assert_eq!(late.status(), StatusCode::SEE_OTHER);
    assert_eq!(
        h.token_requests.lock().unwrap().len(),
        2,
        "a callback after revoke cannot publish or fetch credentials"
    );
    let credentials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_oauth_tokens WHERE connection_id=$1")
            .bind(Uuid::parse_str(connection).unwrap())
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(credentials, 0);
    h.json(
        "GET",
        &format!("/v1/plugins/connections/{connection}/tools"),
        &alice,
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    h.json(
        "GET",
        "/v1/plugins/connections",
        &alice,
        None,
        StatusCode::OK,
    )
    .await;
    h.finish().await;
}
