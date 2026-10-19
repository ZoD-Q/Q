//! A standalone, read-only MCP 2026-07-28 photo gallery. It never downloads images at runtime.
//! Serve behind HTTPS in normal use; the local host fixture explicitly allows this loopback origin.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{seq::SliceRandom, thread_rng};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::sync::Semaphore;

const VERSION: &str = "2026-07-28";
const NAME: &str = "com.q/beauty-gallery";
const RESOURCE_PREFIX: &str = "beauty://photos/";
#[derive(Clone, Deserialize)]
struct Photo {
    id: String,
    title: String,
    filename: String,
    source_url: String,
    author: String,
    license: String,
    license_url: String,
    adult_basis: String,
    width: u32,
    height: u32,
    #[serde(default)]
    attribution: Option<String>,
}
#[derive(Deserialize)]
struct Manifest {
    version: u32,
    photos: Vec<Photo>,
}
struct Gallery {
    base: String,
    directory: PathBuf,
    photos: Vec<Photo>,
    reads: Arc<Semaphore>,
}

fn info() -> Value {
    json!({"name":NAME,"title":"美女 MCP","version":"1.0.0"})
}
fn complete(mut value: Value) -> Value {
    value["resultType"] = json!("complete");
    value["_meta"] = json!({"io.modelcontextprotocol/serverInfo":info()});
    value
}
fn rpc_error(id: Value, code: i64, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})),
    )
        .into_response()
}
fn rpc_ok(id: Value, result: Value) -> Response {
    Json(json!({"jsonrpc":"2.0","id":id,"result":complete(result)})).into_response()
}
fn description(photo: &Photo) -> String {
    format!(
        "作品 / Title: {}\n署名 / Attribution: {}\n许可 / License: {}\n来源 / Source: {}\n许可详情 / License terms: {}\n修改 / Changes: Wikimedia thumbnail; no further edits by Q.",
        photo.title,
        photo.attribution.as_deref().unwrap_or(&photo.author),
        photo.license,
        photo.source_url,
        photo.license_url
    )
}
fn mime(photo: &Photo) -> &'static str {
    match PathBuf::from(&photo.filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}
fn link(photo: &Photo) -> Value {
    json!({"type":"resource_link","uri":format!("{RESOURCE_PREFIX}{}",photo.id),"name":photo.id,"title":photo.title,"description":description(photo),"mimeType":mime(photo)})
}
fn output(photos: &[Photo], total: usize, offset: usize) -> Value {
    let mut content = vec![
        json!({"type":"text","text":format!("已准备 {} 张公开授权的成年女性人像。图库共 {} 张；可在图片查看器中左右切换，图片说明保留作者、来源和许可。",photos.len(),total)}),
    ];
    content.extend(photos.iter().map(link));
    json!({"content":content,"isError":false,"structuredContent":{"total":total,"offset":offset,"count":photos.len(),"photo_ids":photos.iter().map(|photo| &photo.id).collect::<Vec<_>>()}})
}
fn tools() -> Value {
    let schema = json!({"type":"object","required":["total","offset","count","photo_ids"],"properties":{"total":{"type":"integer"},"offset":{"type":"integer"},"count":{"type":"integer"},"photo_ids":{"type":"array","items":{"type":"string"}}}});
    json!({"tools":[
        {"name":"browse_photos","title":"浏览照片图库","description":"浏览公开授权的成年女性人像照片。连续浏览时可省略参数，默认返回全部300张的资源链接；不返回图像大字节，不需要账户或收费。","inputSchema":{"type":"object","properties":{"offset":{"type":"integer","minimum":0,"maximum":299,"default":0},"limit":{"type":"integer","minimum":1,"maximum":300,"default":300}},"additionalProperties":false},"outputSchema":schema,"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}},
        {"name":"random_photo","title":"随机看一张","description":"从图库随机挑选一张公开授权的成年女性人像，并返回可读取的图片资源与来源说明。","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":schema,"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}
    ],"ttlMs":60000,"cacheScope":"public"})
}
async fn card(State(gallery): State<Arc<Gallery>>) -> Response {
    ([(header::CONTENT_TYPE,"application/mcp-server-card+json")], Json(json!({
        "$schema":"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
        "name":NAME,"title":"美女 MCP","version":"1.0.0","description":"公开授权的成年女性人像图库，支持浏览、随机选图和查看来源。",
        "websiteUrl":gallery.base,"remotes":[{"type":"streamable-http","url":format!("{}/mcp",gallery.base),"supportedProtocolVersions":[VERSION]}]
    }))).into_response()
}
async fn catalog(State(gallery): State<Arc<Gallery>>) -> Response {
    ([(header::CONTENT_TYPE,"application/ai-catalog+json")],Json(json!({"specVersion":"1.0","entries":[{"identifier":"urn:air:q.example:mcp:beauty-gallery","type":"application/mcp-server-card+json","url":format!("{}/server-card.json",gallery.base)}]}))).into_response()
}
async fn intro() -> Html<&'static str> {
    Html(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>美女 MCP</title><link rel=\"ai-catalog\" type=\"application/ai-catalog+json\" href=\"/.well-known/ai-catalog.json\"></head><body><h1>美女 MCP</h1><p>公开授权的成年女性人像图库。通过 MCP 浏览、读取照片并查看来源与许可。</p><p><a href=\"/server-card.json\">Server Card</a></p><p>图片作者及许可随每张资源提供；照片人物不代表与 Q 存在合作关系。</p></body></html>",
    )
}

async fn rpc(
    State(gallery): State<Arc<Gallery>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    if headers
        .get(header::ORIGIN)
        .is_some_and(|value| value.to_str().ok() != Some(gallery.base.as_str()))
    {
        return rpc_error(id, -32600, "Origin is not allowed.", StatusCode::FORBIDDEN);
    }
    if body.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || !(id.is_string() || id.is_number())
    {
        return rpc_error(
            id,
            -32600,
            "Invalid JSON-RPC request.",
            StatusCode::BAD_REQUEST,
        );
    }
    let Some(method) = body.get("method").and_then(Value::as_str) else {
        return rpc_error(id, -32600, "Method required.", StatusCode::BAD_REQUEST);
    };
    let Some(params) = body.get("params").and_then(Value::as_object) else {
        return rpc_error(
            id,
            -32602,
            "params and per-request metadata are required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(meta) = params.get("_meta").and_then(Value::as_object) else {
        return rpc_error(
            id,
            -32602,
            "Per-request metadata is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    if meta
        .get("io.modelcontextprotocol/protocolVersion")
        .and_then(Value::as_str)
        != Some(VERSION)
    {
        return (StatusCode::BAD_REQUEST,Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32022,"message":"Unsupported protocol version.","data":{"supported":[VERSION],"requested":meta.get("io.modelcontextprotocol/protocolVersion")}}}))).into_response();
    }
    if !meta
        .get("io.modelcontextprotocol/clientCapabilities")
        .is_some_and(Value::is_object)
    {
        return rpc_error(
            id,
            -32602,
            "clientCapabilities is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if headers
        .get("mcp-protocol-version")
        .and_then(|value| value.to_str().ok())
        != Some(VERSION)
        || headers
            .get("mcp-method")
            .and_then(|value| value.to_str().ok())
            != Some(method)
    {
        return rpc_error(
            id,
            -32020,
            "MCP HTTP headers must match the request body.",
            StatusCode::BAD_REQUEST,
        );
    }
    if matches!(method, "tools/call" | "resources/read" | "prompts/get") {
        let name = if method == "resources/read" {
            params.get("uri")
        } else {
            params.get("name")
        }
        .and_then(Value::as_str);
        let header_name = headers
            .get("mcp-name")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                if let Some(encoded) = value
                    .strip_prefix("=?base64?")
                    .and_then(|value| value.strip_suffix("?="))
                {
                    STANDARD
                        .decode(encoded)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                } else {
                    Some(value.to_owned())
                }
            });
        if name.is_none() || header_name.as_deref() != name {
            return rpc_error(
                id,
                -32020,
                "Mcp-Name must match the requested name or URI.",
                StatusCode::BAD_REQUEST,
            );
        }
    }
    let result = match method {
        "server/discover" => {
            json!({"supportedVersions":[VERSION],"capabilities":{"tools":{},"resources":{},"prompts":{}},"ttlMs":60000,"cacheScope":"public"})
        }
        "tools/list" => tools(),
        "tools/call" => {
            let Some(arguments) = params.get("arguments").and_then(Value::as_object) else {
                return rpc_error(
                    id,
                    -32602,
                    "arguments must be an object.",
                    StatusCode::BAD_REQUEST,
                );
            };
            match params.get("name").and_then(Value::as_str) {
                Some("browse_photos") => {
                    if arguments
                        .keys()
                        .any(|key| !["offset", "limit"].contains(&key.as_str()))
                    {
                        return rpc_error(id, -32602, "Unknown argument.", StatusCode::BAD_REQUEST);
                    }
                    let offset = match arguments.get("offset") {
                        None => 0,
                        Some(value) => match value.as_u64() {
                            Some(value) if value < gallery.photos.len() as u64 => value as usize,
                            _ => {
                                return rpc_error(
                                    id,
                                    -32602,
                                    "offset is outside the gallery.",
                                    StatusCode::BAD_REQUEST,
                                );
                            }
                        },
                    };
                    let limit = match arguments.get("limit") {
                        None => 300,
                        Some(value) => match value.as_u64() {
                            Some(value) if (1..=300).contains(&value) => value as usize,
                            _ => {
                                return rpc_error(
                                    id,
                                    -32602,
                                    "limit must be from 1 to 300.",
                                    StatusCode::BAD_REQUEST,
                                );
                            }
                        },
                    };
                    output(
                        &gallery.photos[offset..(offset + limit).min(gallery.photos.len())],
                        gallery.photos.len(),
                        offset,
                    )
                }
                Some("random_photo") if arguments.is_empty() => {
                    let photo = gallery
                        .photos
                        .choose(&mut thread_rng())
                        .expect("validated gallery")
                        .clone();
                    output(&[photo], gallery.photos.len(), 0)
                }
                _ => {
                    return rpc_error(
                        id,
                        -32602,
                        "Unknown tool or arguments.",
                        StatusCode::BAD_REQUEST,
                    );
                }
            }
        }
        "resources/list" => {
            json!({"resources":gallery.photos.iter().map(|photo| {let mut item=link(photo);item.as_object_mut().expect("resource").remove("type");item}).collect::<Vec<_>>(),"ttlMs":60000,"cacheScope":"public"})
        }
        "resources/read" => {
            let uri = params.get("uri").and_then(Value::as_str).unwrap_or("");
            let Some(photo) = uri
                .strip_prefix(RESOURCE_PREFIX)
                .and_then(|id| gallery.photos.iter().find(|photo| photo.id == id))
                .cloned()
            else {
                return rpc_error(id, -32002, "Resource not found.", StatusCode::NOT_FOUND);
            };
            let Ok(_permit) = gallery.reads.clone().try_acquire_owned() else {
                return rpc_error(
                    id,
                    -32000,
                    "Gallery busy; try later.",
                    StatusCode::TOO_MANY_REQUESTS,
                );
            };
            let path = gallery.directory.join(&photo.filename);
            let bytes = match tokio::task::spawn_blocking(move || std::fs::read(path)).await {
                Ok(Ok(bytes)) if bytes.len() <= 768 * 1024 => bytes,
                _ => {
                    return rpc_error(
                        id,
                        -32603,
                        "Photo could not be read.",
                        StatusCode::INTERNAL_SERVER_ERROR,
                    );
                }
            };
            json!({"contents":[{"uri":uri,"mimeType":mime(&photo),"blob":STANDARD.encode(bytes)}],"ttlMs":3600000,"cacheScope":"public"})
        }
        "prompts/list" => {
            json!({"prompts":[{"name":"view_gallery","title":"浏览公开人像","description":"用图库工具开始浏览公开授权照片。"}],"ttlMs":60000,"cacheScope":"public"})
        }
        "prompts/get" if params.get("name").and_then(Value::as_str) == Some("view_gallery") => {
            json!({"description":"浏览图库","messages":[{"role":"user","content":{"type":"text","text":"请调用 browse_photos，让我连续浏览照片，并保留每张照片的来源与许可。"}}]})
        }
        "ping" => json!({}),
        _ => return rpc_error(id, -32601, "Method not supported.", StatusCode::NOT_FOUND),
    };
    rpc_ok(id, result)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let directory = env::var_os("BEAUTY_MCP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/beauty-gallery-data")
        });
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
    if manifest.version != 1 || manifest.photos.len() != 300 {
        return Err("Gallery requires a verified manifest of exactly 300 photos".into());
    }
    let mut ids = std::collections::HashSet::new();
    for photo in &manifest.photos {
        if photo.id.is_empty()
            || !photo
                .id
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'-' || value == b'_')
            || !ids.insert(&photo.id)
            || photo.filename.starts_with('/')
            || photo.filename.split(['/', '\\']).any(|part| part == "..")
            || !directory.join(&photo.filename).is_file()
            || !photo.source_url.starts_with("https://")
            || !photo.license_url.starts_with("https://")
            || photo.author.is_empty()
            || photo.adult_basis.is_empty()
            || photo.width == 0
            || photo.height == 0
            || photo.width > 4096
            || photo.height > 4096
        {
            return Err("Invalid gallery manifest".into());
        }
    }
    let base = env::var("BEAUTY_MCP_PUBLIC_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8795".into())
        .trim_end_matches('/')
        .to_owned();
    let parsed = reqwest::Url::parse(&base)?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || !["http", "https"].contains(&parsed.scheme())
    {
        return Err("Invalid public base URL".into());
    }
    let bind: SocketAddr = env::var("BEAUTY_MCP_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8795".into())
        .parse()?;
    if !bind.ip().is_loopback() {
        return Err(
            "Bind this example on loopback and terminate HTTPS with your reverse proxy".into(),
        );
    }
    let gallery = Arc::new(Gallery {
        base: base.clone(),
        directory,
        photos: manifest.photos,
        reads: Arc::new(Semaphore::new(8)),
    });
    let app = Router::new()
        .route("/", get(intro))
        .route("/server-card.json", get(card))
        .route("/.well-known/ai-catalog.json", get(catalog))
        .route("/mcp", post(rpc))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .with_state(gallery);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    println!("Beauty MCP: 300 licensed photos; Card: {base}/server-card.json");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
