//! Native UI QA: isolated database and fixed-provider loopback responses only.
//! Use the documented demo login and `fixture-personal-key`, never real credentials.
#[cfg(not(feature = "plugin-test-fixtures"))]
fn main() {
    eprintln!("Enable --features plugin-test-fixtures for the local plugin access preview.");
}

#[cfg(feature = "plugin-test-fixtures")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use axum::{Json, Router, http::HeaderMap, response::IntoResponse, routing::post};
    use serde_json::{Value, json};
    use sqlx::{PgPool, postgres::PgPoolOptions};
    use std::sync::Arc;
    use xiaoq_backend::{
        AppState, app, identity,
        plugins::{PluginRuntime, network::SafeHttp},
    };

    let database = std::env::var("TEST_DATABASE_URL")?;
    let url = reqwest::Url::parse(&database)?;
    if !matches!(url.scheme(), "postgres" | "postgresql")
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/q_plugin_ui_20261115"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Preview requires dedicated loopback q_plugin_ui_20261115 database".into());
    }
    let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let origin = format!("http://{}", provider.local_addr()?);
    let fixture = Router::new().route("/mcp", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
        let personal = headers.get("authorization").is_some();
        if (personal && (headers.get("authorization").and_then(|v|v.to_str().ok()) != Some("Bearer fixture-personal-key") || headers.contains_key("x-tavily-access-mode")))
            || (!personal && headers.get("x-tavily-access-mode").and_then(|v|v.to_str().ok()) != Some("keyless"))
        {
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
        let result = match body["method"].as_str() {
            Some("initialize") => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"LOCAL QA FIXTURE","version":"1"}}),
            Some("notifications/initialized") => return axum::http::StatusCode::ACCEPTED.into_response(),
            Some("tools/list") => json!({"tools":[{"name":"tavily_search","description":"Local UI fixture: no external search","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"],"additionalProperties":false}}]}),
            Some("tools/call") => json!({"content":[{"type":"text","text":"Local fixture response, not a real search result."}]}),
            _ => return axum::http::StatusCode::BAD_REQUEST.into_response(),
        };
        ([("mcp-session-id","local-preview")],Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))).into_response()
    }).delete(||async{axum::http::StatusCode::NO_CONTENT}))
    .route("/unavailable", post(||async{axum::http::StatusCode::SERVICE_UNAVAILABLE}));
    let task = tokio::spawn(async move { axum::serve(provider, fixture).await });
    let mut http = SafeHttp::test_fixture(origin.parse()?)?
        .with_test_route("https://mcp.tavily.com/mcp/", &format!("{origin}/mcp"))?;
    for endpoint in [
        "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-ds-mcp",
        "https://mcp.jin10.com/mcp",
        "https://mcp.massive.com/",
        "https://mcp.alphavantage.co/mcp",
        "https://mcp.twelvedata.com/mcp",
        "https://mcp.api.coingecko.com/mcp",
        "https://mcp.stlouisfed.org/",
    ] {
        http = http.with_test_route(endpoint, &format!("{origin}/unavailable"))?;
    }
    let admin = PgPool::connect(&database).await?;
    let schema = format!("q_plugin_preview_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let path = format!("SET search_path TO {schema}");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |c, _| {
            let path = path.clone();
            Box::pin(async move {
                sqlx::query(&path).execute(c).await?;
                Ok(())
            })
        })
        .connect(&database)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    let mut state = AppState::new(pool.clone()).await.map_err(|e| e.code)?;
    state.plugins = Some(Arc::new(PluginRuntime::test_fixture(
        http,
        Some([42; 32]),
        None,
    )));
    identity::seed_demo(&state).await.map_err(|e| e.code)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:18879").await?;
    eprintln!(
        "Local plugin UI fixture on 127.0.0.1:18879, schema {schema}; only use demo credentials and fixture-personal-key. OAuth and AI disabled."
    );
    axum::serve(
        listener,
        app(
            state,
            vec![
                "http://localhost:8099".parse()?,
                "http://127.0.0.1:8099".parse()?,
            ],
        )
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    task.abort();
    pool.close().await;
    admin.close().await;
    Ok(())
}
