//! Explicit 2025 MCP compatibility, used only by server-owned financial profiles.
use super::{
    network::SafeHttp,
    protocol::{self, RpcSse},
    types::{McpError, McpResult, RemoteBearer, Tool},
};
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
pub(crate) struct Session<'a> {
    http: &'a SafeHttp,
    endpoint: &'a str,
    token: Option<&'a RemoteBearer>,
    version: String,
    session: Option<String>,
}
impl Drop for Session<'_> {
    fn drop(&mut self) {
        if self.session.is_none() {
            return;
        }
        if let Ok(headers) = self.headers() {
            let http = self.http.clone();
            let endpoint = self.endpoint.to_owned();
            let token = self.token.cloned();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_millis(500),
                    http.delete_session(&endpoint, token.as_ref(), headers),
                )
                .await;
            });
        }
    }
}
impl<'a> Session<'a> {
    pub(crate) fn new(
        http: &'a SafeHttp,
        endpoint: &'a str,
        token: Option<&'a RemoteBearer>,
        initial: &str,
    ) -> Self {
        Self {
            http,
            endpoint,
            token,
            version: initial.into(),
            session: None,
        }
    }
    fn headers(&self) -> McpResult<HeaderMap> {
        let mut h = HeaderMap::new();
        if self.endpoint == "https://mcp.tavily.com/mcp/" && self.token.is_none() {
            h.insert("x-tavily-access-mode", HeaderValue::from_static("keyless"));
        }
        h.insert(
            ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        h.insert(
            "mcp-protocol-version",
            HeaderValue::from_str(&self.version).map_err(|_| McpError::protocol())?,
        );
        if let Some(id) = &self.session {
            h.insert(
                "mcp-session-id",
                HeaderValue::from_str(id).map_err(|_| McpError::protocol())?,
            );
        }
        Ok(h)
    }
    async fn rpc(&self, method: &str, params: Value) -> McpResult<(Value, Option<String>)> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut observer = RpcSse::new(id.clone());
        let response = self
            .http
            .post_json_until(
                self.endpoint,
                &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
                self.token,
                self.headers()?,
                move |chunk, media| {
                    if media.eq_ignore_ascii_case("text/event-stream") {
                        observer.push(chunk);
                        observer.finished()
                    } else {
                        false
                    }
                },
            )
            .await?;
        let session = response
            .headers
            .get("mcp-session-id")
            .map(|v| {
                v.to_str()
                    .map(str::to_owned)
                    .map_err(|_| McpError::protocol())
            })
            .transpose()?;
        if session.as_ref().is_some_and(|s| {
            s.is_empty() || s.len() > 512 || !s.bytes().all(|b| b.is_ascii_graphic())
        }) {
            return Err(McpError::protocol());
        }
        if let (Some(old), Some(new)) = (&self.session, &session)
            && old != new
        {
            return Err(McpError::protocol());
        }
        Ok((protocol::http_result(response, &id)?, session))
    }
    pub(crate) async fn initialize(&mut self) -> McpResult<()> {
        let (result,session)=self.rpc("initialize",json!({"protocolVersion":self.version,"capabilities":{},"clientInfo":{"name":"Q","version":env!("CARGO_PKG_VERSION")}})).await?;
        let version = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|s| VERSIONS.contains(s))
            .ok_or_else(McpError::unsupported)?;
        if !result
            .get("capabilities")
            .and_then(|c| c.get("tools"))
            .is_some_and(Value::is_object)
        {
            return Err(McpError::unsupported());
        }
        self.version = version.into();
        self.session = session;
        let response = self
            .http
            .post_json(
                self.endpoint,
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                self.token,
                self.headers()?,
            )
            .await?;
        if !matches!(response.status, 200 | 202 | 204) {
            return Err(McpError::protocol());
        }
        Ok(())
    }
}
impl Session<'_> {
    pub(crate) async fn read_tools(&self, profile: &[&str]) -> McpResult<Vec<Tool>> {
        let mut tools = Vec::new();
        let mut cursor = None;
        let mut cursors = HashSet::new();
        let mut names = HashSet::new();
        let mut raw_count = 0;
        for _ in 0..8 {
            let (result, _) = self
                .rpc(
                    "tools/list",
                    cursor.as_ref().map_or(json!({}), |c| json!({"cursor":c})),
                )
                .await?;
            let rows = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(McpError::protocol)?;
            raw_count += rows.len();
            if raw_count > 512 {
                return Err(McpError::limit());
            }
            for row in rows {
                let name = row
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(McpError::protocol)?;
                if !names.insert(name.to_owned()) {
                    return Err(McpError::protocol());
                }
                if profile.contains(&name) {
                    tools.push(protocol::validate_tool(row.clone())?);
                }
            }
            match result.get("nextCursor") {
                None | Some(Value::Null) => {
                    if tools.is_empty() {
                        return Err(McpError::unsupported());
                    }
                    protocol::bounded_json(&json!(tools), 128 * 1024, 32, 20000)?;
                    return Ok(tools);
                }
                Some(Value::String(c))
                    if !c.is_empty() && c.len() <= 4096 && cursors.insert(c.clone()) =>
                {
                    cursor = Some(c.clone())
                }
                _ => return Err(McpError::protocol()),
            }
        }
        Err(McpError::limit())
    }
    pub(crate) async fn call_tool(&self, tool: &Tool, args: &Value) -> McpResult<Value> {
        protocol::validate_arguments(tool, args)?;
        let (result, _) = self
            .rpc("tools/call", json!({"name":tool.name,"arguments":args}))
            .await?;
        protocol::validate_tool_result(tool, &result)?;
        Ok(result)
    }
}

pub(crate) async fn tools(
    http: &SafeHttp,
    endpoint: &str,
    token: Option<&RemoteBearer>,
    profile: &[&str],
    initial: &str,
) -> McpResult<Vec<Tool>> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = Session {
            http,
            endpoint,
            token,
            version: initial.into(),
            session: None,
        };
        session.initialize().await?;
        session.read_tools(profile).await
    })
    .await
    .map_err(|_| McpError::timeout())?
}
pub(crate) async fn call(
    http: &SafeHttp,
    endpoint: &str,
    token: Option<&RemoteBearer>,
    tool: &Tool,
    args: &Value,
    initial: &str,
) -> McpResult<Value> {
    protocol::validate_arguments(tool, args)?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut session = Session {
            http,
            endpoint,
            token,
            version: initial.into(),
            session: None,
        };
        session.initialize().await?;
        let (result, _) = session
            .rpc("tools/call", json!({"name":tool.name,"arguments":args}))
            .await?;
        protocol::validate_tool_result(tool, &result)?;
        Ok(result)
    })
    .await
    .map_err(|_| McpError::timeout())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, body::Body, http::StatusCode, response::IntoResponse, routing::post};
    use futures_util::StreamExt;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[test]
    fn tavily_keyless_header_is_exclusive_to_anonymous_official_endpoint() {
        let http = SafeHttp::default();
        let endpoint = "https://mcp.tavily.com/mcp/";
        let anonymous = Session::new(&http, endpoint, None, "2025-11-25");
        assert_eq!(
            anonymous.headers().unwrap()["x-tavily-access-mode"],
            "keyless"
        );
        let token = RemoteBearer::new("fixture-private-key".into(), endpoint).unwrap();
        let personal = Session::new(&http, endpoint, Some(&token), "2025-11-25");
        assert!(
            !personal
                .headers()
                .unwrap()
                .contains_key("x-tavily-access-mode")
        );
        let external = Session::new(&http, "https://other.example/mcp/", None, "2025-11-25");
        assert!(
            !external
                .headers()
                .unwrap()
                .contains_key("x-tavily-access-mode")
        );
        assert!(
            token
                .header_for(&reqwest::Url::parse("https://other.example/mcp/").unwrap())
                .is_err()
        );
    }

    #[tokio::test]
    async fn observed_coingecko_schemas_and_sse_complete_without_waiting_for_eof() {
        // Minimal schema/envelope observed from the official public server; no vendor descriptions or live session IDs.
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let router=Router::new().route("/mcp",post(move|headers:HeaderMap,Json(request):Json<Value>|{let count=count.clone();async move{
            assert!(!headers.contains_key("authorization"));assert!(request.pointer("/params/_meta").is_none());
            let id=request["id"].clone();let method=request["method"].as_str().unwrap();
            if method=="initialize" {return ([("mcp-session-id","fixture-private-session")],Json(json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"coingecko-fixture","version":"1"}}}))).into_response();}
            assert_eq!(headers["mcp-session-id"],"fixture-private-session");assert_eq!(headers["mcp-protocol-version"],"2025-11-25");
            if method=="notifications/initialized" {assert!(request.get("id").is_none());return StatusCode::ACCEPTED.into_response();}
            let result=match method {
              "tools/list"=>json!({"tools":[
                {"name":"execute","description":"Run provided code at the remote vendor","inputSchema":{"type":"object","properties":{"code":{"type":"string"},"intent":{"type":"string"}},"required":["code"]},"annotations":{"readOnlyHint":true}},
                {"name":"search_docs","description":"Search remote SDK documentation","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"language":{"type":"string","enum":["http","python","go","typescript","javascript","terraform","ruby","java","kotlin"]},"detail":{"type":"string","enum":["default","verbose"]}},"required":["query","language"]},"annotations":{"readOnlyHint":true}}
              ]}),
              "tools/call"=>{count.fetch_add(1,Ordering::SeqCst);assert_eq!(request["params"]["name"],"execute");assert!(request["params"]["arguments"]["code"].as_str().unwrap().contains("run(client)"));json!({"content":[{"type":"text","text":json!({"result":{"bitcoin":{"usd":77877,"last_updated_at":1793632253i64}}}).to_string()}]})},
              _=>panic!("unexpected method")
            };
            let frame=format!("event: message\ndata: {}\n\n",json!({"jsonrpc":"2.0","id":id,"result":result}));
            let stream=futures_util::stream::once(async{Ok::<_,std::convert::Infallible>(frame)}).chain(futures_util::stream::pending());
            ([("content-type","text/event-stream")],Body::from_stream(stream)).into_response()
        }}).delete(||async{StatusCode::NO_CONTENT}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let endpoint = format!("{origin}/mcp");
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let http = SafeHttp::test_fixture(origin.parse().unwrap()).unwrap();
        let tools = tokio::time::timeout(
            Duration::from_secs(3),
            tools(
                &http,
                &endpoint,
                None,
                &["execute", "search_docs"],
                "2025-11-25",
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(tools.len(), 2);
        let execute = tools.iter().find(|t| t.name == "execute").unwrap();
        assert!(protocol::validate_arguments(execute, &json!({})).is_err());
        let docs = tools.iter().find(|t| t.name == "search_docs").unwrap();
        assert!(
            protocol::validate_arguments(docs, &json!({"query":"price","language":"typescript"}))
                .is_ok()
        );
        assert!(
            protocol::validate_arguments(docs, &json!({"query":"price","language":"unknown"}))
                .is_err()
        );
        let result=tokio::time::timeout(Duration::from_secs(3),call(&http,&endpoint,None,execute,&json!({"code":"async function run(client) { return await client.simple.price.get({ids:'bitcoin',vs_currencies:'usd'}); }"}),"2025-11-25")).await.unwrap().unwrap();
        let data: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(data["result"]["bitcoin"]["usd"], 77877);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}
