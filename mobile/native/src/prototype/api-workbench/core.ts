import type { AuthResponse, User, VideoConnection, VideoJob, VideoJobRequest } from "@xiaoq/shared";

export class WorkbenchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = "WorkbenchError";
    this.code = code;
    this.status = status;
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const string = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const chars = (value: unknown, max: number): value is string => typeof value === "string" && Array.from(value).length <= max;
const date = (value: unknown): value is string => string(value, 64) && Number.isFinite(Date.parse(value));
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T => typeof value === "string" && choices.includes(value as T);
const fail = (): never => { throw new WorkbenchError("INVALID_RESPONSE"); };

/** Only HTTPS media without embedded credentials or local network destinations is playable. */
export function safeVideoUrl(value: unknown): value is string {
  if (!string(value, 8192)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (host === "klingai.com" || host.endsWith(".klingai.com"));
  } catch { return false; }
}

export function decodeUser(value: unknown): User {
  if (!record(value) || !uuid(value.id) || !string(value.handle, 24) || !chars(value.display_name, 40) ||
    !oneOf(value.avatar, ["orbit", "leaf", "spark", "wave"]) || !chars(value.bio, 160) ||
    !oneOf(value.theme, ["light", "dark", "warm"]) || !oneOf(value.locale, ["zh-CN", "en"]) || !date(value.created_at)) return fail();
  return { id: value.id, handle: value.handle, display_name: value.display_name, avatar: value.avatar, bio: value.bio, theme: value.theme, locale: value.locale, created_at: value.created_at };
}

export function decodeAuth(value: unknown): AuthResponse {
  if (!record(value) || !string(value.token, 45) || !/^q_[A-Za-z0-9_-]{43}$/.test(value.token)) return fail();
  return { token: value.token, user: decodeUser(value.user) };
}

export function decodeConnection(value: unknown): VideoConnection {
  if (!record(value) || !uuid(value.id) || !chars(value.name, 48) || value.provider !== "kling" ||
    !oneOf(value.region, ["cn", "global"]) || !date(value.created_at) || typeof value.revoked !== "boolean") return fail();
  return { id: value.id, name: value.name, provider: "kling", region: value.region, created_at: value.created_at, revoked: value.revoked };
}

type GenerationFields = Pick<VideoJob, "connection_id" | "prompt" | "model_name" | "mode" | "duration" | "aspect_ratio">;
function generationFields(value: Record<string, unknown>): value is Record<string, unknown> & GenerationFields {
  return uuid(value.connection_id) && string(value.prompt, 5000) && value.prompt.trim().length > 0 &&
    Array.from(value.prompt).length <= 2500 && value.model_name === "kling-v2-6" && value.mode === "pro" &&
    oneOf(value.duration, ["5", "10"]) && oneOf(value.aspect_ratio, ["16:9", "9:16", "1:1"]);
}

export function decodeJob(value: unknown): VideoJob {
  if (!record(value) || !uuid(value.id) || !generationFields(value) ||
    !oneOf(value.status, ["submitting", "unknown", "submitted", "processing", "succeeded", "failed"]) ||
    !(value.provider_task_id === null || string(value.provider_task_id, 256)) ||
    !(value.error_code === null || string(value.error_code, 128)) ||
    !(value.video_url === null || safeVideoUrl(value.video_url)) || !date(value.created_at) || !date(value.updated_at)) return fail();
  return { id: value.id, connection_id: value.connection_id, prompt: value.prompt, model_name: value.model_name, mode: value.mode, duration: value.duration,
    aspect_ratio: value.aspect_ratio, status: value.status, provider_task_id: value.provider_task_id, video_url: value.video_url, error_code: value.error_code, created_at: value.created_at, updated_at: value.updated_at };
}

export function decodeList<T>(decode: (value: unknown) => T) {
  return (value: unknown): T[] => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 500) return fail();
    return value.items.map(decode);
  };
}

export type PendingVideo = { owner_id: string; request: VideoJobRequest };
export function decodePending(value: unknown, owner: string): PendingVideo {
  if (!uuid(owner) || !record(value) || value.owner_id !== owner || !record(value.request) ||
    !generationFields(value.request) || !uuid(value.request.idempotency_key)) throw new WorkbenchError("STORAGE_ERROR");
  const key = value.request.idempotency_key;
  const request = value.request;
  return { owner_id: owner, request: { connection_id: request.connection_id, prompt: request.prompt, model_name: request.model_name, mode: request.mode,
    duration: request.duration, aspect_ratio: request.aspect_ratio, idempotency_key: key } };
}

export function decodeError(value: unknown, status: number): WorkbenchError {
  const fallback = status === 401 ? "UNAUTHORIZED" : status === 429 ? "RATE_LIMITED" : "REQUEST_FAILED";
  const code = record(value) && record(value.error) && string(value.error.code, 128) && /^[A-Z_]+$/.test(value.error.code)
    ? value.error.code : fallback;
  return new WorkbenchError(code, status);
}

export function isUncertainJob(job: VideoJob) { return job.status === "unknown" || job.status === "submitting"; }

/** These typed errors are guaranteed to occur before the server reserves or sends a supplier request. */
export function isSafeSubmissionRejection(error: unknown): boolean {
  return error instanceof WorkbenchError && (
    (error.status === 400 && error.code === "VALIDATION_ERROR") ||
    (error.status === 404 && error.code === "VIDEO_CONNECTION_NOT_FOUND") ||
    (error.status === 409 && error.code === "VIDEO_CONNECTION_REVOKED")
  );
}

/** Local recovery can block new submissions without hiding server-owned history. */
export async function loadWorkbenchSnapshot(loaders: {
  pending: () => Promise<PendingVideo | null>;
  connections: () => Promise<VideoConnection[]>;
  jobs: () => Promise<VideoJob[]>;
}) {
  const [pending, connections, jobs] = await Promise.allSettled([
    Promise.resolve().then(loaders.pending),
    Promise.resolve().then(loaders.connections),
    Promise.resolve().then(loaders.jobs),
  ]);
  const failures = [pending, connections, jobs].filter((result): result is PromiseRejectedResult => result.status === "rejected");
  // An expired session must still be cleared when storage fails first.
  const failure = failures.find(({ reason }) => reason instanceof WorkbenchError && reason.status === 401)
    ?? failures[0] ?? null;
  return { pending, connections, jobs, failure };
}


function readResponseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  let abort: () => void;
  const reading = new Promise<unknown>((resolve, reject) => {
    abort = () => reject(new Error("BODY_READ_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    // A deadline must also settle the request if a transport ignores abort while reading.
    Promise.resolve().then(() => response.json()).then(resolve, reject);
  });
  return reading.finally(() => signal.removeEventListener("abort", abort));
}

/** No automatic retries: every caller must preserve the original intent for uncertain writes. */
export async function workbenchRequest<T>(options: {
  baseUrl: string;
  path: string;
  token?: string | null;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  decode: (value: unknown) => T;
  signal?: AbortSignal;
  transport?: typeof fetch;
  timeoutMs?: number;
}): Promise<T> {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new WorkbenchError("INSECURE_API_URL"); }
  if (base.username || base.password || base.search || base.hash ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(base.hostname)))) {
    throw new WorkbenchError("INSECURE_API_URL");
  }
  const controller = new AbortController();
  if (options.signal?.aborted) throw new WorkbenchError("CANCELLED");
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(cancel, options.timeoutMs ?? 30000);
  const throwIfAborted = () => {
    if (controller.signal.aborted) throw new WorkbenchError(options.signal?.aborted ? "CANCELLED" : "REQUEST_TIMEOUT");
  };
  try {
    const response = await (options.transport ?? fetch)(`${options.baseUrl}${options.path}`, {
      method: options.method ?? "GET",
      signal: controller.signal,
      credentials: "omit",
      redirect: "error",
      headers: {
        Accept: "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok && controller.signal.aborted) throw decodeError(null, response.status);
    throwIfAborted();
    let payload: unknown;
    try {
      payload = response.status === 204 ? undefined : await readResponseJson(response, controller.signal);
    } catch (failure) {
      // The received HTTP status remains authoritative even if its error body is interrupted.
      if (!response.ok) throw decodeError(null, response.status);
      // An interrupted response body is still a timeout/cancellation, not malformed wallet data.
      throwIfAborted();
      throw new WorkbenchError(failure instanceof SyntaxError ? "INVALID_RESPONSE" : "NETWORK_ERROR");
    }
    if (!response.ok) throw decodeError(payload, response.status);
    throwIfAborted();
    return options.decode(payload);
  } catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError(options.signal?.aborted ? "CANCELLED" : controller.signal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}


type Storage = { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void>; remove: (key: string) => Promise<void> };

/** Each Unicode chunk stays below SecureStore's ~2 KB value limit. Commit the manifest last. */
export function createPendingStore(storage: Storage) {
  let tail = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next.catch(() => { throw new WorkbenchError("STORAGE_ERROR"); });
  }
  const prefix = (owner: string) => `xiaoq.video.pending.v1.${owner}`;
  async function read(owner: string): Promise<PendingVideo | null> {
    const raw = await storage.get(prefix(owner));
    if (raw === null) return null;
    const manifest: unknown = JSON.parse(raw);
    if (!manifest || typeof manifest !== "object" || !("key" in manifest) || !("count" in manifest) ||
      typeof manifest.key !== "string" || !/^[0-9a-f-]{36}$/i.test(manifest.key) ||
      typeof manifest.count !== "number" || !Number.isInteger(manifest.count) || manifest.count < 1 || manifest.count > 40) throw new WorkbenchError("STORAGE_ERROR");
    let payload = "";
    for (let i = 0; i < manifest.count; i++) {
      const chunk = await storage.get(`${prefix(owner)}.${manifest.key}.${i}`);
      if (chunk === null) throw new WorkbenchError("STORAGE_ERROR");
      payload += chunk;
    }
    const pending = decodePending(JSON.parse(payload), owner);
    if (pending.request.idempotency_key !== manifest.key) throw new WorkbenchError("STORAGE_ERROR");
    return pending;
  }
  return {
    read: (owner: string) => enqueue(() => read(owner)),
    save: (pending: PendingVideo) => enqueue(async () => {
      const sanitized = decodePending(pending, pending.owner_id);
      const existing = await read(pending.owner_id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(sanitized)) throw new WorkbenchError("STORAGE_ERROR");
      const characters = Array.from(JSON.stringify(sanitized));
      const chunks: string[] = [];
      for (let i = 0; i < characters.length; i += 400) chunks.push(characters.slice(i, i + 400).join(""));
      for (let i = 0; i < chunks.length; i++) await storage.set(`${prefix(pending.owner_id)}.${pending.request.idempotency_key}.${i}`, chunks[i]);
      await storage.set(prefix(pending.owner_id), JSON.stringify({ key: pending.request.idempotency_key, count: chunks.length }));
    }),
    clear: (owner: string, key: string) => enqueue(async () => {
      const current = await read(owner);
      if (current?.request.idempotency_key !== key) return;
      const raw = await storage.get(prefix(owner));
      if (!raw) return;
      const manifest = JSON.parse(raw) as { count: number };
      // A successful server response is already available before callers clear this pointer.
      await storage.remove(prefix(owner));
      for (let i = 0; i < manifest.count; i++) await storage.remove(`${prefix(owner)}.${key}.${i}`);
    }),
  };
}
