import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createPendingStore, decodeAuth, decodeConnection, decodeJob, decodePending, isSafeSubmissionRejection, safeVideoUrl, WorkbenchError, workbenchRequest } from "./core.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const secondOwner = "22222222-2222-4222-8222-222222222222";
const connection = "33333333-3333-4333-8333-333333333333";
const key = "44444444-4444-4444-8444-444444444444";
const created = "2026-10-19T00:00:00Z";
const intent = { owner_id: owner, request: { connection_id: connection, prompt: "海边日出", model_name: "kling-v2-6", mode: "pro", duration: "5", aspect_ratio: "16:9", idempotency_key: key } };
const job = { ...intent.request, id: key, status: "unknown", provider_task_id: null, video_url: null, error_code: "VIDEO_SUBMISSION_UNKNOWN", created_at: created, updated_at: created };
function storage() {
  const values = new Map();
  return { values, adapter: { get: async key => values.get(key) ?? null, set: async (key, value) => { assert.ok(Buffer.byteLength(value) <= 2048); values.set(key, value); }, remove: async key => { values.delete(key); } } };
}

test("media guards reject untrusted, local and credential-bearing URLs", () => {
  assert.equal(safeVideoUrl("https://cdn.klingai.com/video.mp4?signature=temporary"), true);
  for (const value of ["http://cdn.klingai.com/video.mp4", "https://klingai.com.evil.example/video", "https://127.0.0.1/video", "https://user:secret@cdn.klingai.com/video", "https://cdn.klingai.com:8443/video", "file:///tmp/video", "javascript:alert(1)"]) assert.equal(safeVideoUrl(value), false);
  assert.throws(() => decodeJob({ ...job, video_url: "https://evil.example/video" }), { code: "INVALID_RESPONSE" });
  assert.equal(decodeJob(job).status, "unknown");
});

test("auth and connection boundary validation strip extra fields and accept Unicode profiles", () => {
  const user = { id: owner, handle: "testuser", display_name: "😀".repeat(40), avatar: "orbit", bio: "😀".repeat(160), theme: "warm", locale: "zh-CN", created_at: created, secret: "must not survive" };
  const decoded = decodeAuth({ token: "q_" + "a".repeat(43), user });
  assert.equal(decoded.user.display_name, user.display_name);
  assert.equal("secret" in decoded.user, false);
  assert.throws(() => decodeAuth({ token: "arbitrary-token", user }), { code: "INVALID_RESPONSE" });
  const saved = decodeConnection({ id: connection, name: "我的账户", region: "cn", provider: "kling", created_at: created, revoked: false, api_key: "must not survive" });
  assert.equal("api_key" in saved, false);
  assert.equal("idempotency_key" in decodeJob(job), false);
});

test("owner-bound pending intents survive reload, refuse replacement, and contain no credentials", async () => {
  const memory = storage();
  const store = createPendingStore(memory.adapter);
  await store.save({ ...intent, api_key: "never persist", request: { ...intent.request, token: "never persist" } });
  const restored = await createPendingStore(memory.adapter).read(owner);
  assert.deepEqual(restored, intent);
  assert.equal(await store.read(secondOwner), null);
  assert.throws(() => decodePending(intent, secondOwner), { code: "STORAGE_ERROR" });
  await assert.rejects(store.save({ ...intent, request: { ...intent.request, idempotency_key: secondOwner } }), { code: "STORAGE_ERROR" });
  await store.clear(owner, secondOwner);
  assert.deepEqual(await store.read(owner), intent);
  await store.clear(owner, key);
  assert.equal(await store.read(owner), null);
  assert.equal(memory.values.size, 0);
});

test("SecureStore chunks preserve maximum Unicode prompts and fail closed on corruption", async () => {
  const memory = storage();
  const store = createPendingStore(memory.adapter);
  const large = { ...intent, request: { ...intent.request, prompt: "😀".repeat(2500) } };
  await store.save(large);
  assert.deepEqual(await createPendingStore(memory.adapter).read(owner), large);
  memory.values.delete(`xiaoq.video.pending.v1.${owner}.${key}.0`);
  await assert.rejects(store.read(owner), { code: "STORAGE_ERROR" });
  await assert.rejects(store.save(intent), { code: "STORAGE_ERROR" });
});

test("storage failure before manifest prevents accepting an unsafe submission intent", async () => {
  const memory = storage();
  let calls = 0;
  const store = createPendingStore({ ...memory.adapter, set: async (name, value) => { if (++calls === 2) throw new Error("full"); await memory.adapter.set(name, value); } });
  await assert.rejects(store.save({ ...intent, request: { ...intent.request, prompt: "海".repeat(2500) } }), { code: "STORAGE_ERROR" });
  assert.equal(await createPendingStore(memory.adapter).read(owner), null);
});

test("only documented pre-reservation errors permit discarding the original intent", () => {
  assert.equal(isSafeSubmissionRejection(new WorkbenchError("VALIDATION_ERROR", 400)), true);
  assert.equal(isSafeSubmissionRejection(new WorkbenchError("VIDEO_CONNECTION_NOT_FOUND", 404)), true);
  assert.equal(isSafeSubmissionRejection(new WorkbenchError("VIDEO_CONNECTION_REVOKED", 409)), true);
  for (const error of [new WorkbenchError("NETWORK_ERROR"), new WorkbenchError("REQUEST_TIMEOUT"), new WorkbenchError("UNAUTHORIZED", 401), new WorkbenchError("RATE_LIMITED", 429), new WorkbenchError("IDEMPOTENCY_CONFLICT", 409), new WorkbenchError("INTERNAL_ERROR", 500)]) assert.equal(isSafeSubmissionRejection(error), false);
});

test("timed-out POST is attempted once, keeps original recovery key, and never exposes supplier body", async () => {
  let calls = 0;
  const memory = storage();
  const store = createPendingStore(memory.adapter);
  await store.save(intent);
  await assert.rejects(workbenchRequest({ baseUrl: "http://127.0.0.1:8787", path: "/v1/video/jobs", method: "POST", body: intent.request, decode: decodeJob, timeoutMs: 5,
    transport: async (_url, options) => { calls++; assert.equal(options.redirect, "error"); return await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("sensitive transport detail")), { once: true })); },
  }), { code: "REQUEST_TIMEOUT", message: "REQUEST_TIMEOUT" });
  assert.equal(calls, 1);
  assert.deepEqual(await createPendingStore(memory.adapter).read(owner), intent);
  let submitted;
  const original = await store.read(owner);
  const result = await workbenchRequest({ baseUrl: "http://127.0.0.1:8787", path: "/v1/video/jobs", method: "POST", body: original.request, decode: decodeJob, transport: async (_url, options) => { submitted = JSON.parse(options.body); return new Response(JSON.stringify(job), { status: 200 }); } });
  assert.equal(submitted.idempotency_key, key);
  assert.equal(result.id, key);
});

test("remote HTTP and cancellation fail before any credential-bearing request", async () => {
  let calls = 0;
  const transport = async () => { calls++; return new Response("{}"); };
  const options = { path: "/v1/auth/login", decode: value => value, transport, token: "private" };
  await assert.rejects(workbenchRequest({ ...options, baseUrl: "http://192.168.1.10:8787" }), { code: "INSECURE_API_URL" });
  await assert.rejects(workbenchRequest({ ...options, baseUrl: "invalid" }), { code: "INSECURE_API_URL" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(workbenchRequest({ ...options, baseUrl: "https://q.example", signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(calls, 0);
});
