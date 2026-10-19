import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatError, decodeAiStatus, streamChat } from "./stream.ts";

const encoder = new TextEncoder();
const request = { model: "deepseek-flash", thinking: false, messages: [{ role: "user", content: "你好" }] };
const frame = (event, value, newline = "\n") => `event: ${event}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
const answer = (text = "你好") => frame("delta", { text });
const done = (extra = {}) => frame("done", { model: "deepseek-flash", finish_reason: "stop", ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pluginId='11111111-1111-4111-8111-111111111111';
const invocationId='22222222-2222-4222-8222-222222222222';
const proposal={invocation_id:invocationId,connection_id:pluginId,tool_name:'browse_photos',arguments:{limit:3}};

test('a plugin proposal can finish without text and carries only saved invocation IDs back', async () => {
  const fake=fixture([frame('tool_proposal',proposal),done({finish_reason:'tool_calls'})]);
  const events=[];
  await streamChat(options(fake.transport,{request:{...request,plugin_connection_id:pluginId,tool_invocation_ids:[invocationId],tool_result:'forged'},onEvent:event=>events.push(event)}));
  assert.equal(events[0].type,'tool_proposal');
  assert.equal(events[1].finish_reason,'tool_calls');
  const sent=JSON.parse(fake.stats.init.body);
  assert.deepEqual(sent.tool_invocation_ids,[invocationId]);
  assert.equal('tool_result' in sent,false);
});
test('tool streams are bound to the selected plugin and reject duplicate proposals', async () => {
  for(const [req,frames] of [
    [request,[frame('tool_proposal',proposal),done({finish_reason:'tool_calls'})]],
    [{...request,plugin_connection_id:invocationId},[frame('tool_proposal',proposal)]],
    [{...request,plugin_connection_id:pluginId},[frame('tool_proposal',proposal),frame('tool_proposal',proposal)]],
    [{...request,plugin_connection_id:pluginId},[frame('tool_proposal',proposal),done()]],
  ]) await expectCode(streamChat(options(fixture(frames).transport,{request:req})),'INVALID_RESPONSE');
});
test('plugin mode rejects thinking and unbound, duplicate or excessive invocation IDs before sending', async () => {
  for(const fields of [{plugin_connection_id:pluginId,thinking:true},{tool_invocation_ids:[invocationId]},{plugin_connection_id:pluginId,tool_invocation_ids:[invocationId,invocationId]},{plugin_connection_id:'bad'}]) {
    const fake=fixture([answer(),done()]);
    await expectCode(streamChat(options(fake.transport,{request:{...request,...fields}})),'VALIDATION_ERROR');
    assert.equal(fake.stats.calls,0);
  }
});

function fixture(chunks, { status = 200, contentType = "text/event-stream", open = false } = {}) {
  let index = 0;
  const stats = { calls: 0, cancels: 0, aborts: 0, url: "", init: null };
  const body = new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const value = chunks[index++];
        controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
      } else if (!open) controller.close();
    },
    cancel() { stats.cancels++; },
  });
  const transport = async (url, init) => {
    stats.calls++; stats.url = url; stats.init = init;
    init.signal.addEventListener("abort", () => stats.aborts++);
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  };
  return { stats, transport, body };
}
function options(transport, overrides = {}) {
  return { baseUrl: "http://127.0.0.1:8787", token: "q_test-token", request, onEvent() {}, transport, totalTimeoutMs: 1000, idleTimeoutMs: 1000, ...overrides };
}
async function expectCode(promise, code, status) {
  await assert.rejects(promise, error => error instanceof ChatError && error.code === code && (status === undefined || error.status === status));
}

test("UTF-8, CRLF and multi-data lines survive one-byte chunks; final usage is preserved", async () => {
  const stream = "\uFEFF: keep-alive\r\n\r\n" + frame("status", { phase: "thinking", reasoning_content: "not forwarded" }, "\r\n") +
    "event: delta\r\ndata: {\"text\":\r\ndata: \"你好🌊\"}\r\n\r\n" +
    done({ usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, extra: "ignored" } });
  const fake = fixture(Array.from(encoder.encode(stream), byte => Uint8Array.of(byte)));
  const events = [];
  await streamChat(options(fake.transport, { onEvent: event => events.push(event) }));
  assert.deepEqual(events, [
    { type: "status", phase: "thinking" },
    { type: "delta", text: "你好🌊" },
    { type: "done", model: "deepseek-flash", finish_reason: "stop", usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } },
  ]);
  assert.equal(fake.stats.calls, 1);
});

test("Bearer stays in a header; request is sanitized and redirects/retries are disabled", async () => {
  const fake = fixture([answer(), done()], { open: true });
  const secret = "q_FAKE_PRIVATE_TOKEN";
  await streamChat(options(fake.transport, { baseUrl: "https://api.example.test/root/", token: secret, request: { ...request, unwanted: "drop", messages: [{ ...request.messages[0], reasoning_content: "drop" }] } }));
  assert.equal(fake.stats.url, "https://api.example.test/root/v1/ai/chat");
  assert.equal(fake.stats.url.includes(secret), false);
  assert.equal(fake.stats.init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(fake.stats.init.redirect, "error");
  assert.equal(fake.stats.init.credentials, "omit");
  assert.equal(fake.stats.init.cache, "no-store");
  assert.deepEqual(JSON.parse(fake.stats.init.body), request);
  assert.equal(fake.stats.calls, 1);
  assert.equal(fake.stats.cancels, 1);
  assert.equal(fake.body.locked, false);
});

test("known local models and display names are decoded without extra fields", () => {
  assert.deepEqual(decodeAiStatus({ configured: false, models: [{ id: "deepseek-flash", name: "DeepSeek Flash", token: "drop" }], secret: "drop" }), { configured: false, models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }] });
  for (const payload of [null, { configured: "yes", models: [] }, { configured: true, models: [{ id: "deepseek-chat", name: "Legacy" }] }, { configured: true, models: [{ id: "deepseek-flash", name: "" }] }, { configured: true, models: [{ id: "deepseek-flash", name: "A" }, { id: "deepseek-flash", name: "B" }] }]) {
    assert.throws(() => decodeAiStatus(payload), error => error.code === "INVALID_RESPONSE");
  }
});

test("insecure destinations, URL credentials, and invalid requests never call transport", async () => {
  let calls = 0;
  const transport = async () => { calls++; throw new Error("must not call"); };
  for (const baseUrl of ["http://example.com", "http://192.168.1.10:8787", "https://name:password@example.com", "https://example.com?token=secret", "https://example.com#token", "file:///tmp", "not a url"]) await expectCode(streamChat(options(transport, { baseUrl })), "INSECURE_API_URL");
  const invalid = [
    { ...request, model: "deepseek-chat" }, { ...request, thinking: "enabled" }, { ...request, messages: [] },
    { ...request, messages: [{ role: "assistant", content: "answer" }] }, { ...request, messages: [{ role: "system", content: "prompt" }] },
    { ...request, messages: [{ role: "user", content: " \n " }] }, { ...request, messages: [{ role: "user", content: "x".repeat(12001) }] },
    { ...request, messages: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) },
    { ...request, messages: [{ role: "user", content: "x".repeat(12000) }, { role: "assistant", content: "y".repeat(12000) }, { role: "user", content: "z" }] },
  ];
  for (const value of invalid) await expectCode(streamChat(options(transport, { request: value })), "VALIDATION_ERROR");
  await expectCode(streamChat(options(transport, { token: "bad\r\nInjected: value" })), "UNAUTHORIZED");
  assert.equal(calls, 0);
});

test("loopback aliases work and Unicode limits count characters, not UTF-16 units", async () => {
  for (const baseUrl of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "http://10.0.2.2:8787"]) {
    const fake = fixture([answer(), done()]);
    await streamChat(options(fake.transport, { baseUrl, request: { ...request, messages: [{ role: "user", content: "🌊".repeat(12000) }] } }));
    assert.equal(JSON.parse(fake.stats.init.body).messages[0].content, "🌊".repeat(12000));
  }
});

test("provider errors terminate an HTTP 200 stream without done or raw messages", async () => {
  for (const code of ["AI_AUTH_ERROR", "AI_QUOTA_EXCEEDED", "AI_UPSTREAM_ERROR", "AI_TIMEOUT", "NOT_A_SAFE_CODE"]) {
    const fake = fixture([answer("partial"), frame("error", { code, message: "sk_fake_sensitive_supplier_details" }), done()], { open: true });
    const events = [];
    await assert.rejects(streamChat(options(fake.transport, { onEvent: event => events.push(event) })), error => {
      assert.equal(error.code, code === "NOT_A_SAFE_CODE" ? "AI_UPSTREAM_ERROR" : code);
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    });
    assert.deepEqual(events, [{ type: "delta", text: "partial" }]);
    assert.equal(fake.stats.calls, 1);
    assert.equal(fake.stats.cancels, 1);
  }
});

test("safe HTTP JSON codes retain status, and unknown bodies never leak text", async () => {
  for (const [status, code] of [[401, "UNAUTHORIZED"], [400, "VALIDATION_ERROR"], [429, "AI_BUSY"], [503, "AI_NOT_CONFIGURED"], [502, "AI_UPSTREAM_ERROR"]]) {
    const fake = fixture([JSON.stringify({ error: { code, message: "sensitive_secret" } })], { status, contentType: "application/json" });
    await expectCode(streamChat(options(fake.transport)), code, status);
  }
  const fake = fixture(["<html>raw_secret</html>"], { status: 500, contentType: "text/html" });
  await assert.rejects(streamChat(options(fake.transport)), error => error.code === "REQUEST_FAILED" && !error.message.includes("secret") && error.status === 500);
});

test("malformed frames and unknown application states never become success", async () => {
  const streams = [
    "event: delta\ndata: {bad json}\n\n",
    frame("unknown", { text: "no" }), frame("status", { phase: "searching" }),
    frame("delta", { text: 123 }), frame("delta", { text: "\ud800" }),
    frame("delta", { type: "done", text: "contradiction" }),
    answer() + frame("status", { phase: "thinking" }),
    done(), answer("  \n") + done(),
    answer() + done({ model: "deepseek-v4-pro" }), answer() + done({ finish_reason: "unknown" }),
    answer() + done({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 9 } }),
    answer() + done({ usage: { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 } }),
    answer() + done({ usage: null }),
  ];
  for (const value of streams) await expectCode(streamChat(options(fixture([value]).transport)), "INVALID_RESPONSE");
  const invalidUtf8 = Uint8Array.from([...encoder.encode("event: delta\ndata: {\"text\":\""), 0xff, ...encoder.encode("\"}\n\n")]);
  await expectCode(streamChat(options(fixture([invalidUtf8]).transport)), "INVALID_RESPONSE");
  await expectCode(streamChat(options(fixture([answer(), done()], { contentType: "application/json" }).transport)), "INVALID_RESPONSE");
});

test("EOF without a complete done frame remains incomplete, retaining preceding deltas", async () => {
  const events = [];
  await expectCode(streamChat(options(fixture([answer("keep me")]).transport, { onEvent: event => events.push(event) })), "INCOMPLETE_RESPONSE");
  assert.deepEqual(events, [{ type: "delta", text: "keep me" }]);
  await expectCode(streamChat(options(fixture([answer(), done().trimEnd()]).transport)), "INCOMPLETE_RESPONSE");
});

test("bare CR separators work and a terminal frame may omit optional usage", async () => {
  const events = [];
  const payload = frame("delta", { text: "answer" }, "\r") + frame("done", { model: "deepseek-flash", finish_reason: "length" }, "\r");
  await streamChat(options(fixture([payload]).transport, { onEvent: event => events.push(event) }));
  assert.deepEqual(events[1], { type: "done", model: "deepseek-flash", finish_reason: "length" });
});

test("frame and total byte budgets are enforced, including multibyte text", async () => {
  await expectCode(streamChat(options(fixture([frame("delta", { text: "界".repeat(22000) })]).transport)), "RESPONSE_TOO_LARGE");
  await expectCode(streamChat(options(fixture([":" + "x".repeat(65536)]).transport)), "RESPONSE_TOO_LARGE");
  await expectCode(streamChat(options(fixture(Array.from({ length: 35 }, () => ":" + "x".repeat(61000) + "\n\n")).transport)), "RESPONSE_TOO_LARGE");
  await expectCode(streamChat(options(fixture(["x".repeat(65537)], { status: 500 }).transport)), "RESPONSE_TOO_LARGE");
});

test("successful done cancels the open reader and releases timers and caller listener", async () => {
  const external = new AbortController();
  let adds = 0, removes = 0;
  const add = external.signal.addEventListener.bind(external.signal);
  const remove = external.signal.removeEventListener.bind(external.signal);
  external.signal.addEventListener = (...args) => { adds++; return add(...args); };
  external.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
  const fake = fixture([answer(), done()], { open: true });
  await streamChat(options(fake.transport, { signal: external.signal, totalTimeoutMs: 15, idleTimeoutMs: 10 }));
  await sleep(25);
  assert.equal(fake.stats.cancels, 1);
  assert.equal(fake.stats.aborts, 0);
  assert.equal(adds, removes);
});

test("caller abort stops fetch and reader, even when the transport ignores its signal", async () => {
  const signal = new AbortController();
  const fake = fixture([answer("partial")], { open: true });
  const events = [];
  const pending = streamChat(options(fake.transport, { signal: signal.signal, onEvent: event => events.push(event) }));
  setTimeout(() => signal.abort(), 10);
  await expectCode(pending, "CANCELLED");
  assert.deepEqual(events, [{ type: "delta", text: "partial" }]);
  assert.equal(fake.stats.aborts, 1);
  assert.equal(fake.stats.cancels, 1);
  assert.equal(fake.stats.calls, 1);
  assert.equal(fake.body.locked, false);
});

test("abort during a delta callback prevents a buffered done in the same network chunk", async () => {
  const signal = new AbortController();
  const fake = fixture([answer(), done()]);
  const events = [];
  await expectCode(streamChat(options(fake.transport, { signal: signal.signal, onEvent: event => { events.push(event); signal.abort(); } })), "CANCELLED");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "delta");
});

test("already-aborted requests and redirects cannot issue a follow-up request", async () => {
  const signal = new AbortController(); signal.abort();
  let calls = 0;
  await expectCode(streamChat(options(async () => { calls++; throw new Error("must not request"); }, { signal: signal.signal })), "CANCELLED");
  assert.equal(calls, 0);
  const response = new Response(answer() + done(), { headers: { "Content-Type": "text/event-stream" } });
  Object.defineProperty(response, "redirected", { value: true });
  await expectCode(streamChat(options(async () => { calls++; return response; })), "INSECURE_API_URL");
  assert.equal(calls, 1);
});

test("idle deadline covers stalled response bodies and stalled fetch calls", async () => {
  const fake = fixture([], { open: true });
  await expectCode(streamChat(options(fake.transport, { idleTimeoutMs: 15, totalTimeoutMs: 200 })), "REQUEST_TIMEOUT");
  assert.equal(fake.stats.cancels, 1);
  assert.equal(fake.stats.aborts, 1);
  let calls = 0, aborted = false;
  await expectCode(streamChat(options((_url, init) => { calls++; init.signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }, { idleTimeoutMs: 10, totalTimeoutMs: 200 })), "REQUEST_TIMEOUT");
  assert.equal(calls, 1); assert.equal(aborted, true);
});

test("a response arriving after cancellation has its otherwise-unread body cancelled", async () => {
  const external = new AbortController();
  let resolveResponse;
  let cancelled = false;
  const pending = streamChat(options(() => new Promise(resolve => { resolveResponse = resolve; }), { signal: external.signal }));
  external.abort();
  await expectCode(pending, "CANCELLED");
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  resolveResponse(new Response(body));
  await sleep(0);
  assert.equal(cancelled, true);
});

function heartbeatTransport(complete) {
  let interval;
  let count = 0;
  let cancels = 0;
  const body = new ReadableStream({
    start(controller) {
      interval = setInterval(() => {
        controller.enqueue(encoder.encode(": keep-alive\n\n"));
        if (complete && ++count === 4) {
          controller.enqueue(encoder.encode(answer() + done()));
          clearInterval(interval);
        }
      }, 8);
    },
    cancel() { clearInterval(interval); cancels++; },
  });
  return { transport: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }), get cancels() { return cancels; } };
}
test("keep-alive resets idle time, while the total deadline remains absolute", async () => {
  const success = heartbeatTransport(true);
  await streamChat(options(success.transport, { idleTimeoutMs: 25, totalTimeoutMs: 200 }));
  assert.equal(success.cancels, 1);
  const endless = heartbeatTransport(false);
  await expectCode(streamChat(options(endless.transport, { idleTimeoutMs: 25, totalTimeoutMs: 50 })), "REQUEST_TIMEOUT");
  assert.equal(endless.cancels, 1);
});

test("network failures are safe and never automatically retried", async () => {
  let calls = 0;
  await assert.rejects(streamChat(options(async () => { calls++; throw new Error("raw secret supplier message"); })), error => error.code === "NETWORK_ERROR" && !error.message.includes("secret"));
  assert.equal(calls, 1);
});

test('the server public contract carries a 70KB answer in 8KiB delta frames without a false size failure', async () => {
  const content = 'x'.repeat(70000) + '你好🌊';
  const frames = [];
  for (let start = 0; start < 70000; start += 8192) frames.push(answer(content.slice(start, Math.min(start + 8192, 70000))));
  frames.push(answer('你好🌊'), done());
  assert.ok(frames.every(value => encoder.encode(value).length < 64 * 1024));
  const fake = fixture(frames);
  let received = '', completed = false;
  await streamChat(options(fake.transport, { onEvent(event) { if (event.type === 'delta') received += event.text; if (event.type === 'done') completed = true; } }));
  assert.equal(received, content);
  assert.equal(completed, true);
});
