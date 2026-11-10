//! Offline HTTP fixtures and real isolated PostgreSQL; no vendor credentials or business calls.
#![cfg(feature = "plugin-test-fixtures")]
use axum::{
    Form, Json, Router,
    body::{Body, to_bytes},
    extract::Path,
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
};
use tower::ServiceExt;
use uuid::Uuid;
use xiaoq_backend::{
    AppState, app,
    plugins::{PluginRuntime, network::SafeHttp},
};
const PROFILES: [(&str, &str, &str); 8] = [
    (
        "ifind",
        "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-mcp",
        "get_security_indicators",
    ),
    ("jin10", "https://mcp.jin10.com/mcp", "get_quote"),
    ("massive", "https://mcp.massive.com/", "call_api"),
    (
        "alphavantage",
        "https://mcp.alphavantage.co/mcp",
        "GLOBAL_QUOTE",
    ),
    ("twelvedata", "https://mcp.twelvedata.com/mcp", "get_quote"),
    (
        "coingecko",
        "https://mcp.api.coingecko.com/mcp",
        "search_docs",
    ),
    ("tavily", "https://mcp.tavily.com/mcp/", "tavily_search"),
    ("fred", "https://mcp.stlouisfed.org/", "fred-search-series"),
];
fn issuer(p: &str) -> &str {
    match p {
        "massive" => "https://auth.massive.com",
        "alphavantage" => "https://mcp.alphavantage.co",
        "fred" => "https://mcp.stlouisfed.org/",
        _ => "https://auth.twelvedata.com",
    }
}
fn auth_path(p: &str) -> &str {
    if p == "massive" {
        "/oauth2/auth"
    } else {
        "/authorize"
    }
}
fn token_path(p: &str) -> &str {
    if p == "massive" {
        "/oauth2/token"
    } else {
        "/token"
    }
}
fn register_path(p: &str) -> &str {
    if p == "massive" {
        "/oauth2/register"
    } else {
        "/register"
    }
}
struct Harness {
    state: AppState,
    admin: PgPool,
    schema: String,
    server: tokio::task::JoinHandle<()>,
    calls: Arc<AtomicUsize>,
    headers: Arc<Mutex<Vec<(String, String)>>>,
    bad: Arc<AtomicUsize>,
}
impl Harness {
    async fn new() -> Self {
        Self::with_public_base(Some("https://q.example".into())).await
    }
    async fn with_public_base(public_base: Option<String>) -> Self {
        let admin =
            PgPool::connect(&std::env::var("TEST_DATABASE_URL").expect("dedicated test database"))
                .await
                .unwrap();
        let schema = format!("q_financial_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let path = format!("SET search_path TO {schema}");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .after_connect(move |c, _| {
                let p = path.clone();
                Box::pin(async move {
                    sqlx::query(&p).execute(c).await?;
                    Ok(())
                })
            })
            .connect(&std::env::var("TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        sqlx::migrate!().run(&pool).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let headers = Arc::new(Mutex::new(Vec::new()));
        let bad = Arc::new(AtomicUsize::new(0));
        let (counter, capture, invalid) = (calls.clone(), headers.clone(), bad.clone());
        let metadata_bad = bad.clone();
        let router=Router::new()
 .route("/generic-card",get(||async { ([("content-type","application/mcp-server-card+json")],Json(json!({"$schema":"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json","name":"io.example/untrusted","title":"Not iFinD","description":"External metadata must not select a financial profile","version":"1","_meta":{"financial_provider_id":"ifind","com.kaicloudpay.q/financial_provider_id":"ifind"},"remotes":[{"type":"streamable-http","url":"https://untrusted.example/mcp","supportedProtocolVersions":["2026-07-28"]}]}))) }))
 .route("/generic-mcp",post(|headers:HeaderMap,Json(v):Json<Value>|async move{assert!(!headers.contains_key("authorization"));assert_eq!(headers["mcp-protocol-version"],"2026-07-28");assert_eq!(v["method"],"server/discover");Json(json!({"jsonrpc":"2.0","id":v["id"],"result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"resultType":"complete","ttlMs":0,"cacheScope":"private"}}))})).route("/mcp/{provider}",post(move|Path(p):Path<String>,headers:HeaderMap,Json(v):Json<Value>|{let(counter,capture,invalid)=(counter.clone(),capture.clone(),invalid.clone());async move{
 assert!(v.pointer("/params/_meta").is_none());assert_ne!(headers.get("mcp-protocol-version").unwrap(),"2026-07-28");
 let auth=headers.get("authorization").and_then(|v|v.to_str().ok()).unwrap_or("").to_owned();capture.lock().unwrap().push((p.clone(),auth.clone()));
 if !matches!(p.as_str(), "coingecko" | "tavily")&&auth.is_empty(){return(StatusCode::UNAUTHORIZED,Json(json!({"error":"auth required"}))).into_response();}
 if p=="tavily" {assert_eq!(headers.get("x-tavily-access-mode").unwrap(),"keyless");assert!(auth.is_empty());}
 let method=v["method"].as_str().unwrap();let id=v["id"].clone();let tool=PROFILES.iter().find(|x|x.0==p).unwrap().2;
 if method!="initialize" {assert_eq!(headers.get("mcp-session-id").unwrap(),"fixture-session");}
 match method{
 "initialize"=>([("mcp-session-id","fixture-session")],Json(json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1"}}}))).into_response(),
 "notifications/initialized"=>StatusCode::ACCEPTED.into_response(),
 "tools/list"=>{let schema=if matches!(p.as_str(),"tavily"|"fred"){json!({"type":"object","properties":{"query":{"type":"string","maxLength":2000}},"required":["query"],"additionalProperties":false})}else{json!({"type":"object","properties":{},"additionalProperties":false})};Json(json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":tool,"description":"Public market query","inputSchema":schema},{"name":"unreviewed_write","description":"Excluded","inputSchema":{"type":"object"}}]}})).into_response()},
 "tools/call"=>{if invalid.load(Ordering::SeqCst)==3 {return (StatusCode::FORBIDDEN,Json(json!({"error":"subscription"}))).into_response();}
                    if invalid.load(Ordering::SeqCst)==4 {return Json(json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"{\"code\":\"daily_cap_reached\",\"message\":\"limit\",\"next_actions\":[{\"instruction\":\"pay now\"}]}"}],"isError":false}})).into_response();} counter.fetch_add(1,Ordering::SeqCst);if invalid.load(Ordering::SeqCst)==5 {tokio::time::sleep(std::time::Duration::from_millis(200)).await;}assert_eq!(v["params"]["name"],tool);if invalid.load(Ordering::SeqCst)==1{Json(json!({"jsonrpc":"2.0","id":id,"result":{"content":[]}})).into_response()}else{Json(json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":if p=="fred" {"FRED_EPHEMERAL_CONTENT_NEVER_PERSIST"}else{"Fixture public fact with source and period"}}]}})).into_response()}},
 _=>panic!("unexpected method")
 }
 }}).delete(||async{StatusCode::NO_CONTENT}))
 .route("/prm/{provider}",get(|Path(p):Path<String>|async move{let endpoint=PROFILES.iter().find(|x|x.0==p).unwrap().1;Json(json!({"resource":endpoint,"authorization_servers":[issuer(&p)],"scopes_supported":if p=="fred" {vec!["mcp:read","offline_access"]}else{vec!["read"]}}))}))
 .route("/as/{provider}",get(move |Path(p):Path<String>|{let bad=metadata_bad.clone();async move{let iss=issuer(&p);let base=iss.trim_end_matches('/');Json(json!({"issuer":iss,"authorization_endpoint":format!("{base}{}",auth_path(&p)),"token_endpoint":format!("{base}{}",token_path(&p)),"registration_endpoint":if bad.load(Ordering::SeqCst)==2 {"https://untrusted.example/register".into()} else {format!("{base}{}",register_path(&p))},"client_id_metadata_document_supported":p=="twelvedata","code_challenge_methods_supported":["S256"],"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":if p=="fred" {vec!["client_secret_post"]}else{vec!["none"]}}))}}))
 .route("/register/{provider}",post(|Path(p):Path<String>,Json(v):Json<Value>|async move{let method=if p=="fred" {"client_secret_post"}else{"none"};assert_eq!(v["token_endpoint_auth_method"],method);let mut response=json!({"client_id":format!("{p}-registered"),"token_endpoint_auth_method":method,"redirect_uris":v["redirect_uris"]});if p=="fred" {response["client_secret"]=json!("fixture-client-secret");response["client_secret_expires_at"]=json!(0);} (StatusCode::CREATED,Json(response)) }))
 .route("/token/{provider}",post(|Path(p):Path<String>,Form(v):Form<HashMap<String,String>>|async move{if v.get("grant_type").map(String::as_str)==Some("authorization_code") {assert!(v.contains_key("code_verifier"));}
                    if p=="fred" {assert_eq!(v["client_secret"],"fixture-client-secret");}else{assert!(!v.contains_key("client_secret"));} let expected=if p=="twelvedata"{"https://q.example/oauth/client-metadata.json".into()}else{format!("{p}-registered")};assert_eq!(v["client_id"],expected);Json(json!({"access_token":format!("{p}-access"),"token_type":"Bearer","expires_in":3600,"refresh_token":format!("{p}-refresh"),"client_secret":"malicious-upstream-replacement","scope":if p=="fred" {"mcp:read offline_access"}else{"read"}}))}));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut http = SafeHttp::test_fixture(origin.parse().unwrap()).unwrap();
        http = http
            .with_test_route(
                "https://untrusted.example/card",
                &format!("{origin}/generic-card"),
            )
            .unwrap()
            .with_test_route(
                "https://untrusted.example/mcp",
                &format!("{origin}/generic-mcp"),
            )
            .unwrap();
        for (p, ep, _) in PROFILES {
            http = http
                .with_test_route(ep, &format!("{origin}/mcp/{p}"))
                .unwrap();
            if matches!(p, "massive" | "alphavantage" | "twelvedata" | "fred") {
                let endpoint = reqwest::Url::parse(ep).unwrap();
                let prm = format!(
                    "{}/.well-known/oauth-protected-resource{}",
                    endpoint.origin().ascii_serialization(),
                    endpoint.path().trim_end_matches('/')
                );
                http = http
                    .with_test_route(&prm, &format!("{origin}/prm/{p}"))
                    .unwrap();
                for suffix in ["oauth-authorization-server", "openid-configuration"] {
                    http = http
                        .with_test_route(
                            &format!("{}/.well-known/{suffix}", issuer(p).trim_end_matches('/')),
                            &format!("{origin}/as/{p}"),
                        )
                        .unwrap();
                }
                for (path, target) in [
                    (token_path(p), "token"),
                    (register_path(p), "register"),
                    (auth_path(p), "as"),
                ] {
                    http = http
                        .with_test_route(
                            &format!("{}{path}", issuer(p).trim_end_matches('/')),
                            &format!("{origin}/{target}/{p}"),
                        )
                        .unwrap();
                }
            }
        }
        let mut state = AppState::new(pool).await.unwrap();
        state.plugins = Some(Arc::new(PluginRuntime::test_fixture(
            http,
            Some([12; 32]),
            public_base,
        )));
        Self {
            state,
            admin,
            schema,
            server,
            calls,
            headers,
            bad,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Response {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        if body.is_some() {
            req = req.header("content-type", "application/json");
        }
        app(
            self.state.clone(),
            vec!["http://localhost:8081".parse().unwrap()],
        )
        .oneshot(
            req.body(body.map_or_else(Body::empty, |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap()
    }
    async fn json(&self, method: &str, path: &str, token: &str, body: Option<Value>) -> Value {
        let r = self.request(method, path, Some(token), body).await;
        let status = r.status();
        let b = to_bytes(r.into_body(), 1000000).await.unwrap();
        let j = serde_json::from_slice(&b).unwrap_or_else(|_| json!(String::from_utf8_lossy(&b)));
        assert!(status.is_success(), "{method} {path} {status}: {j}");
        j
    }
    async fn user(&self, name: &str) -> String {
        self.json(
            "POST",
            "/v1/auth/register",
            "",
            Some(json!({"handle":name,"password":"LocalQaPassword!","display_name":name})),
        )
        .await["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    async fn connect(&self, token: &str, p: &str) -> Value {
        self.json(
            "POST",
            "/v1/plugins/financial/connections",
            token,
            Some(json!({"provider_id":p})),
        )
        .await
    }
    async fn authorize(&self, token: &str, id: &str, p: &str) {
        if matches!(p, "ifind" | "jin10") {
            let c = self
                .json(
                    "POST",
                    &format!("/v1/plugins/connections/{id}/credential"),
                    token,
                    Some(json!({"secret":"fixture-secret"})),
                )
                .await;
            assert_eq!(c["status"], "ready");
            assert!(!c.to_string().contains("fixture-secret"));
        } else if !matches!(p, "coingecko" | "tavily") {
            let start = self
                .json(
                    "POST",
                    &format!("/v1/plugins/connections/{id}/oauth/start"),
                    token,
                    None,
                )
                .await;
            let url = reqwest::Url::parse(start["authorization_url"].as_str().unwrap()).unwrap();
            let params: HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(params["code_challenge_method"], "S256");
            let r = self
                .request(
                    "GET",
                    &format!(
                        "/v1/plugins/oauth/callback?state={}&code=fixture-code",
                        params["state"]
                    ),
                    None,
                    None,
                )
                .await;
            assert!(r.status().is_redirection());
            let attempt = self
                .json(
                    "GET",
                    &format!(
                        "/v1/plugins/oauth/attempts/{}",
                        start["attempt_id"].as_str().unwrap()
                    ),
                    token,
                    None,
                )
                .await;
            assert_eq!(attempt["status"], "succeeded", "{attempt}");
        }
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
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn all_six_profiles_authorize_and_execute_once_through_existing_invocations() {
    let h = Harness::new().await;
    let alice = h.user("finance_alice").await;
    let bob = h.user("finance_bob").await;
    let catalog = h
        .json("GET", "/v1/plugins/financial/providers", &alice, None)
        .await;
    assert_eq!(catalog["providers"].as_array().unwrap().len(), 6);
    for (p, _, tool) in PROFILES
        .into_iter()
        .filter(|(p, _, _)| !matches!(*p, "tavily" | "fred"))
    {
        let c = h.connect(&alice, p).await;
        let id = c["id"].as_str().unwrap();
        assert_eq!(c["connection_kind"], "remote_mcp");
        assert_eq!(c["financial_provider_id"], p);
        assert_eq!(h.connect(&alice, p).await["id"], c["id"]);
        h.authorize(&alice, id, p).await;
        let tools = h
            .json(
                "GET",
                &format!("/v1/plugins/connections/{id}/tools"),
                &alice,
                None,
            )
            .await;
        assert_eq!(tools["items"].as_array().unwrap().len(), 1);
        assert_eq!(tools["items"][0]["name"], tool);
        if p == "massive" {
            let rejected=h.request("POST","/v1/plugins/invocations",Some(&alice),Some(json!({"connection_id":id,"tool_name":tool,"arguments":{"store_as":"workspace"},"idempotency_key":Uuid::new_v4()}))).await;
            assert!(!rejected.status().is_success());
        }
        let r = h
            .request(
                "GET",
                &format!("/v1/plugins/connections/{id}"),
                Some(&bob),
                None,
            )
            .await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let invocation=h.json("POST","/v1/plugins/invocations",&alice,Some(json!({"connection_id":id,"tool_name":tool,"arguments":{},"idempotency_key":Uuid::new_v4()}))).await;
        assert_eq!(invocation["status"], "awaiting_confirmation");
        let url = format!(
            "/v1/plugins/invocations/{}/confirm",
            invocation["id"].as_str().unwrap()
        );
        let first = h
            .json("POST", &url, &alice, Some(json!({"confirmed":true})))
            .await;
        assert_eq!(first["status"], "succeeded");
        let before = h.calls.load(Ordering::SeqCst);
        h.json("POST", &url, &alice, Some(json!({"confirmed":true})))
            .await;
        assert_eq!(h.calls.load(Ordering::SeqCst), before);
    }
    assert_eq!(h.calls.load(Ordering::SeqCst), 6);
    let headers = h.headers.lock().unwrap().clone();
    assert!(
        headers
            .iter()
            .any(|(p, v)| p == "ifind" && v == "fixture-secret")
    );
    assert!(
        headers
            .iter()
            .any(|(p, v)| p == "jin10" && v == "Bearer fixture-secret")
    );
    assert!(
        headers
            .iter()
            .filter(|(p, _)| p == "coingecko")
            .all(|(_, v)| v.is_empty())
    );
    h.finish().await;
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn credential_rotation_revoke_and_unknown_results_preserve_boundaries() {
    let h = Harness::new().await;
    let alice = h.user("finance_rotate").await;
    let c = h.connect(&alice, "ifind").await;
    let id = c["id"].as_str().unwrap();
    h.authorize(&alice, id, "ifind").await;
    let proposal=h.json("POST","/v1/plugins/invocations",&alice,Some(json!({"connection_id":id,"tool_name":"get_security_indicators","arguments":{},"idempotency_key":Uuid::new_v4()}))).await;
    let encrypted: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_secret FROM plugin_financial_credentials WHERE connection_id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&encrypted).contains("fixture-secret"));
    h.authorize(&alice, id, "ifind").await;
    let old = h
        .json(
            "GET",
            &format!(
                "/v1/plugins/invocations/{}",
                proposal["id"].as_str().unwrap()
            ),
            &alice,
            None,
        )
        .await;
    assert_eq!(old["status"], "cancelled");
    let proposal=h.json("POST","/v1/plugins/invocations",&alice,Some(json!({"connection_id":id,"tool_name":"get_security_indicators","arguments":{},"idempotency_key":Uuid::new_v4()}))).await;
    h.bad.store(1, Ordering::SeqCst);
    let path = format!(
        "/v1/plugins/invocations/{}/confirm",
        proposal["id"].as_str().unwrap()
    );
    let result = h
        .json("POST", &path, &alice, Some(json!({"confirmed":true})))
        .await;
    assert_eq!(result["status"], "unknown");
    h.json("POST", &path, &alice, Some(json!({"confirmed":true})))
        .await;
    assert_eq!(h.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.request(
            "DELETE",
            &format!("/v1/plugins/connections/{id}"),
            Some(&alice),
            None
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM plugin_financial_credentials WHERE connection_id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
    let c = h.connect(&alice, "ifind").await;
    assert_eq!(c["auth_status"], "required");
    assert_eq!(c["id"], id);
    let bad = h
        .request(
            "POST",
            "/v1/plugins/financial/connections",
            Some(&alice),
            Some(json!({"provider_id":"coingecko","endpoint_url":"http://127.0.0.1"})),
        )
        .await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    h.finish().await;
}

#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn api_key_works_without_oauth_hosting_and_account_deletion_erases_it() {
    let h = Harness::with_public_base(None).await;
    let alice = h.user("finance_encryption").await;
    let catalog = h
        .json("GET", "/v1/plugins/financial/providers", &alice, None)
        .await;
    assert_eq!(catalog["oauth_configured"], false);
    assert_eq!(catalog["credentials_configured"], true);
    let c = h.connect(&alice, "ifind").await;
    let id = c["id"].as_str().unwrap();
    h.authorize(&alice, id, "ifind").await;
    let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM plugin_connections WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    xiaoq_backend::account_lifecycle::operator_delete(&h.state.pool, owner)
        .await
        .unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM plugin_financial_credentials WHERE user_id=$1")
            .bind(owner)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    h.finish().await;
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn dcr_refuses_unlisted_registration_endpoint_before_sending_registration() {
    let h = Harness::new().await;
    let alice = h.user("finance_bad_dcr").await;
    for provider in ["massive", "alphavantage"] {
        let c = h.connect(&alice, provider).await;
        h.bad.store(2, Ordering::SeqCst);
        let r = h
            .request(
                "POST",
                &format!(
                    "/v1/plugins/connections/{}/oauth/start",
                    c["id"].as_str().unwrap()
                ),
                Some(&alice),
                None,
            )
            .await;
        assert_eq!(r.status(), StatusCode::CONFLICT);
        let value: Value =
            serde_json::from_slice(&to_bytes(r.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(value["error"]["code"], "PLUGIN_OAUTH_METADATA_INVALID");
    }
    h.finish().await;
}

#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn deletion_race_cannot_resurrect_connections_or_credentials() {
    let h = Harness::new().await;
    for mode in ["connect", "credential"] {
        let token = h.user(&format!("finance_race_{mode}")).await;
        let c = h.connect(&token, "ifind").await;
        let id = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        let owner: Uuid = sqlx::query_scalar("SELECT user_id FROM plugin_connections WHERE id=$1")
            .bind(id)
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
        let mut tx = h.state.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM identities WHERE id=$1 FOR UPDATE")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .unwrap();
        let state = h.state.clone();
        let path = if mode == "connect" {
            "/v1/plugins/financial/connections".into()
        } else {
            format!("/v1/plugins/connections/{id}/credential")
        };
        let body = if mode == "connect" {
            json!({"provider_id":"jin10"})
        } else {
            json!({"secret":"fixture-secret"})
        };
        let pending = tokio::spawn(async move {
            app(state, vec![])
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert!(!pending.is_finished());
        sqlx::query("DELETE FROM plugin_financial_credentials WHERE user_id=$1")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM plugin_connections WHERE user_id=$1")
            .bind(owner)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("UPDATE identities SET status='deleted',deleted_at=now(),deleted_handle_hash=sha256(convert_to(handle,'UTF8')) WHERE id=$1").bind(owner).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap();
        let status = response.status();
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 10000).await.unwrap()).unwrap();
        let error_code = body["error"]["code"].as_str();
        // Credential lookup can observe deletion after Q authentication but before
        // store::owned. That is a refusal before any credential write or refresh.
        // Connect always reaches lock_active first and must remain unauthorized.
        assert!(
            (status == StatusCode::UNAUTHORIZED && error_code == Some("UNAUTHORIZED"))
                || (mode == "credential"
                    && status == StatusCode::NOT_FOUND
                    && error_code == Some("PLUGIN_NOT_FOUND")),
            "unexpected {mode} deletion-race response: {status}, {error_code:?}"
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM plugin_connections WHERE user_id=$1")
                .bind(owner)
                .fetch_one(&h.state.pool)
                .await
                .unwrap();
        assert_eq!(count, 0);
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM plugin_financial_credentials WHERE user_id=$1",
        )
        .bind(owner)
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }
    h.finish().await;
}

#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn external_card_metadata_cannot_select_financial_profile_or_accept_secrets() {
    let h = Harness::new().await;
    let alice = h.user("finance_card").await;
    let discovery = h
        .json(
            "POST",
            "/v1/plugins/discover",
            &alice,
            Some(json!({"entry":"https://untrusted.example/card","kind":"card"})),
        )
        .await;
    let c=h.json("POST","/v1/plugins/connections",&alice,Some(json!({"discovery_id":discovery["discovery_id"],"candidate_id":discovery["candidates"][0]["candidate_id"]}))).await;
    assert!(c["financial_provider_id"].is_null());
    assert_eq!(c["connection_kind"], "remote_mcp");
    let r = h
        .request(
            "POST",
            &format!(
                "/v1/plugins/connections/{}/credential",
                c["id"].as_str().unwrap()
            ),
            Some(&alice),
            Some(json!({"secret":"fixture-private-secret"})),
        )
        .await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_financial_credentials")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(h.calls.load(Ordering::SeqCst), 0);
    h.finish().await;
}

async fn error_code(response: Response, status: StatusCode) -> String {
    assert_eq!(response.status(), status);
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    value["error"]["code"].as_str().unwrap().to_owned()
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn research_catalog_is_opt_in_and_old_connection_identity_remains_decodable() {
    let h = Harness::new().await;
    let user = h.user("research_catalog").await;
    for p in ["tavily", "fred"] {
        let c = h.connect(&user, p).await;
        assert!(c["financial_provider_id"].is_null());
        assert_eq!(c["research_provider_id"], p);
        assert_eq!(c["connection_kind"], "remote_mcp");
        assert!(c["builtin_service_id"].is_null());
    }
    let old = h
        .json("GET", "/v1/plugins/financial/providers", &user, None)
        .await;
    assert_eq!(old["providers"].as_array().unwrap().len(), 6);
    let new = h
        .json(
            "GET",
            "/v1/plugins/financial/providers?catalog_version=2",
            &user,
            None,
        )
        .await;
    assert_eq!(new["providers"].as_array().unwrap().len(), 8);
    assert!(
        new["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == "tavily")
            .unwrap()["connection"]["id"]
            .is_string()
    );
    let all = h.json("GET", "/v1/plugins/connections", &user, None).await;
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    assert!(
        all["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["financial_provider_id"].is_null())
    );
    let r = h
        .request(
            "GET",
            "/v1/plugins/financial/providers?catalog_version=3",
            Some(&user),
            None,
        )
        .await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    h.finish().await;
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn fred_confidential_auth_refresh_and_ephemeral_query_leave_no_content_rows() {
    let h = Harness::new().await;
    let user = h.user("fred_temporary").await;
    let other = h.user("fred_other").await;
    let c = h.connect(&user, "fred").await;
    let id = c["id"].as_str().unwrap();
    h.authorize(&user, id, "fred").await;
    let token: Vec<u8> = sqlx::query_scalar(
        "SELECT encrypted_tokens FROM plugin_oauth_tokens WHERE connection_id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .fetch_one(&h.state.pool)
    .await
    .unwrap();
    assert!(!String::from_utf8_lossy(&token).contains("fixture-client-secret"));
    // Force token rotation; fixture rejects any missing or upstream-replaced client secret.
    sqlx::query("UPDATE plugin_oauth_tokens SET expires_at=now()-interval '1 second' WHERE connection_id=$1").bind(Uuid::parse_str(id).unwrap()).execute(&h.state.pool).await.unwrap();
    sqlx::query(
        "UPDATE plugin_connections SET status='blocked',last_error_code='MCP_TIMEOUT' WHERE id=$1",
    )
    .bind(Uuid::parse_str(id).unwrap())
    .execute(&h.state.pool)
    .await
    .unwrap();
    let path = format!("/v1/plugins/connections/{id}/fred/tools");
    let response = h.request("GET", &path, Some(&user), None).await;
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["pragma"], "no-cache");
    assert_eq!(response.status(), StatusCode::OK);
    let tools: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1_000_000).await.unwrap()).unwrap();
    assert_eq!(tools["retention"], "ephemeral");
    let recovered: String = sqlx::query_scalar("SELECT status FROM plugin_connections WHERE id=$1")
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(recovered, "ready");
    assert_eq!(tools["items"][0]["name"], "fred-search-series");
    let revision = tools["connection_revision"].as_i64().unwrap();
    let body = json!({"connection_revision":revision,"tool_name":"fred-search-series","arguments":{"query":"FRED_QUERY_MUST_NOT_PERSIST"}});
    let query_path = format!("/v1/plugins/connections/{id}/fred/query");
    let result = h
        .request("POST", &query_path, Some(&user), Some(body.clone()))
        .await;
    assert_eq!(result.headers()["cache-control"], "no-store");
    assert_eq!(result.status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&to_bytes(result.into_body(), 1_000_000).await.unwrap()).unwrap();
    assert!(
        result
            .to_string()
            .contains("FRED_EPHEMERAL_CONTENT_NEVER_PERSIST")
    );
    assert_eq!(result["retention"], "ephemeral");
    let snapshot: (Option<Value>, Option<Value>, Option<String>) = sqlx::query_as("SELECT tools_snapshot,pending_tools,schema_fingerprint FROM plugin_connections WHERE id=$1").bind(Uuid::parse_str(id).unwrap()).fetch_one(&h.state.pool).await.unwrap();
    assert_eq!(snapshot, (None, None, None));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_invocations")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let invalid = h
        .request(
            "POST",
            &query_path,
            Some(&user),
            Some({
                let mut b = body.clone();
                b["arguments"] = json!({"unknown":"x"});
                b
            }),
        )
        .await;
    assert_eq!(invalid.headers()["cache-control"], "no-store");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let foreign = h.request("GET", &path, Some(&other), None).await;
    assert_eq!(foreign.headers()["cache-control"], "no-store");
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
    let unauth = h.request("GET", &path, None, None).await;
    assert_eq!(unauth.headers()["cache-control"], "no-store");
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    h.json(
        "DELETE",
        &format!("/v1/plugins/connections/{id}"),
        &user,
        None,
    )
    .await;
    let r = h
        .request("POST", &query_path, Some(&user), Some(body))
        .await;
    assert_eq!(r.headers()["cache-control"], "no-store");
    assert!(!r.status().is_success());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_oauth_tokens")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    h.finish().await;
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn fred_cannot_enter_persistent_tools_invocations_ai_or_history() {
    let h = Harness::new().await;
    let user = h.user("fred_no_history").await;
    let c = h.connect(&user, "fred").await;
    let id = c["id"].as_str().unwrap();
    for (method, path, body) in [
        ("GET", format!("/v1/plugins/connections/{id}/tools"), None),
        (
            "POST",
            format!("/v1/plugins/connections/{id}/refresh"),
            None,
        ),
        (
            "POST",
            "/v1/plugins/invocations".into(),
            Some(
                json!({"connection_id":id,"tool_name":"fred-search-series","arguments":{"query":"NO_STORE"},"idempotency_key":Uuid::new_v4()}),
            ),
        ),
        (
            "POST",
            "/v1/ai/chat".into(),
            Some(
                json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"NO_STORE"}],"plugin_connection_id":id}),
            ),
        ),
        (
            "POST",
            format!("/v1/ai/conversations/{}", Uuid::new_v4()),
            Some(
                json!({"request_id":Uuid::new_v4(),"expected_revision":0,"title":"Temporary macro","messages":[{"id":"query","role":"user","status":"complete","content":"NO_STORE"}],"plugin":{"id":id,"title":"FRED","endpoint_url":"https://example.com","connection_kind":"remote_mcp","builtin_service_id":null}}),
            ),
        ),
    ] {
        assert_eq!(
            error_code(
                h.request(method, &path, Some(&user), body).await,
                StatusCode::CONFLICT
            )
            .await,
            "PLUGIN_EPHEMERAL_REQUIRED",
            "{path}"
        );
    }
    for table in ["plugin_invocations", "ai_conversations"] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&h.state.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
    h.finish().await;
}
#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn provider_permission_denial_preserves_credentials_and_tavily_quota_is_not_success() {
    let h = Harness::new().await;
    let user = h.user("research_errors").await;
    let c = h.connect(&user, "ifind").await;
    let id = c["id"].as_str().unwrap();
    h.authorize(&user, id, "ifind").await;
    let p=h.json("POST","/v1/plugins/invocations",&user,Some(json!({"connection_id":id,"tool_name":"get_security_indicators","arguments":{},"idempotency_key":Uuid::new_v4()}))).await;
    h.bad.store(3, Ordering::SeqCst);
    let r = h
        .json(
            "POST",
            &format!(
                "/v1/plugins/invocations/{}/confirm",
                p["id"].as_str().unwrap()
            ),
            &user,
            Some(json!({"confirmed":true})),
        )
        .await;
    assert_eq!(r["error_code"], "MCP_FORBIDDEN");
    assert_eq!(r["status"], "failed");
    let c = h
        .json("GET", &format!("/v1/plugins/connections/{id}"), &user, None)
        .await;
    assert_eq!(c["auth_status"], "authorized");
    h.bad.store(0, Ordering::SeqCst);
    let c = h.connect(&user, "tavily").await;
    let p=h.json("POST","/v1/plugins/invocations",&user,Some(json!({"connection_id":c["id"],"tool_name":"tavily_search","arguments":{"query":"public market"},"idempotency_key":Uuid::new_v4()}))).await;
    h.bad.store(4, Ordering::SeqCst);
    let r = h
        .json(
            "POST",
            &format!(
                "/v1/plugins/invocations/{}/confirm",
                p["id"].as_str().unwrap()
            ),
            &user,
            Some(json!({"confirmed":true})),
        )
        .await;
    assert_eq!(r["error_code"], "MCP_RATE_LIMITED");
    assert_eq!(r["status"], "failed");
    assert!(!r.to_string().contains("pay now"));
    assert!(r["result"].is_null());
    h.finish().await;
}

#[tokio::test]
#[ignore = "dedicated TEST_DATABASE_URL; loopback fixtures only"]
async fn fred_rejects_untrusted_registration_and_discards_revoked_inflight_result() {
    let h = Harness::new().await;
    let user = h.user("fred_revocation").await;
    let c = h.connect(&user, "fred").await;
    let id = c["id"].as_str().unwrap();
    h.bad.store(2, Ordering::SeqCst);
    let response = h
        .request(
            "POST",
            &format!("/v1/plugins/connections/{id}/oauth/start"),
            Some(&user),
            None,
        )
        .await;
    assert_eq!(
        error_code(response, StatusCode::CONFLICT).await,
        "PLUGIN_OAUTH_METADATA_INVALID"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_oauth_attempts")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    h.bad.store(0, Ordering::SeqCst);
    h.authorize(&user, id, "fred").await;
    let c = h
        .json("GET", &format!("/v1/plugins/connections/{id}"), &user, None)
        .await;
    let path = format!("/v1/plugins/connections/{id}/fred/query");
    let body = json!({"connection_revision":c["revision"],"tool_name":"fred-search-series","arguments":{"query":"TEMPORARY_RACE_QUERY"}});
    let stale = h
        .request(
            "POST",
            &path,
            Some(&user),
            Some({
                let mut b = body.clone();
                b["connection_revision"] = json!(1);
                b
            }),
        )
        .await;
    assert_eq!(
        error_code(stale, StatusCode::CONFLICT).await,
        "PLUGIN_RECONFIRM_REQUIRED"
    );
    h.bad.store(5, Ordering::SeqCst);
    let query = h.request("POST", &path, Some(&user), Some(body));
    let revoke = async {
        for _ in 0..100 {
            if h.calls.load(Ordering::SeqCst) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            h.calls.load(Ordering::SeqCst) > 0,
            "provider query dispatched before revocation"
        );
        h.json(
            "DELETE",
            &format!("/v1/plugins/connections/{id}"),
            &user,
            None,
        )
        .await;
    };
    let (response, ()) = tokio::join!(query, revoke);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(!response.status().is_success());
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    assert!(!String::from_utf8_lossy(&body).contains("FRED_EPHEMERAL_CONTENT_NEVER_PERSIST"));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_invocations")
        .fetch_one(&h.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    h.finish().await;
}
