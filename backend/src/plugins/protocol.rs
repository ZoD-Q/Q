use std::collections::HashSet;

use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};

use super::{
    network::{HttpResponse, SafeHttp, parse_auth_challenge},
    types::{
        Discovery, ErrorCategory, MAX_RESULT_BYTES, McpError, McpResult, PROTOCOL_VERSION,
        RemoteBearer, Tool,
    },
};

const MAX_TOOLS: usize = 32;
const MAX_PAGES: usize = 8;
const MAX_SCHEMA_BYTES: usize = 65536;

pub(crate) fn bounded_json(
    value: &Value,
    bytes: usize,
    depth: usize,
    nodes: usize,
) -> McpResult<()> {
    if serde_json::to_vec(value)
        .map_err(|_| McpError::protocol())?
        .len()
        > bytes
    {
        return Err(McpError::limit());
    }
    let mut pending = vec![(value, 0)];
    let mut count = 0;
    while let Some((value, level)) = pending.pop() {
        count += 1;
        if count > nodes || level > depth {
            return Err(McpError::limit());
        }
        match value {
            Value::Object(object) => {
                pending.extend(object.values().map(|value| (value, level + 1)))
            }
            Value::Array(array) => pending.extend(array.iter().map(|value| (value, level + 1))),
            _ => {}
        }
    }
    Ok(())
}

fn string(value: Option<&Value>, max: usize) -> McpResult<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= max
                && !value
                    .chars()
                    .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
        })
        .ok_or_else(McpError::protocol)
}

fn schema_validator(schema: &Value) -> McpResult<jsonschema::Validator> {
    if !schema.is_object() {
        return Err(McpError::unsupported());
    }
    bounded_json(schema, MAX_SCHEMA_BYTES, 24, 2048)?;
    let mut stack = vec![(schema, Vec::<String>::new(), 1usize)];
    let mut visited = 0usize;
    while let Some((value, ancestry, work)) = stack.pop() {
        visited += 1;
        if visited > 8192 {
            return Err(McpError::unsupported());
        }
        match value {
            Value::Object(object) => {
                if object.contains_key("$dynamicRef") || object.contains_key("$recursiveRef") {
                    return Err(McpError::unsupported());
                }
                if let Some(reference) = object.get("$ref") {
                    let reference = reference.as_str().ok_or_else(McpError::unsupported)?;
                    if !reference.starts_with("#/")
                        || reference.len() > 512
                        || ancestry.len() > 16
                        || ancestry.iter().any(|value| value == reference)
                    {
                        return Err(McpError::unsupported());
                    }
                    // Recursion and external resolution are outside this bounded validator profile.
                    let target = schema
                        .pointer(&reference[1..])
                        .ok_or_else(McpError::unsupported)?;
                    if target == value {
                        return Err(McpError::unsupported());
                    }
                    let mut next = ancestry.clone();
                    next.push(reference.to_owned());
                    stack.push((target, next, work));
                }
                for keyword in ["anyOf", "oneOf", "allOf"] {
                    if let Some(branches) = object.get(keyword).and_then(Value::as_array)
                        && work.saturating_mul(branches.len().max(1)) > 128
                    {
                        return Err(McpError::unsupported());
                    }
                }
                if object
                    .get("pattern")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.len() > 512)
                {
                    return Err(McpError::unsupported());
                }
                stack.extend(object.iter().map(|(key, value)| {
                    let factor = if matches!(key.as_str(), "anyOf" | "oneOf" | "allOf") {
                        value.as_array().map_or(1, |values| values.len().max(1))
                    } else {
                        1
                    };
                    (value, ancestry.clone(), work.saturating_mul(factor))
                }));
            }
            Value::Array(array) => {
                stack.extend(array.iter().map(|value| (value, ancestry.clone(), work)))
            }
            _ => {}
        }
    }
    let draft = match schema.get("$schema").and_then(Value::as_str) {
        None | Some("https://json-schema.org/draft/2020-12/schema") => {
            jsonschema::Draft::Draft202012
        }
        Some("https://json-schema.org/draft/2019-09/schema") => jsonschema::Draft::Draft201909,
        Some(
            "http://json-schema.org/draft-07/schema#" | "https://json-schema.org/draft-07/schema#",
        ) => jsonschema::Draft::Draft7,
        _ => return Err(McpError::unsupported()),
    };
    jsonschema::options()
        .with_draft(draft)
        .offline()
        .with_pattern_options(jsonschema::PatternOptions::regex())
        .build(schema)
        .map_err(|_| McpError::unsupported())
}

#[derive(Clone)]
struct HeaderBinding {
    name: String,
    path: Vec<String>,
    kind: String,
}

fn header_bindings(schema: &Value) -> McpResult<Vec<HeaderBinding>> {
    let mut pending = vec![(schema, Vec::<String>::new(), true)];
    let mut names = HashSet::new();
    let mut bindings = Vec::new();
    while let Some((value, path, reachable)) = pending.pop() {
        match value {
            Value::Object(object) => {
                if let Some(name) = object.get("x-mcp-header") {
                    let name = string(Some(name), 64)?;
                    let kind = object
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or_else(McpError::unsupported)?;
                    if !reachable
                        || path.is_empty()
                        || !matches!(kind, "string" | "integer" | "boolean")
                        || !name.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte)
                        })
                        || !names.insert(name.to_ascii_lowercase())
                    {
                        return Err(McpError::unsupported());
                    }
                    bindings.push(HeaderBinding {
                        name: name.to_owned(),
                        path: path.clone(),
                        kind: kind.to_owned(),
                    });
                    if bindings.len() > 24 {
                        return Err(McpError::limit());
                    }
                }
                for (key, child) in object {
                    if key == "properties" && reachable {
                        let properties = child.as_object().ok_or_else(McpError::unsupported)?;
                        for (name, property) in properties {
                            let mut next = path.clone();
                            next.push(name.clone());
                            pending.push((property, next, true));
                        }
                    } else {
                        pending.push((child, Vec::new(), false));
                    }
                }
            }
            Value::Array(array) => {
                pending.extend(array.iter().map(|value| (value, Vec::new(), false)))
            }
            _ => {}
        }
    }
    Ok(bindings)
}

pub fn validate_tool(value: Value) -> McpResult<Tool> {
    bounded_json(&value, 128 * 1024, 30, 4096)?;
    let name = string(value.get("name"), 512)?.to_owned();
    if name.chars().count() > 128 || name.chars().any(char::is_control) {
        return Err(McpError::protocol());
    }
    let input_schema = value
        .get("inputSchema")
        .filter(|schema| {
            schema.is_object() && schema.get("type").and_then(Value::as_str) == Some("object")
        })
        .ok_or_else(McpError::protocol)?
        .clone();
    schema_validator(&input_schema)?;
    header_bindings(&input_schema)?;
    let output_schema = value.get("outputSchema").cloned();
    if let Some(schema) = &output_schema {
        schema_validator(schema)?;
    }
    let title = value
        .get("title")
        .map(|title| string(Some(title), 256).map(str::to_owned))
        .transpose()?;
    let description = value
        .get("description")
        .map(|description| string(Some(description), 8192).map(str::to_owned))
        .transpose()?
        .unwrap_or_default();
    if value
        .get("annotations")
        .is_some_and(|value| !value.is_object())
        || value.get("_meta").is_some_and(|value| !value.is_object())
    {
        return Err(McpError::protocol());
    }
    if let Some(annotations) = value.get("annotations") {
        if let Some(title) = annotations.get("title") {
            string(Some(title), 256)?;
        }
        for name in [
            "readOnlyHint",
            "destructiveHint",
            "idempotentHint",
            "openWorldHint",
        ] {
            if annotations
                .get(name)
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(McpError::protocol());
            }
        }
    }
    Ok(Tool {
        name,
        title,
        description,
        input_schema,
        output_schema,
        annotations: value.get("annotations").cloned(),
        meta: value.get("_meta").cloned(),
    })
}

pub fn validate_arguments(tool: &Tool, arguments: &Value) -> McpResult<()> {
    if !arguments.is_object() {
        return Err(McpError::validation());
    }
    bounded_json(arguments, 128 * 1024, 24, 8192)?;
    if !schema_validator(&tool.input_schema)?.is_valid(arguments) {
        return Err(McpError::validation());
    }
    Ok(())
}

fn encoded_header(value: &str) -> McpResult<HeaderValue> {
    let needs_encoding = value.trim() != value
        || !value
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
        || (value.starts_with("=?base64?") && value.ends_with("?="));
    let encoded = if needs_encoding {
        format!("=?base64?{}?=", STANDARD.encode(value.as_bytes()))
    } else {
        value.to_owned()
    };
    if encoded.len() > 8192 {
        return Err(McpError::limit());
    }
    HeaderValue::from_str(&encoded).map_err(|_| McpError::validation())
}

fn call_headers(tool: &Tool, arguments: &Value) -> McpResult<HeaderMap> {
    let mut headers = HeaderMap::new();
    for binding in header_bindings(&tool.input_schema)? {
        let mut value = arguments;
        let mut present = true;
        for segment in &binding.path {
            match value.get(segment) {
                Some(next) => value = next,
                None => {
                    present = false;
                    break;
                }
            }
        }
        if !present || value.is_null() {
            continue;
        }
        let text = match binding.kind.as_str() {
            "string" => value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(McpError::validation)?,
            "boolean" => value
                .as_bool()
                .map(|value| value.to_string())
                .ok_or_else(McpError::validation)?,
            "integer" => {
                let number = value
                    .as_i64()
                    .filter(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
                    .ok_or_else(McpError::validation)?;
                number.to_string()
            }
            _ => return Err(McpError::validation()),
        };
        headers.insert(
            HeaderName::from_bytes(format!("mcp-param-{}", binding.name).as_bytes())
                .map_err(|_| McpError::validation())?,
            encoded_header(&text)?,
        );
    }
    Ok(headers)
}

fn validate_image(data: &str, mime_type: &str) -> McpResult<()> {
    if data.len() > 1024 * 1024 {
        return Err(McpError::limit());
    }
    let bytes = STANDARD.decode(data).map_err(|_| McpError::protocol())?;
    if bytes.len() > 768 * 1024 {
        return Err(McpError::limit());
    }
    let actual = imagesize::image_type(&bytes).map_err(|_| McpError::protocol())?;
    if !matches!(
        (mime_type, actual),
        ("image/jpeg", imagesize::ImageType::Jpeg)
            | ("image/png", imagesize::ImageType::Png)
            | ("image/webp", imagesize::ImageType::Webp)
    ) {
        return Err(McpError::unsupported());
    }
    let size = imagesize::blob_size(&bytes).map_err(|_| McpError::protocol())?;
    if size.width == 0
        || size.height == 0
        || size.width > 4096
        || size.height > 4096
        || size.width.saturating_mul(size.height) > 16_000_000
    {
        return Err(McpError::limit());
    }
    Ok(())
}

fn validate_resource(resource: &Value) -> McpResult<()> {
    string(resource.get("uri"), 8192)?;
    if let Some(text) = resource.get("text") {
        if resource.get("blob").is_some()
            || !text.is_string()
            || text.as_str().unwrap_or("").len() > MAX_RESULT_BYTES
        {
            return Err(McpError::protocol());
        }
    } else if let Some(blob) = resource.get("blob") {
        validate_image(
            string(Some(blob), MAX_RESULT_BYTES)?,
            string(resource.get("mimeType"), 128)?,
        )?;
    } else {
        return Err(McpError::protocol());
    }
    Ok(())
}

fn validate_content(content: &Value) -> McpResult<bool> {
    match string(content.get("type"), 64)? {
        "text" => {
            if !content.get("text").is_some_and(Value::is_string) {
                return Err(McpError::protocol());
            }
            Ok(true)
        }
        "image" => {
            validate_image(
                string(content.get("data"), MAX_RESULT_BYTES)?,
                string(content.get("mimeType"), 128)?,
            )?;
            Ok(false)
        }
        "resource_link" => {
            string(content.get("uri"), 8192)?;
            string(content.get("name"), 512)?;
            Ok(false)
        }
        "resource" => {
            validate_resource(content.get("resource").ok_or_else(McpError::protocol)?)?;
            Ok(false)
        }
        _ => Err(McpError::unsupported()),
    }
}

fn complete_result(result: &Value) -> McpResult<()> {
    bounded_json(result, MAX_RESULT_BYTES, 32, 20000)?;
    match result.get("resultType").and_then(Value::as_str) {
        None if result.is_object() && result.get("resultType").is_none() => Ok(()),
        Some("complete") => Ok(()),
        Some("input_required") => Err(McpError::new(
            "MCP_INPUT_REQUIRED",
            ErrorCategory::Unsupported,
            "The plugin requires another interaction; Q did not retry the operation.",
        )),
        _ => Err(McpError::protocol()),
    }
}

fn cache_hints(result: &Value) -> McpResult<(u64, String)> {
    let ttl = match result.get("ttlMs") {
        None => 0,
        Some(Value::Number(number)) => number.as_u64().ok_or_else(McpError::protocol)?,
        _ => return Err(McpError::protocol()),
    };
    let scope = match result.get("cacheScope").and_then(Value::as_str) {
        None if result.get("cacheScope").is_none() => "private",
        Some("public") => "public",
        Some("private") => "private",
        _ => return Err(McpError::protocol()),
    };
    Ok((ttl, scope.to_owned()))
}

fn remote_error(value: &Value) -> McpError {
    match value.get("code").and_then(Value::as_i64) {
        Some(-32022) => McpError::new(
            "MCP_VERSION_UNSUPPORTED",
            ErrorCategory::Unsupported,
            "The plugin does not support the required MCP version.",
        ),
        Some(-32021) => McpError::new(
            "MCP_CAPABILITY_REQUIRED",
            ErrorCategory::Unsupported,
            "The plugin requires a client capability not supported by Q.",
        ),
        Some(-32020) => McpError::new(
            "MCP_HEADER_MISMATCH",
            ErrorCategory::Protocol,
            "The plugin rejected the request metadata; the operation was not retried.",
        ),
        Some(-32601) => McpError::new(
            "MCP_METHOD_UNSUPPORTED",
            ErrorCategory::Unsupported,
            "The plugin does not support this method.",
        ),
        Some(_) => McpError::new(
            "MCP_REMOTE_ERROR",
            ErrorCategory::Protocol,
            "The plugin rejected the request.",
        ),
        None => McpError::protocol(),
    }
}

fn rpc_message(value: Value, id: &str) -> McpResult<Option<Value>> {
    bounded_json(&value, MAX_RESULT_BYTES + 4096, 36, 22000)?;
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(McpError::protocol());
    }
    if value.get("method").is_some() {
        if value.get("id").is_some()
            || value.get("result").is_some()
            || value.get("error").is_some()
            || !value
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method.starts_with("notifications/"))
        {
            return Err(McpError::protocol());
        }
        return Ok(None);
    }
    if value.get("id").and_then(Value::as_str) != Some(id)
        || value.get("result").is_some() == value.get("error").is_some()
    {
        return Err(McpError::protocol());
    }
    if let Some(error) = value.get("error") {
        return Err(remote_error(error));
    }
    let result = value.get("result").ok_or_else(McpError::protocol)?.clone();
    complete_result(&result)?;
    Ok(Some(result))
}

struct RpcSse {
    id: String,
    line: Vec<u8>,
    data: Vec<String>,
    pending_cr: bool,
    first_line: bool,
    frame_bytes: usize,
    notifications: usize,
    outcome: Option<McpResult<Value>>,
}
impl RpcSse {
    fn new(id: String) -> Self {
        Self {
            id,
            line: Vec::new(),
            data: Vec::new(),
            pending_cr: false,
            first_line: true,
            frame_bytes: 0,
            notifications: 0,
            outcome: None,
        }
    }
    fn push(&mut self, bytes: &[u8]) {
        if self.outcome.is_some() {
            return;
        }
        if let Err(error) = self.process(bytes) {
            self.outcome = Some(Err(error));
        }
    }
    fn process(&mut self, bytes: &[u8]) -> McpResult<()> {
        for &byte in bytes {
            if self.outcome.is_some() {
                break;
            }
            if self.pending_cr {
                self.pending_cr = false;
                if byte == b'\n' {
                    self.count()?;
                    self.end_line()?;
                    continue;
                }
                self.end_line()?;
                if self.outcome.is_some() {
                    break;
                }
            }
            self.count()?;
            match byte {
                b'\r' => self.pending_cr = true,
                b'\n' => self.end_line()?,
                _ => self.line.push(byte),
            }
        }
        Ok(())
    }
    fn count(&mut self) -> McpResult<()> {
        self.frame_bytes += 1;
        if self.frame_bytes > MAX_RESULT_BYTES + 4096 {
            return Err(McpError::limit());
        }
        Ok(())
    }
    fn end_line(&mut self) -> McpResult<()> {
        let mut line = std::str::from_utf8(&self.line).map_err(|_| McpError::protocol())?;
        if self.first_line {
            line = line.trim_start_matches('\u{feff}');
            self.first_line = false;
        }
        if line.is_empty() {
            if !self.data.is_empty() {
                let value: Value = serde_json::from_str(&self.data.join("\n"))
                    .map_err(|_| McpError::protocol())?;
                if let Some(result) = rpc_message(value, &self.id)? {
                    self.outcome = Some(Ok(result));
                } else {
                    self.notifications += 1;
                    if self.notifications > 64 {
                        return Err(McpError::limit());
                    }
                }
            }
            self.data.clear();
            self.frame_bytes = 0;
        } else if !line.starts_with(':') {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            if field == "data" {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        self.line.clear();
        Ok(())
    }
    fn finish(mut self) -> McpResult<Value> {
        if self.pending_cr && self.outcome.is_none() {
            self.end_line()?;
        }
        self.outcome.unwrap_or_else(|| {
            Err(McpError::new(
                "MCP_INCOMPLETE_RESPONSE",
                ErrorCategory::Protocol,
                "The plugin stream ended without a result; the operation was not retried.",
            ))
        })
    }
}

fn http_result(response: HttpResponse, id: &str) -> McpResult<Value> {
    if response.status == 401 || response.status == 403 {
        let mut error = McpError::new(
            if response.status == 401 {
                "MCP_AUTH_REQUIRED"
            } else {
                "MCP_FORBIDDEN"
            },
            ErrorCategory::Authorization,
            "The plugin requires authorization for this operation.",
        )
        .with_status(response.status);
        error.auth_challenge = parse_auth_challenge(&response.headers);
        return Err(error);
    }
    if !(200..300).contains(&response.status) {
        if let Ok(value) = response.json()
            && let Some(error) = value.get("error")
        {
            return Err(remote_error(error).with_status(response.status));
        }
        return Err(McpError::new(
            "MCP_HTTP_ERROR",
            ErrorCategory::Network,
            "The plugin returned an unsuccessful HTTP response.",
        )
        .with_status(response.status));
    }
    match response.media_type().to_ascii_lowercase().as_str() {
        "application/json" => rpc_message(response.json()?, id)?.ok_or_else(McpError::protocol),
        "text/event-stream" => {
            let mut parser = RpcSse::new(id.to_owned());
            parser.push(&response.body);
            parser.finish()
        }
        _ => Err(McpError::protocol()),
    }
}

pub fn validate_tool_result(tool: &Tool, result: &Value) -> McpResult<()> {
    complete_result(result)?;
    if result
        .get("isError")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err(McpError::protocol());
    }
    let content = result
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(McpError::protocol)?;
    if content.len() > 512 {
        return Err(McpError::limit());
    }
    let mut text = false;
    for item in content {
        text |= validate_content(item)?;
    }
    if !text {
        return Err(McpError::protocol());
    }
    if result.get("isError").and_then(Value::as_bool) != Some(true)
        && let Some(schema) = &tool.output_schema
    {
        let structured = result
            .get("structuredContent")
            .ok_or_else(McpError::protocol)?;
        if !schema_validator(schema)?.is_valid(structured) {
            return Err(McpError::protocol());
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct McpClient {
    http: SafeHttp,
}
impl McpClient {
    pub fn new(http: SafeHttp) -> Self {
        Self { http }
    }

    async fn rpc(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
        method: &str,
        parameters: &Value,
        mut headers: HeaderMap,
    ) -> McpResult<Value> {
        let mut parameters = parameters
            .as_object()
            .ok_or_else(McpError::validation)?
            .clone();
        if parameters.contains_key("inputResponses") || parameters.contains_key("requestState") {
            return Err(McpError::unsupported());
        }
        parameters.insert("_meta".into(), json!({
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": {"name": "Q", "version": env!("CARGO_PKG_VERSION")},
            "io.modelcontextprotocol/clientCapabilities": {}
        }));
        let id = uuid::Uuid::new_v4().to_string();
        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": parameters});
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("application/json, text/event-stream"),
        );
        headers.insert(
            "mcp-protocol-version",
            HeaderValue::from_static(PROTOCOL_VERSION),
        );
        headers.insert(
            "mcp-method",
            HeaderValue::from_str(method).map_err(|_| McpError::validation())?,
        );
        if matches!(method, "tools/call" | "resources/read" | "prompts/get") {
            let field = if method == "resources/read" {
                "uri"
            } else {
                "name"
            };
            let name = string(parameters.get(field), 8192)?;
            headers.insert("mcp-name", encoded_header(name)?);
        }
        let mut observer = RpcSse::new(id.clone());
        let response = self
            .http
            .post_json_until(endpoint, &request, bearer, headers, move |chunk, media| {
                if media.eq_ignore_ascii_case("text/event-stream") {
                    observer.push(chunk);
                    observer.outcome.is_some()
                } else {
                    false
                }
            })
            .await?;
        http_result(response, &id)
    }

    pub async fn request(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
        method: &str,
        params: &Value,
    ) -> McpResult<Value> {
        let capability = match method {
            "server/discover" => None,
            "tools/list" => Some("tools"),
            "resources/list" | "resources/read" => Some("resources"),
            "prompts/list" | "prompts/get" => Some("prompts"),
            _ => return Err(McpError::unsupported()),
        };
        if let Some(capability) = capability {
            self.require_capability(endpoint, bearer, capability)
                .await?;
        }
        self.rpc(endpoint, bearer, method, params, HeaderMap::new())
            .await
    }

    pub async fn discover(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Discovery> {
        let result = self
            .rpc(
                endpoint,
                bearer,
                "server/discover",
                &json!({}),
                HeaderMap::new(),
            )
            .await?;
        let versions = result
            .get("supportedVersions")
            .and_then(Value::as_array)
            .filter(|versions| !versions.is_empty() && versions.len() <= 16)
            .ok_or_else(McpError::protocol)?;
        let versions = versions
            .iter()
            .map(|value| string(Some(value), 32).map(str::to_owned))
            .collect::<McpResult<Vec<_>>>()?;
        if !versions.iter().any(|value| value == PROTOCOL_VERSION) {
            return Err(McpError::new(
                "MCP_VERSION_UNSUPPORTED",
                ErrorCategory::Unsupported,
                "The plugin does not advertise the required MCP version.",
            ));
        }
        let capabilities = result
            .get("capabilities")
            .filter(|value| value.is_object())
            .ok_or_else(McpError::protocol)?
            .clone();
        let server_info = result
            .get("_meta")
            .and_then(|value| value.get("io.modelcontextprotocol/serverInfo"))
            .cloned();
        if let Some(info) = &server_info {
            string(info.get("name"), 512)?;
            string(info.get("version"), 256)?;
        }
        let instructions = result
            .get("instructions")
            .map(|value| string(Some(value), 8192).map(str::to_owned))
            .transpose()?;
        let (ttl_ms, cache_scope) = cache_hints(&result)?;
        Ok(Discovery {
            supported_versions: versions,
            capabilities,
            server_info,
            instructions,
            ttl_ms,
            cache_scope,
        })
    }

    async fn require_capability(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
        capability: &str,
    ) -> McpResult<()> {
        if !self
            .discover(endpoint, bearer)
            .await?
            .capabilities
            .get(capability)
            .is_some_and(Value::is_object)
        {
            return Err(McpError::unsupported());
        }
        Ok(())
    }

    async fn list(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
        method: &str,
        field: &str,
        limit: usize,
    ) -> McpResult<Vec<Value>> {
        let mut cursor = None::<String>;
        let mut seen = HashSet::new();
        let mut output = Vec::new();
        for _ in 0..MAX_PAGES {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({"cursor": cursor}))
                .unwrap_or_else(|| json!({}));
            let result = self
                .rpc(endpoint, bearer, method, &params, HeaderMap::new())
                .await?;
            cache_hints(&result)?;
            let values = result
                .get(field)
                .and_then(Value::as_array)
                .ok_or_else(McpError::protocol)?;
            if values.len() + output.len() > limit {
                return Err(McpError::limit());
            }
            output.extend(values.iter().cloned());
            match result.get("nextCursor") {
                None => return Ok(output),
                Some(value) => {
                    let next = string(Some(value), 2048)?.to_owned();
                    if !seen.insert(next.clone()) {
                        return Err(McpError::protocol());
                    }
                    cursor = Some(next);
                }
            }
        }
        Err(McpError::limit())
    }

    pub async fn tools(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Vec<Tool>> {
        self.require_capability(endpoint, bearer, "tools").await?;
        let values = self
            .list(endpoint, bearer, "tools/list", "tools", MAX_TOOLS)
            .await?;
        let mut names = HashSet::new();
        let mut tools = Vec::new();
        for value in values {
            // Invalid definitions, including illegal x-mcp-header, are excluded individually.
            if let Ok(tool) = validate_tool(value) {
                if !names.insert(tool.name.clone()) {
                    return Err(McpError::protocol());
                }
                tools.push(tool);
            }
        }
        Ok(tools)
    }

    pub async fn call_tool(
        &self,
        endpoint: &str,
        tool: &Tool,
        arguments: &Value,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Value> {
        validate_arguments(tool, arguments)?;
        self.require_capability(endpoint, bearer, "tools").await?;
        let result = self
            .rpc(
                endpoint,
                bearer,
                "tools/call",
                &json!({"name": tool.name, "arguments": arguments}),
                call_headers(tool, arguments)?,
            )
            .await?;
        validate_tool_result(tool, &result)?;
        Ok(result)
    }

    pub async fn list_resources(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Vec<Value>> {
        self.require_capability(endpoint, bearer, "resources")
            .await?;
        let resources = self
            .list(endpoint, bearer, "resources/list", "resources", 300)
            .await?;
        for resource in &resources {
            string(resource.get("uri"), 8192)?;
            string(resource.get("name"), 512)?;
        }
        Ok(resources)
    }

    pub async fn read_resource(
        &self,
        endpoint: &str,
        uri: &str,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Value> {
        if uri.is_empty() || uri.len() > 8192 || uri.chars().any(char::is_control) {
            return Err(McpError::validation());
        }
        self.require_capability(endpoint, bearer, "resources")
            .await?;
        let result = self
            .rpc(
                endpoint,
                bearer,
                "resources/read",
                &json!({"uri": uri}),
                HeaderMap::new(),
            )
            .await?;
        cache_hints(&result)?;
        let contents = result
            .get("contents")
            .and_then(Value::as_array)
            .filter(|values| values.len() <= 300)
            .ok_or_else(McpError::protocol)?;
        for resource in contents {
            validate_resource(resource)?;
        }
        Ok(result)
    }

    pub async fn list_prompts(
        &self,
        endpoint: &str,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Vec<Value>> {
        self.require_capability(endpoint, bearer, "prompts").await?;
        let prompts = self
            .list(endpoint, bearer, "prompts/list", "prompts", 100)
            .await?;
        for prompt in &prompts {
            string(prompt.get("name"), 512)?;
        }
        Ok(prompts)
    }

    pub async fn get_prompt(
        &self,
        endpoint: &str,
        name: &str,
        args: &Value,
        bearer: Option<&RemoteBearer>,
    ) -> McpResult<Value> {
        if name.is_empty()
            || name.len() > 512
            || !args
                .as_object()
                .is_some_and(|values| values.len() <= 32 && values.values().all(Value::is_string))
        {
            return Err(McpError::validation());
        }
        bounded_json(args, 65536, 4, 128)?;
        self.require_capability(endpoint, bearer, "prompts").await?;
        let result = self
            .rpc(
                endpoint,
                bearer,
                "prompts/get",
                &json!({"name": name, "arguments": args}),
                HeaderMap::new(),
            )
            .await?;
        let messages = result
            .get("messages")
            .and_then(Value::as_array)
            .filter(|messages| messages.len() <= 100)
            .ok_or_else(McpError::protocol)?;
        for message in messages {
            if !matches!(
                message.get("role").and_then(Value::as_str),
                Some("user" | "assistant")
            ) {
                return Err(McpError::protocol());
            }
            validate_content(message.get("content").ok_or_else(McpError::protocol)?)?;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Url;

    fn tool() -> Tool {
        validate_tool(json!({"name":"weather.lookup","inputSchema":{"type":"object","properties":{"city":{"type":"string","x-mcp-header":"City"}},"required":["city"],"additionalProperties":false},"outputSchema":{"type":"array","items":{"type":"string"}}})).unwrap()
    }

    #[test]
    fn cache_hints_and_authorization_errors_do_not_accept_invalid_or_secret_data() {
        assert_eq!(cache_hints(&json!({})).unwrap(), (0, "private".into()));
        assert!(cache_hints(&json!({"ttlMs":-1})).is_err());
        assert!(cache_hints(&json!({"ttlMs":false})).is_err());
        assert!(cache_hints(&json!({"cacheScope":"other"})).is_err());
        let mut headers = HeaderMap::new();
        headers.insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static(
                "Bearer resource_metadata=\"https://auth.example/resource\", scope=\"read\"",
            ),
        );
        let error = http_result(
            HttpResponse {
                status: 401,
                headers,
                body: b"remote-private-error-body".to_vec(),
                final_url: "https://mcp.example/endpoint".into(),
            },
            "request-id",
        )
        .unwrap_err();
        assert_eq!(error.category, ErrorCategory::Authorization);
        assert_eq!(
            error.auth_challenge.as_ref().unwrap().scope.as_deref(),
            Some("read")
        );
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("remote-private-error-body")
        );
    }

    #[test]
    fn offline_schema_and_input_checks_do_not_resolve_remote_documents() {
        assert!(validate_arguments(&tool(), &json!({"city":"杭州"})).is_ok());
        assert!(validate_arguments(&tool(), &json!({"city":7})).is_err());
        assert!(schema_validator(&json!({"$ref":"https://127.0.0.1/private"})).is_err());
        assert!(schema_validator(&json!({"$ref":"file:///etc/passwd"})).is_err());
        assert!(
            schema_validator(
                &json!({"$defs":{"loop":{"$ref":"#/$defs/loop"}},"$ref":"#/$defs/loop"})
            )
            .is_err()
        );
        let local = json!({"$defs":{"name":{"type":"string"}},"type":"object","properties":{"a":{"$ref":"#/$defs/name"},"b":{"$ref":"#/$defs/name"}}});
        assert!(
            schema_validator(&local)
                .unwrap()
                .is_valid(&json!({"a":"A","b":"B"}))
        );
    }

    #[test]
    fn mirrored_headers_are_utf8_encoded_and_annotations_are_validated() {
        let headers = call_headers(&tool(), &json!({"city":"杭州"})).unwrap();
        assert_eq!(headers["mcp-param-city"], "=?base64?5p2t5bee?=");
        assert_eq!(
            encoded_header(" padded ").unwrap(),
            "=?base64?IHBhZGRlZCA=?="
        );
        assert_eq!(
            encoded_header("=?base64?literal?=").unwrap(),
            "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="
        );
        for schema in [
            json!({"type":"object","properties":{"x":{"type":"number","x-mcp-header":"X"}}}),
            json!({"type":"object","oneOf":[{"properties":{"x":{"type":"string","x-mcp-header":"X"}}}]}),
            json!({"type":"object","properties":{"x":{"type":"string","x-mcp-header":"X"},"y":{"type":"string","x-mcp-header":"x"}}}),
            json!({"type":"object","properties":{"x":{"type":"string","x-mcp-header":"X\r\nInjected"}}}),
        ] {
            assert!(header_bindings(&schema).is_err());
        }
        assert!(validate_tool(json!({"name":"invalid","inputSchema":{"type":"string"}})).is_err());
        assert!(validate_tool(json!({"name":"invalid","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":"true"}})).is_err());
    }

    #[test]
    fn results_keep_structured_arrays_and_require_a_text_fallback() {
        assert!(validate_tool_result(&tool(), &json!({"resultType":"complete","content":[{"type":"text","text":"Weather"}],"structuredContent":["cloudy"]})).is_ok());
        assert!(validate_tool_result(&tool(), &json!({"resultType":"complete","content":[{"type":"text","text":"Weather"}],"structuredContent":{"wrong":"type"}})).is_err());
        assert!(validate_tool_result(&tool(), &json!({"resultType":"complete","isError":true,"content":[{"type":"text","text":"Business failure"}]})).is_ok());
        assert_eq!(
            complete_result(&json!({"resultType":"input_required","inputRequests":{}}))
                .unwrap_err()
                .code,
            "MCP_INPUT_REQUIRED"
        );
        let mut content = vec![json!({"type":"text","text":"Links"})];
        for index in 0..300 {
            content.push(json!({"type":"resource_link","uri":format!("file:///private/{index}"),"name":format!("File {index}")}));
        }
        let mut no_schema = tool();
        no_schema.output_schema = None;
        assert!(validate_tool_result(&no_schema, &json!({"content":content})).is_ok());
    }

    #[test]
    fn sse_parser_accepts_one_byte_utf8_and_does_not_accept_wrong_ids_or_requests() {
        let wire = format!(
            "\u{feff}: keep-alive\r\n\r\ndata: {}\r\n\r\ndata: {}\r\n\r\n",
            json!({"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}),
            json!({"jsonrpc":"2.0","id":"r1","result":{"resultType":"complete","content":[{"type":"text","text":"你好"}]}})
        );
        let mut parser = RpcSse::new("r1".into());
        for byte in wire.bytes() {
            parser.push(&[byte]);
        }
        assert_eq!(parser.finish().unwrap()["content"][0]["text"], "你好");
        for value in [
            json!({"jsonrpc":"2.0","id":"wrong","result":{"resultType":"complete"}}),
            json!({"jsonrpc":"2.0","id":"r1","method":"sampling/createMessage","params":{}}),
        ] {
            assert!(rpc_message(value, "r1").is_err());
        }
        assert_eq!(
            RpcSse::new("r1".into()).finish().unwrap_err().code,
            "MCP_INCOMPLETE_RESPONSE"
        );
    }

    #[test]
    fn image_validation_checks_signature_dimensions_and_mime() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
        assert!(validate_image(png, "image/png").is_ok());
        assert!(validate_image(png, "image/jpeg").is_err());
        assert!(validate_image(&STANDARD.encode(b"<svg>evil</svg>"), "image/svg+xml").is_err());
        let mut large = STANDARD.decode(png).unwrap();
        large[16..20].copy_from_slice(&5000u32.to_be_bytes());
        assert!(validate_image(&STANDARD.encode(large), "image/png").is_err());
    }

    #[tokio::test]
    async fn live_fixture_requires_modern_metadata_and_returns_json_and_open_sse() {
        use axum::{
            Json, Router,
            http::HeaderMap,
            response::{IntoResponse, Sse, sse::Event},
            routing::post,
        };
        use futures_util::StreamExt;
        use std::convert::Infallible;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handler = |headers: HeaderMap, Json(body): Json<Value>| async move {
            // An independent wire fixture: literal values and schema are intentionally not
            // derived from McpClient constants or its request construction code.
            let request_schema = json!({
                "type":"object", "required":["jsonrpc","id","method","params"],
                "properties":{
                    "jsonrpc":{"const":"2.0"}, "id":{"type":"string","minLength":1},
                    "method":{"enum":["server/discover","tools/list","tools/call"]},
                    "params":{"type":"object","required":["_meta"],"properties":{
                        "_meta":{"type":"object","required":["io.modelcontextprotocol/protocolVersion","io.modelcontextprotocol/clientCapabilities"],"properties":{
                            "io.modelcontextprotocol/protocolVersion":{"const":"2026-07-28"},
                            "io.modelcontextprotocol/clientCapabilities":{"const":{}}
                        }}
                    }}
                }
            });
            assert!(
                jsonschema::validator_for(&request_schema)
                    .unwrap()
                    .is_valid(&body)
            );
            assert_eq!(headers["mcp-protocol-version"], "2026-07-28");
            assert_eq!(
                headers["mcp-method"].to_str().unwrap(),
                body["method"].as_str().unwrap()
            );
            assert_eq!(
                body["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                "2026-07-28"
            );
            assert_eq!(
                body["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"],
                json!({})
            );
            assert!(!headers.contains_key("mcp-session-id"));
            let id = body["id"].clone();
            match body["method"].as_str().unwrap() {
                "server/discover" => Json(json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"ttlMs":0,"cacheScope":"private"}})).into_response(),
                "tools/list" => Json(json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","tools":[{"name":"weather.lookup","inputSchema":{"type":"object","properties":{"city":{"type":"string","x-mcp-header":"City"}},"required":["city"]},"outputSchema":{"type":"array","items":{"type":"string"}}}],"ttlMs":0,"cacheScope":"private"}})).into_response(),
                "tools/call" => {
                    assert_eq!(headers["mcp-name"], "weather.lookup");
                    assert_eq!(headers["mcp-param-city"], "=?base64?5p2t5bee?=");
                    let event = Event::default().data(json!({"jsonrpc":"2.0","id":id,"result":{"resultType":"complete","content":[{"type":"text","text":"cloudy"}],"structuredContent":["cloudy"]}}).to_string());
                    Sse::new(futures_util::stream::once(async move { Ok::<_, Infallible>(event) }).chain(futures_util::stream::pending())).into_response()
                }
                _ => panic!("Unexpected old or invented method"),
            }
        };
        let app = Router::new().route("/mcp", post(handler));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = McpClient::new(SafeHttp::test_fixture(Url::parse(&origin).unwrap()).unwrap());
        let endpoint = format!("{origin}/mcp");
        let tools = client.tools(&endpoint, None).await.unwrap();
        assert_eq!(tools.len(), 1);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.call_tool(&endpoint, &tools[0], &json!({"city":"杭州"}), None),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result["structuredContent"], json!(["cloudy"]));
        server.abort();
    }
}
