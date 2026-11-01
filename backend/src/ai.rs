//! Authenticated streaming through a fixed DeepSeek endpoint. Plugin tools are proposals only;
//! a separate explicit confirmation executes them. Each response body owns its request.
mod app_turn;
mod plugin_turn;
use app_turn::AppContext;
use plugin_turn::{PluginTurn, ProposedCall};
use std::{
    collections::HashMap,
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::State,
    http::{HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
};
use futures_util::{Stream, StreamExt};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::{Instant as Deadline, timeout_at};
use uuid::Uuid;

use crate::{
    AppState,
    error::{ApiError, ApiResult},
    identity::Authenticated,
    validation::ApiJson,
};

const ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const MAX_MESSAGES: usize = 40;
const MAX_MESSAGE_CHARS: usize = 12_000;
const MAX_TOTAL_CHARS: usize = 24_000;
const MAX_FRAME_BYTES: usize = 256 * 1024;
// JSON escapes use at most six bytes per input byte. 8 KiB leaves ample SSE framing
// headroom below the client's 64 KiB public frame limit, even for control characters.
const MAX_DELTA_TEXT_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_UPSTREAM_BYTES: usize = 8 * 1024 * 1024;
const SYSTEM_PROMPT: &str = "You are Q, a helpful assistant. Answer clearly in the user's language. Be honest about uncertainty and do not claim to have performed actions or accessed data you have not accessed.";
type EventStream = Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
pub enum ChatModel {
    #[serde(rename = "deepseek-flash")]
    Flash,
    #[serde(rename = "deepseek-v4-pro")]
    Pro,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    pub model: ChatModel,
    pub thinking: bool,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub plugin_connection_id: Option<Uuid>,
    #[serde(default)]
    pub tool_invocation_ids: Vec<Uuid>,
    #[serde(default)]
    pub automatic_readonly_tools: bool,
    #[serde(default, deserialize_with = "app_turn::deserialize_version")]
    pub app_tools_version: Option<u8>,
    #[serde(default)]
    pub app_context: Vec<AppContext>,
    #[serde(default)]
    pub app_final_only: bool,
}

impl ChatRequest {
    fn validate(&self) -> ApiResult<()> {
        app_turn::validate(self)?;
        if self.tool_invocation_ids.len() > 8
            || self
                .tool_invocation_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != self.tool_invocation_ids.len()
            || (self.plugin_connection_id.is_none() && !self.tool_invocation_ids.is_empty())
            || (self.plugin_connection_id.is_some() && self.thinking)
            || (self.automatic_readonly_tools && self.plugin_connection_id.is_none())
        {
            return Err(ApiError::validation(
                "Plugin mode requires thinking disabled and at most eight distinct saved invocation IDs.",
            ));
        }
        if self.messages.is_empty() || self.messages.len() > MAX_MESSAGES {
            return Err(ApiError::validation("Send between 1 and 40 messages."));
        }
        let mut total = 0;
        for message in &self.messages {
            let count = message.content.chars().count();
            if message.content.trim().is_empty()
                || message.content.contains('\0')
                || count > MAX_MESSAGE_CHARS
            {
                return Err(ApiError::validation(
                    "Each message must contain nonempty text of at most 12000 Unicode characters.",
                ));
            }
            total += count;
        }
        if total > MAX_TOTAL_CHARS {
            return Err(ApiError::validation(
                "Messages must not exceed 24000 Unicode characters in total.",
            ));
        }
        if self
            .messages
            .last()
            .is_none_or(|message| message.role != Role::User)
        {
            return Err(ApiError::validation(
                "The final message must be from the user.",
            ));
        }
        Ok(())
    }
    fn provider_body(&self) -> Value {
        let mut messages = vec![json!({"role":"system","content":SYSTEM_PROMPT})];
        messages.extend(self.messages.iter().map(|message| json!(message)));
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
            "stream_options": {"include_usage":true},
            "thinking": {"type": if self.thinking { "enabled" } else { "disabled" }},
            "max_tokens": if self.thinking { 8192 } else { 4096 },
        });
        if self.thinking {
            body["reasoning_effort"] = json!("high");
        }
        if self.app_tools_version == Some(app_turn::VERSION) {
            app_turn::augment(&mut body, &self.app_context, self.app_final_only);
        }
        body
    }
}

#[derive(Serialize)]
pub struct ModelInfo {
    id: ChatModel,
    name: &'static str,
}
#[derive(Serialize)]
pub struct AiStatus {
    configured: bool,
    automatic_readonly_tools: bool,
    app_tools_version: u8,
    models: [ModelInfo; 2],
}
pub async fn status(State(state): State<AppState>) -> Json<AiStatus> {
    Json(AiStatus {
        configured: state.ai.is_some(),
        automatic_readonly_tools: true,
        app_tools_version: app_turn::VERSION,
        models: [
            ModelInfo {
                id: ChatModel::Flash,
                name: "DeepSeek Flash",
            },
            ModelInfo {
                id: ChatModel::Pro,
                name: "DeepSeek Pro",
            },
        ],
    })
}

pub struct AiRuntime {
    client: Client,
    authorization: HeaderValue,
    endpoint: Url,
    admissions: Arc<Mutex<Admissions>>,
    total_timeout: Duration,
    idle_timeout: Duration,
}

impl AiRuntime {
    /// Call only from main. AppState::new and tests never load provider credentials.
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let key = match std::env::var("DEEPSEEK_API_KEY") {
            Ok(key) => key,
            Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(_) => return Err("DEEPSEEK_API_KEY must be valid text"),
        };
        if key.trim().is_empty() {
            return Ok(None);
        }
        Self::build(
            &key,
            Url::parse(ENDPOINT).expect("fixed URL"),
            false,
            Duration::from_secs(180),
            Duration::from_secs(60),
        )
        .map(Some)
    }
    fn build(
        key: &str,
        endpoint: Url,
        fixture: bool,
        total_timeout: Duration,
        idle_timeout: Duration,
    ) -> Result<Self, &'static str> {
        if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_whitespace) {
            return Err("Invalid DeepSeek credential configuration");
        }
        let mut authorization = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "Invalid DeepSeek credential configuration")?;
        authorization.set_sensitive(true);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .https_only(!fixture)
            .connect_timeout(Duration::from_secs(10))
            .timeout(total_timeout)
            .build()
            .map_err(|_| "Could not initialize AI HTTP client")?;
        Ok(Self {
            client,
            authorization,
            endpoint,
            admissions: Arc::new(Mutex::new(Admissions::default())),
            total_timeout,
            idle_timeout,
        })
    }
    /// Explicit opt-in fixture path: literal loopback only, no environment secret or DNS.
    #[cfg(any(test, feature = "ai-test-fixtures"))]
    pub fn test_fixture(
        endpoint: Url,
        total_timeout: Duration,
        idle_timeout: Duration,
    ) -> Result<Self, &'static str> {
        let loopback = endpoint
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback());
        if endpoint.scheme() != "http"
            || !loopback
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("AI fixture must use a literal loopback HTTP address");
        }
        Self::build(
            "q-ai-test-fixture-only",
            endpoint,
            true,
            total_timeout,
            idle_timeout,
        )
    }
    fn reserve(&self, user_id: Uuid) -> ApiResult<Admission> {
        let mut admissions = self.admissions.lock().map_err(|_| ApiError::internal())?;
        admissions.reserve(user_id, Instant::now())?;
        Ok(Admission {
            state: self.admissions.clone(),
            user_id,
        })
    }
    fn response(
        self: Arc<Self>,
        request: ChatRequest,
        permit: Admission,
        plugin: Option<PluginTurn>,
    ) -> Response {
        let deadline = Deadline::now() + self.total_timeout;
        let model = request.model;
        let thinking = request.thinking;
        let app_tools = request.app_tools_version == Some(app_turn::VERSION)
            && !request.app_final_only
            && request.app_context.len() < app_turn::MAX_CONTEXT;
        let mut body = request.provider_body();
        if let Some(plugin) = &plugin {
            plugin.augment(&mut body);
        }
        let stream: EventStream = Box::pin(async_stream::stream! {
            // No spawned task: dropping the HTTP body drops this future, upstream and permit.
            let permit = permit;
            let mut upstream = None;
            let mut terminal = Err(StreamFailure::Upstream);
            let mut proposed = None;
            let result = timeout_at(deadline, self.client.post(self.endpoint.clone())
                .header(header::AUTHORIZATION, self.authorization.clone())
                .header(header::ACCEPT, "text/event-stream")
                .json(&body).send()).await;
            match result {
                Err(_) => terminal = Err(StreamFailure::Timeout),
                Ok(Err(error)) => terminal = Err(if error.is_timeout() { StreamFailure::Timeout } else { StreamFailure::Upstream }),
                Ok(Ok(response)) if !response.status().is_success() => terminal = Err(StreamFailure::from_status(response.status())),
                Ok(Ok(response)) => {
                    let event_stream = response.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).is_some_and(|value| value.split(';').next().is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream")));
                    if event_stream { upstream = Some(response.bytes_stream()); }
                }
            }
            if let Some(bytes) = upstream.as_mut() {
                let mut decoder = SseDecoder::default();
                let mut parser = CompletionParser { allow_tools: plugin.is_some() || app_tools, ..CompletionParser::default() };
                let mut phase = if thinking { "thinking" } else { "responding" };
                let mut input_bytes = 0usize;
                yield Ok(event("status", json!({"phase":phase})));
                'receive: loop {
                    let next_deadline = deadline.min(Deadline::now() + self.idle_timeout);
                    let next = timeout_at(next_deadline, bytes.next()).await;
                    let chunk = match next {
                        Err(_) => { terminal = Err(StreamFailure::Timeout); break; }
                        Ok(None) => { terminal = Err(StreamFailure::Upstream); break; }
                        Ok(Some(Err(error))) => { terminal = Err(if error.is_timeout() { StreamFailure::Timeout } else { StreamFailure::Upstream }); break; }
                        Ok(Some(Ok(chunk))) => chunk,
                    };
                    input_bytes = input_bytes.saturating_add(chunk.len());
                    if input_bytes > MAX_UPSTREAM_BYTES { terminal = Err(StreamFailure::Upstream); break; }
                    let frames = match decoder.feed(&chunk) {
                        Ok(frames) => frames,
                        Err(error) => { terminal = Err(error); break; }
                    };
                    for frame in frames {
                        if frame.trim().is_empty() { continue; }
                        if frame.trim() == "[DONE]" {
                            proposed = parser.tool_call.clone();
                            terminal = parser.finish();
                            break 'receive;
                        }
                        let update = match parser.accept(&frame) {
                            Ok(update) => update,
                            Err(error) => { terminal = Err(error); break 'receive; }
                        };
                        if let Some(text) = update.text {
                            if phase != "responding" {
                                phase = "responding";
                                yield Ok(event("status", json!({"phase":phase})));
                            }
                            for part in delta_chunks(&text) {
                                yield Ok(event("delta", json!({"text":part})));
                            }
                        }
                    }
                }
            }
            // Release the provider socket and admission before yielding the terminal event.
            drop(upstream);
            match terminal {
                Ok((finish_reason, usage)) => {
                    if finish_reason == "tool_calls" {
                        let Some(call) = proposed.as_ref() else {
                            yield Ok(event("error", json!({"code":"AI_UPSTREAM_ERROR","message":"The model returned an invalid tool proposal."}))); return;
                        };
                        if let Some(plugin) = plugin.as_ref() {
                            match timeout_at(deadline, plugin.propose(call)).await {
                                Ok(Ok(proposal)) => yield Ok(event("tool_proposal", proposal)),
                                Ok(Err(error)) => { yield Ok(event("error", json!({"code":error.code,"message":error.message}))); return; }
                                Err(_) => { yield Ok(event("error", json!({"code":"AI_TIMEOUT","message":"Tool proposal preparation timed out."}))); return; }
                            }
                        } else if app_tools {
                            match app_turn::proposal(call) {
                                Ok(proposal) => yield Ok(event("app_tool", proposal)),
                                Err(error) => { yield Ok(event("error", json!({"code":error.code(),"message":error.message()}))); return; }
                            }
                        } else {
                            yield Ok(event("error", json!({"code":"AI_UPSTREAM_ERROR","message":"Unexpected tool proposal."}))); return;
                        }
                    }
                    drop(permit);
                    let mut data = json!({"model":model,"finish_reason":finish_reason});
                    if let Some(usage) = usage { data["usage"] = json!(usage); }
                    yield Ok(event("done", data));
                }
                Err(error) => yield Ok(event("error", json!({"code":error.code(),"message":error.message()}))),
            }
        });
        let mut response = Sse::new(stream)
            .keep_alive(
                KeepAlive::new()
                    .interval(Duration::from_secs(15))
                    .text("keep-alive"),
            )
            .into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
            .headers_mut()
            .insert("x-accel-buffering", HeaderValue::from_static("no"));
        response
    }
}

pub async fn chat(
    State(state): State<AppState>,
    auth: Authenticated,
    ApiJson(request): ApiJson<ChatRequest>,
) -> ApiResult<Response> {
    request.validate()?;
    let runtime = state.ai.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "AI_NOT_CONFIGURED",
            "AI is not configured on this server.",
        )
    })?;
    let permit = runtime.reserve(auth.user_id)?;
    let plugin = PluginTurn::load(&state, auth.user_id, &request).await?;
    Ok(runtime.response(request, permit, plugin))
}

#[derive(Default)]
struct Admissions {
    users: HashMap<Uuid, UserWindow>,
    active: usize,
}
struct UserWindow {
    started: Instant,
    requests: u8,
    active: bool,
}
impl Admissions {
    fn reserve(&mut self, user_id: Uuid, now: Instant) -> ApiResult<()> {
        let window = Duration::from_secs(60);
        self.users
            .retain(|_, user| user.active || now.duration_since(user.started) < window);
        if self.users.get(&user_id).is_some_and(|user| user.active) || self.active >= 4 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "AI_BUSY",
                "An AI request is already active or the server is busy.",
            ));
        }
        if self.users.len() >= 10_000 && !self.users.contains_key(&user_id) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "AI_BUSY",
                "AI capacity is temporarily unavailable.",
            ));
        }
        let user = self.users.entry(user_id).or_insert(UserWindow {
            started: now,
            requests: 0,
            active: false,
        });
        if now.duration_since(user.started) >= window {
            user.started = now;
            user.requests = 0;
        }
        if user.requests >= 10 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "AI_RATE_LIMITED",
                "Too many AI requests. Please try again later.",
            ));
        }
        user.requests += 1;
        user.active = true;
        self.active += 1;
        Ok(())
    }
}
struct Admission {
    state: Arc<Mutex<Admissions>>,
    user_id: Uuid,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(user) = state.users.get_mut(&self.user_id) {
                user.active = false;
            }
            state.active = state.active.saturating_sub(1);
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum StreamFailure {
    Auth,
    Quota,
    Upstream,
    Timeout,
}
impl StreamFailure {
    fn from_status(status: StatusCode) -> Self {
        match status.as_u16() {
            401 | 403 => Self::Auth,
            402 => Self::Quota,
            408 | 504 => Self::Timeout,
            _ => Self::Upstream,
        }
    }
    fn code(self) -> &'static str {
        match self {
            Self::Auth => "AI_AUTH_ERROR",
            Self::Quota => "AI_QUOTA_EXCEEDED",
            Self::Upstream => "AI_UPSTREAM_ERROR",
            Self::Timeout => "AI_TIMEOUT",
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::Auth => "The AI provider could not authenticate this server.",
            Self::Quota => "The AI provider quota is unavailable.",
            Self::Upstream => {
                "The AI response could not be completed. No automatic retry was made."
            }
            Self::Timeout => "The AI request timed out. No automatic retry was made.",
        }
    }
}

fn event(name: &'static str, data: Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

fn delta_chunks(mut text: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        if text.is_empty() {
            return None;
        }
        let mut end = text.len().min(MAX_DELTA_TEXT_BYTES);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, remaining) = text.split_at(end);
        text = remaining;
        Some(chunk)
    })
}

#[derive(Default)]
struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    frame_bytes: usize,
}
impl SseDecoder {
    fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>, StreamFailure> {
        let mut frames = Vec::new();
        for byte in chunk {
            self.frame_bytes += 1;
            if self.frame_bytes > MAX_FRAME_BYTES {
                return Err(StreamFailure::Upstream);
            }
            if *byte != b'\n' {
                self.line.push(*byte);
                continue;
            }
            if self.line.last() == Some(&b'\r') {
                self.line.pop();
            }
            if self.line.is_empty() {
                if !self.data.is_empty() {
                    self.data.pop();
                    frames.push(
                        String::from_utf8(std::mem::take(&mut self.data))
                            .map_err(|_| StreamFailure::Upstream)?,
                    );
                }
                self.frame_bytes = 0;
            } else if let Some(data) = self.line.strip_prefix(b"data:") {
                self.data
                    .extend_from_slice(data.strip_prefix(b" ").unwrap_or(data));
                self.data.push(b'\n');
            }
            self.line.clear();
        }
        Ok(frames)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}
#[derive(Default)]
struct CompletionParser {
    output_bytes: usize,
    has_answer: bool,
    finish_reason: Option<String>,
    usage: Option<Usage>,
    allow_tools: bool,
    tool_call: Option<ProposedCall>,
}
struct Update {
    text: Option<String>,
}
impl CompletionParser {
    fn accept(&mut self, frame: &str) -> Result<Update, StreamFailure> {
        let value: Value = serde_json::from_str(frame).map_err(|_| StreamFailure::Upstream)?;
        if !value.is_object() || value.get("error").is_some() {
            return Err(StreamFailure::Upstream);
        }
        if let Some(usage) = value.get("usage").filter(|value| !value.is_null()) {
            self.usage =
                Some(serde_json::from_value(usage.clone()).map_err(|_| StreamFailure::Upstream)?);
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or(StreamFailure::Upstream)?;
        // Tolerate a usage-only compatibility chunk, though the current provider uses one choice.
        if choices.is_empty() && self.usage.is_some() {
            return Ok(Update { text: None });
        }
        if choices.len() != 1 {
            return Err(StreamFailure::Upstream);
        }
        let choice = &choices[0];
        if choice
            .get("index")
            .is_some_and(|value| value.as_u64() != Some(0))
        {
            return Err(StreamFailure::Upstream);
        }
        let delta = choice
            .get("delta")
            .and_then(Value::as_object)
            .ok_or(StreamFailure::Upstream)?;
        if let Some(calls) = delta.get("tool_calls").filter(|value| !value.is_null()) {
            let calls = calls.as_array().ok_or(StreamFailure::Upstream)?;
            if !calls.is_empty() {
                if !self.allow_tools || calls.len() != 1 || self.finish_reason.is_some() {
                    return Err(StreamFailure::Upstream);
                }
                self.tool_call
                    .get_or_insert_with(ProposedCall::default)
                    .append(&calls[0])?;
            }
        }
        if delta
            .get("role")
            .is_some_and(|value| !value.is_null() && value.as_str() != Some("assistant"))
        {
            return Err(StreamFailure::Upstream);
        }
        let content = delta
            .get("content")
            .filter(|value| !value.is_null())
            .map(|value| value.as_str().ok_or(StreamFailure::Upstream))
            .transpose()?;
        let _reasoning = delta
            .get("reasoning_content")
            .filter(|value| !value.is_null())
            .map(|value| value.as_str().ok_or(StreamFailure::Upstream))
            .transpose()?;
        if self.finish_reason.is_some() && content.is_some_and(|text| !text.is_empty()) {
            return Err(StreamFailure::Upstream);
        }
        let text = content.filter(|text| !text.is_empty()).map(str::to_owned);
        if let Some(text) = &text {
            self.output_bytes = self.output_bytes.saturating_add(text.len());
            if self.output_bytes > MAX_OUTPUT_BYTES {
                return Err(StreamFailure::Upstream);
            }
            self.has_answer |= !text.trim().is_empty();
        }
        if let Some(reason) = choice.get("finish_reason").filter(|value| !value.is_null()) {
            let reason = reason.as_str().ok_or(StreamFailure::Upstream)?;
            if !["stop", "length", "content_filter"].contains(&reason)
                && !(self.allow_tools && reason == "tool_calls")
            {
                return Err(StreamFailure::Upstream);
            }
            if self
                .finish_reason
                .as_deref()
                .is_some_and(|prior| prior != reason)
            {
                return Err(StreamFailure::Upstream);
            }
            self.finish_reason = Some(reason.to_owned());
        }
        Ok(Update { text })
    }
    fn finish(self) -> Result<(String, Option<Usage>), StreamFailure> {
        if self.finish_reason.as_deref() == Some("tool_calls") {
            if !self.allow_tools || self.tool_call.as_ref().is_none_or(|call| !call.valid()) {
                return Err(StreamFailure::Upstream);
            }
        } else if !self.has_answer || self.tool_call.is_some() {
            return Err(StreamFailure::Upstream);
        }
        Ok((
            self.finish_reason.ok_or(StreamFailure::Upstream)?,
            self.usage,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::HeaderMap,
        routing::post,
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn request() -> ChatRequest {
        ChatRequest {
            model: ChatModel::Flash,
            thinking: false,
            plugin_connection_id: None,
            tool_invocation_ids: Vec::new(),
            automatic_readonly_tools: false,
            app_tools_version: None,
            app_context: Vec::new(),
            app_final_only: false,
            messages: vec![ChatMessage {
                role: Role::User,
                content: "Hello".into(),
            }],
        }
    }
    #[test]
    fn automatic_readonly_requires_plugin_and_is_backwards_compatible() {
        let mut request = request();
        assert!(request.validate().is_ok());
        request.automatic_readonly_tools = true;
        assert!(request.validate().is_err());
        request.plugin_connection_id = Some(Uuid::new_v4());
        assert!(request.validate().is_ok());
        request.thinking = true;
        assert!(request.validate().is_err());
    }
    #[test]
    fn application_mode_and_context_fail_closed_before_provider() {
        let context = || json!({"name":"app_info","arguments":{"module":"insurance"},"result":"Public catalogue"});
        for fields in [
            json!({"app_tools_version":2}),
            json!({"app_tools_version":null}),
            json!({"app_context":[context()]}),
            json!({"app_final_only":true}),
            json!({"app_tools_version":1,"app_final_only":true}),
            json!({"app_tools_version":1,"thinking":true}),
            json!({"app_tools_version":1,"plugin_connection_id":Uuid::new_v4()}),
            json!({"app_tools_version":1,"automatic_readonly_tools":true}),
            json!({"app_tools_version":1,"tool_invocation_ids":[Uuid::new_v4()]}),
            json!({"app_tools_version":1,"app_context":[context(),context(),context(),context()]}),
            json!({"app_tools_version":1,"app_context":[{"name":"app_info","arguments":{"module":"insurance"},"result":"bad\u{0001}"}]}),
            json!({"app_tools_version":1,"app_context":[{"name":"app_info","arguments":{"module":"insurance"},"result":"🙂".repeat(10001)}]}),
            json!({"app_tools_version":1,"app_context":[{"name":"app_info","arguments":{"module":"insurance"},"result":"x","trusted":true}]}),
            json!({"app_tools_version":1,"app_context":[{"name":"bank_transfer","arguments":{},"result":"succeeded"}]}),
        ] {
            let mut body = json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"insurance"}]});
            body.as_object_mut()
                .unwrap()
                .extend(fields.as_object().unwrap().clone());
            assert!(
                serde_json::from_value::<ChatRequest>(body).map_or(true, |r| r.validate().is_err())
            );
        }
        let mut input = request();
        input.app_tools_version = Some(1);
        input.app_context = vec![app_turn::AppContext {
            name: "app_info".into(),
            arguments: json!({"module":"all"}),
            result: "🙂".repeat(10_000),
        }];
        assert!(input.validate().is_ok());
        input
            .app_context
            .extend((0..2).map(|_| app_turn::AppContext {
                name: "app_info".into(),
                arguments: json!({"module":"all"}),
                result: "x".repeat(7001),
            }));
        assert!(input.validate().is_err());
    }

    fn chunk(delta: Value, finish: Value) -> String {
        format!(
            "data: {}\r\n\r\n",
            json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}],"usage":null})
        )
    }
    fn decode_public(bytes: &[u8]) -> Vec<(String, Value)> {
        String::from_utf8_lossy(bytes)
            .split("\n\n")
            .filter_map(|part| {
                let name = part.lines().find_map(|line| line.strip_prefix("event: "))?;
                let data = part.lines().find_map(|line| line.strip_prefix("data: "))?;
                Some((name.to_owned(), serde_json::from_str(data).unwrap()))
            })
            .collect()
    }

    #[tokio::test]
    async fn public_delta_frames_preserve_unicode_and_escaped_text_below_client_limit() {
        for answer in [
            "a".repeat(70_000),
            "a🙂你好🚀".repeat(12_000),
            "\0\u{0001}\u{001f}\n\r\t\"\\".repeat(12_000),
        ] {
            let pieces: Vec<_> = delta_chunks(&answer).collect();
            assert!(
                pieces
                    .iter()
                    .all(|piece| !piece.is_empty() && piece.len() <= MAX_DELTA_TEXT_BYTES)
            );
            assert_eq!(pieces.concat(), answer);
            let events = pieces
                .into_iter()
                .map(|text| Ok::<_, Infallible>(event("delta", json!({"text":text}))))
                .collect::<Vec<_>>();
            let response = Sse::new(futures_util::stream::iter(events)).into_response();
            let bytes = to_bytes(response.into_body(), 2 * MAX_OUTPUT_BYTES)
                .await
                .unwrap();
            let wire = std::str::from_utf8(&bytes).unwrap();
            assert!(wire.split("\n\n").all(|frame| frame.len() + 2 < 64 * 1024));
            let rebuilt: String = decode_public(&bytes)
                .iter()
                .map(|(_, data)| data["text"].as_str().unwrap())
                .collect();
            assert_eq!(rebuilt, answer);
        }
    }

    #[test]
    fn input_rejects_unknown_roles_models_and_over_budget_unicode() {
        for body in [
            json!({"model":"deepseek-chat","thinking":false,"messages":[{"role":"user","content":"x"}]}),
            json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"system","content":"x"}]}),
            json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"x","reasoning_content":"x"}]}),
            json!({"model":"deepseek-flash","thinking":false,"messages":[{"role":"user","content":"x"}],"system":"x"}),
        ] {
            assert!(serde_json::from_value::<ChatRequest>(body).is_err());
        }
        let mut valid = request();
        valid.messages[0].content = "🙂".repeat(12_000);
        assert!(valid.validate().is_ok());
        valid.messages[0].content.push('好');
        assert!(valid.validate().is_err());
        valid.messages = (0..3)
            .map(|_| ChatMessage {
                role: Role::User,
                content: "中".repeat(8_001),
            })
            .collect();
        assert!(valid.validate().is_err());
        valid.messages = (0..41)
            .map(|_| ChatMessage {
                role: Role::User,
                content: "x".into(),
            })
            .collect();
        assert!(valid.validate().is_err());
        valid.messages = vec![ChatMessage {
            role: Role::Assistant,
            content: "x".into(),
        }];
        assert!(valid.validate().is_err());
    }

    #[test]
    fn outbound_payload_has_explicit_thinking_and_server_owned_limits() {
        let mut input = request();
        let ordinary = input.provider_body();
        assert_eq!(ordinary["thinking"]["type"], "disabled");
        assert_eq!(ordinary["max_tokens"], 4096);
        assert_eq!(ordinary["stream_options"]["include_usage"], true);
        assert_eq!(ordinary["messages"][0]["role"], "system");
        assert!(ordinary.get("tools").is_none());
        assert!(ordinary.get("user_id").is_none());
        input.thinking = true;
        let thinking = input.provider_body();
        assert_eq!(thinking["thinking"]["type"], "enabled");
        assert_eq!(thinking["max_tokens"], 8192);
        assert_eq!(thinking["reasoning_effort"], "high");
    }

    #[test]
    fn sse_decoder_handles_utf8_crlf_multiline_comments_and_frame_limits() {
        let payload =
            ": keep-alive\r\n\r\ndata: {\"answer\":\r\ndata: \"你好\"}\r\n\r\ndata: [DONE]\n\n";
        let mut decoder = SseDecoder::default();
        let mut frames = Vec::new();
        for byte in payload.as_bytes() {
            frames.extend(decoder.feed(&[*byte]).unwrap());
        }
        assert_eq!(frames, ["{\"answer\":\n\"你好\"}", "[DONE]"]);
        assert!(
            SseDecoder::default()
                .feed(&vec![b'x'; MAX_FRAME_BYTES + 1])
                .is_err()
        );
        assert!(SseDecoder::default().feed(b"data: \xff\n\n").is_err());
    }

    #[test]
    fn parsing_never_treats_reasoning_or_missing_finish_as_an_answer() {
        let mut parser = CompletionParser::default();
        let update = parser.accept(&json!({"choices":[{"delta":{"reasoning_content":"private thought","content":null},"finish_reason":"stop"}],"usage":null}).to_string()).unwrap();
        assert!(update.text.is_none());
        assert!(parser.finish().is_err());
        let mut parser = CompletionParser::default();
        parser
            .accept(
                &json!({"choices":[{"delta":{"content":"answer"},"finish_reason":null}]})
                    .to_string(),
            )
            .unwrap();
        assert!(parser.finish().is_err());
    }

    #[test]
    fn output_cap_and_finish_reason_are_enforced() {
        for reason in ["stop", "length", "content_filter"] {
            let mut parser = CompletionParser::default();
            parser.accept(&json!({"choices":[{"delta":{"content":"partial answer"},"finish_reason":reason}]}).to_string()).unwrap();
            assert_eq!(parser.finish().unwrap().0, reason);
        }
        for reason in [
            "tool_calls",
            "aborted",
            "insufficient_system_resource",
            "made-up",
        ] {
            assert!(CompletionParser::default().accept(&json!({"choices":[{"delta":{"content":"partial"},"finish_reason":reason}]}).to_string()).is_err());
        }
        let mut parser = CompletionParser::default();
        assert!(parser.accept(&json!({"choices":[{"delta":{"content":"x".repeat(MAX_OUTPUT_BYTES + 1)},"finish_reason":null}]}).to_string()).is_err());
    }

    #[test]
    fn admission_is_user_scoped_global_bounded_and_rate_limited() {
        let runtime = AiRuntime::test_fixture(
            "http://127.0.0.1:1/chat".parse().unwrap(),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .unwrap();
        let user = Uuid::new_v4();
        let first = runtime.reserve(user).unwrap();
        assert_eq!(runtime.reserve(user).err().unwrap().code, "AI_BUSY");
        let others: Vec<_> = (0..3)
            .map(|_| runtime.reserve(Uuid::new_v4()).unwrap())
            .collect();
        assert_eq!(
            runtime.reserve(Uuid::new_v4()).err().unwrap().code,
            "AI_BUSY"
        );
        drop(first);
        drop(others);
        for _ in 0..9 {
            drop(runtime.reserve(user).unwrap());
        }
        assert_eq!(runtime.reserve(user).err().unwrap().code, "AI_RATE_LIMITED");
        let mut isolated = Admissions::default();
        let now = Instant::now();
        for _ in 0..10 {
            isolated.reserve(user, now).unwrap();
            isolated.users.get_mut(&user).unwrap().active = false;
            isolated.active = 0;
        }
        assert!(
            isolated
                .reserve(user, now + Duration::from_secs(61))
                .is_ok()
        );
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    struct Stub {
        url: Url,
        calls: Arc<AtomicUsize>,
        dropped: Arc<AtomicBool>,
        payload: Arc<Mutex<Option<Value>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Stub {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Stub {
        async fn start(mode: &'static str) -> Self {
            let calls = Arc::new(AtomicUsize::new(0));
            let dropped = Arc::new(AtomicBool::new(false));
            let payload = Arc::new(Mutex::new(None));
            let (count, drop_marker, captured) = (calls.clone(), dropped.clone(), payload.clone());
            let router = Router::new().route("/chat", post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let (count, drop_marker, captured) = (count.clone(), drop_marker.clone(), captured.clone());
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers["authorization"], "Bearer q-ai-test-fixture-only");
                    *captured.lock().unwrap() = Some(body);
                    if mode == "auth" { return (StatusCode::UNAUTHORIZED, "UPSTREAM_SECRET_BODY").into_response(); }
                    if mode == "quota" { return (StatusCode::PAYMENT_REQUIRED, "UPSTREAM_SECRET_BODY").into_response(); }
                    if mode == "redirect" { return (StatusCode::TEMPORARY_REDIRECT, [("location", "/chat")]).into_response(); }
                    if mode == "slow" { tokio::time::sleep(Duration::from_secs(2)).await; }
                    if mode.starts_with("app_") {
                        let name = if mode == "app_unknown" { "q_bank_balance" } else { "q_app_info" };
                        let arguments = if mode == "app_arguments" { json!({"module":"insurance","url":"https://example.com"}) } else { json!({"module":"insurance"}) };
                        let mut call = json!({"index":0,"id":"fixture_call","type":"function","function":{"name":name,"arguments":arguments.to_string()}});
                        if mode == "app_no_id" { call.as_object_mut().unwrap().remove("id"); }
                        let mut calls = vec![call];
                        if mode == "app_parallel" { calls.push(json!({"index":1,"id":"second","type":"function","function":{"name":"q_app_info","arguments":"{\"module\":\"all\"}"}})); }
                        let wire = format!("{}{}data: [DONE]\n\n", chunk(json!({"tool_calls":calls}), Value::Null), chunk(json!({}), json!("tool_calls")));
                        return ([("content-type", "text/event-stream")], wire).into_response();
                    }

                    let mut text = String::from(": keep-alive\r\n\r\n");
                    text.push_str(&chunk(json!({"role":"assistant","content":null}), Value::Null));
                    text.push_str(&chunk(json!({"reasoning_content":"PRIVATE_REASONING_NOT_FOR_CLIENT"}), Value::Null));
                    if mode == "large_delta" { text.push_str(&chunk(json!({"content":"a".repeat(70_000)}), Value::Null)); }
                    else if mode != "reasoning_only" { text.push_str(&chunk(json!({"content":"你好\nAnswer"}), Value::Null)); }
                    if mode == "malformed" { text.push_str("data: invalid-json\n\n"); }
                    if mode == "oversized" { text.push_str(&"x".repeat(MAX_FRAME_BYTES + 1)); }
                    let reason = if mode == "length" { "length" } else if mode == "filtered" { "content_filter" } else { "stop" };
                    text.push_str(&format!("data: {}\n\n", json!({"choices":[{"index":0,"delta":{"content":null},"finish_reason":reason}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10,"prompt_cache_hit_tokens":0}})));
                    if mode != "eof" { text.push_str("data: [DONE]\n\n"); }
                    let body = if mode == "hold" {
                        Body::from_stream(async_stream::stream! {
                            let _marker = DropFlag(drop_marker);
                            yield Ok::<_, Infallible>(chunk(json!({"content":"started"}), Value::Null));
                            std::future::pending::<()>().await;
                        })
                    } else {
                        let pieces = text.into_bytes().chunks(7).map(|bytes| Ok::<_, Infallible>(bytes.to_vec())).collect::<Vec<_>>();
                        Body::from_stream(futures_util::stream::iter(pieces))
                    };
                    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/chat", listener.local_addr().unwrap())
                .parse()
                .unwrap();
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                url,
                calls,
                dropped,
                payload,
                task,
            }
        }
        fn runtime(&self, total: Duration, idle: Duration) -> Arc<AiRuntime> {
            Arc::new(AiRuntime::test_fixture(self.url.clone(), total, idle).unwrap())
        }
    }

    async fn collect(stub: &Stub, runtime: Arc<AiRuntime>) -> Vec<(String, Value)> {
        let permit = runtime.reserve(Uuid::new_v4()).unwrap();
        let response = runtime.clone().response(request(), permit, None);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = to_bytes(response.into_body(), 2 * MAX_OUTPUT_BYTES)
            .await
            .unwrap();
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
        let wire = String::from_utf8_lossy(&bytes);
        assert!(!wire.contains("PRIVATE_REASONING"));
        assert!(!wire.contains("UPSTREAM_SECRET_BODY"));
        assert!(!wire.contains("q-ai-test-fixture-only"));
        assert_eq!(runtime.admissions.lock().unwrap().active, 0);
        decode_public(&bytes)
    }

    #[tokio::test]
    async fn local_stub_streams_answer_usage_and_distinct_finish_reasons() {
        for (mode, reason) in [
            ("normal", "stop"),
            ("length", "length"),
            ("filtered", "content_filter"),
        ] {
            let stub = Stub::start(mode).await;
            let events = collect(
                &stub,
                stub.runtime(Duration::from_secs(3), Duration::from_secs(1)),
            )
            .await;
            assert!(
                events
                    .iter()
                    .any(|(kind, data)| kind == "delta" && data["text"] == "你好\nAnswer")
            );
            let (kind, done) = events.last().unwrap();
            assert_eq!(kind, "done");
            assert_eq!(done["finish_reason"], reason);
            assert!(
                events
                    .iter()
                    .filter(|(kind, _)| kind == "status")
                    .all(|(_, value)| value["phase"] == "responding")
            );
            assert_eq!(
                done["usage"],
                json!({"prompt_tokens":4,"completion_tokens":6,"total_tokens":10})
            );
            assert!(
                stub.payload.lock().unwrap().as_ref().unwrap()["messages"][0]["content"]
                    .as_str()
                    .unwrap()
                    .contains("You are Q")
            );
        }
    }

    #[tokio::test]
    async fn application_tools_emit_only_valid_opted_in_proposals_and_no_execution() {
        for (mode, version, exhausted, success) in [
            ("app_ok", Some(1), false, true),
            ("app_ok", None, false, false),
            ("app_ok", Some(1), true, false),
            ("app_unknown", Some(1), false, false),
            ("app_arguments", Some(1), false, false),
            ("app_no_id", Some(1), false, false),
            ("app_parallel", Some(1), false, false),
        ] {
            let stub = Stub::start(mode).await;
            let runtime = stub.runtime(Duration::from_secs(3), Duration::from_secs(1));
            let mut input = request();
            input.app_tools_version = version;
            if exhausted {
                input.app_context = (0..3)
                    .map(|_| app_turn::AppContext {
                        name: "app_info".into(),
                        arguments: json!({"module":"insurance"}),
                        result: "Prior public catalogue".into(),
                    })
                    .collect();
            }
            assert!(input.validate().is_ok());
            let response =
                runtime
                    .clone()
                    .response(input, runtime.reserve(Uuid::new_v4()).unwrap(), None);
            let events = decode_public(&to_bytes(response.into_body(), 1_000_000).await.unwrap());
            assert!(!events.iter().any(|(name, _)| name == "tool_proposal"));
            if success {
                let app = events
                    .iter()
                    .position(|(name, _)| name == "app_tool")
                    .unwrap();
                assert_eq!(
                    events[app].1,
                    json!({"name":"app_info","arguments":{"module":"insurance"}})
                );
                assert_eq!(events[app + 1].0, "done");
                assert_eq!(events[app + 1].1["finish_reason"], "tool_calls");
            } else {
                assert!(
                    events
                        .iter()
                        .all(|(name, _)| name != "app_tool" && name != "done")
                );
                assert_eq!(events.last().unwrap().1["code"], "AI_UPSTREAM_ERROR");
            }
            assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
            assert_eq!(runtime.admissions.lock().unwrap().active, 0);
            assert_eq!(
                stub.payload
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .get("tools")
                    .is_some(),
                version.is_some() && !exhausted
            );
        }
    }

    #[tokio::test]
    async fn one_large_provider_delta_is_split_into_complete_bounded_public_events() {
        let stub = Stub::start("large_delta").await;
        let runtime = stub.runtime(Duration::from_secs(3), Duration::from_secs(1));
        let response =
            runtime
                .clone()
                .response(request(), runtime.reserve(Uuid::new_v4()).unwrap(), None);
        let bytes = to_bytes(response.into_body(), 2 * MAX_OUTPUT_BYTES)
            .await
            .unwrap();
        let wire = std::str::from_utf8(&bytes).unwrap();
        assert!(wire.split("\n\n").all(|frame| frame.len() + 2 < 64 * 1024));
        let events = decode_public(&bytes);
        let deltas = events
            .iter()
            .filter(|(kind, _)| kind == "delta")
            .collect::<Vec<_>>();
        assert_eq!(deltas.len(), 9);
        let text: String = deltas
            .iter()
            .map(|(_, data)| data["text"].as_str().unwrap())
            .collect();
        assert_eq!(text, "a".repeat(70_000));
        assert_eq!(events.last().unwrap().0, "done");
        assert_eq!(events.last().unwrap().1["finish_reason"], "stop");
        assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
        assert_eq!(runtime.admissions.lock().unwrap().active, 0);
    }

    #[tokio::test]
    async fn provider_failures_eof_and_no_answer_never_emit_done_or_retry() {
        for (mode, expected) in [
            ("auth", "AI_AUTH_ERROR"),
            ("quota", "AI_QUOTA_EXCEEDED"),
            ("redirect", "AI_UPSTREAM_ERROR"),
            ("eof", "AI_UPSTREAM_ERROR"),
            ("reasoning_only", "AI_UPSTREAM_ERROR"),
            ("malformed", "AI_UPSTREAM_ERROR"),
            ("oversized", "AI_UPSTREAM_ERROR"),
        ] {
            let stub = Stub::start(mode).await;
            let events = collect(
                &stub,
                stub.runtime(Duration::from_secs(3), Duration::from_secs(1)),
            )
            .await;
            assert!(events.iter().all(|(kind, _)| kind != "done"));
            assert_eq!(events.last().unwrap().0, "error");
            assert_eq!(events.last().unwrap().1["code"], expected);
        }
    }

    #[tokio::test]
    async fn timeout_and_downstream_drop_release_all_admission_and_upstream_resources() {
        let slow = Stub::start("slow").await;
        let events = collect(
            &slow,
            slow.runtime(Duration::from_millis(50), Duration::from_millis(30)),
        )
        .await;
        assert_eq!(events.last().unwrap().1["code"], "AI_TIMEOUT");
        let idle = Stub::start("hold").await;
        let events = collect(
            &idle,
            idle.runtime(Duration::from_secs(2), Duration::from_millis(40)),
        )
        .await;
        assert_eq!(events.last().unwrap().1["code"], "AI_TIMEOUT");
        assert!(events.iter().all(|(kind, _)| kind != "done"));
        let hold = Stub::start("hold").await;
        let runtime = hold.runtime(Duration::from_secs(10), Duration::from_secs(5));
        let user = Uuid::new_v4();
        let response = runtime
            .clone()
            .response(request(), runtime.reserve(user).unwrap(), None);
        let mut body = response.into_body().into_data_stream();
        while let Some(Ok(bytes)) = body.next().await {
            if String::from_utf8_lossy(&bytes).contains("event: delta") {
                break;
            }
        }
        drop(body);
        assert_eq!(runtime.admissions.lock().unwrap().active, 0);
        drop(runtime.reserve(user).unwrap());
        tokio::time::timeout(Duration::from_secs(2), async {
            while !hold.dropped.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("dropping client body must close the upstream response");
    }

    #[tokio::test]
    async fn unpolled_response_drop_never_calls_provider_and_frees_the_user() {
        let stub = Stub::start("normal").await;
        let runtime = stub.runtime(Duration::from_secs(1), Duration::from_secs(1));
        let user = Uuid::new_v4();
        drop(
            runtime
                .clone()
                .response(request(), runtime.reserve(user).unwrap(), None),
        );
        assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
        assert_eq!(runtime.admissions.lock().unwrap().active, 0);
        drop(runtime.reserve(user).unwrap());
    }
}
