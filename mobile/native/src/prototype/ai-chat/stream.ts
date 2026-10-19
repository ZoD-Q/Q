export class ChatError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 0) {
    super(code);
    this.name = "ChatError";
    this.code = code;
    this.status = status;
  }
}

const MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const;
const FINISH_REASONS = ["stop", "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted"] as const;
const SAFE_CODES = new Set(["AI_AUTH_ERROR", "AI_QUOTA_EXCEEDED", "AI_UPSTREAM_ERROR", "AI_TIMEOUT", "AI_NOT_CONFIGURED", "AI_RATE_LIMITED", "AI_BUSY", "UNAUTHORIZED", "VALIDATION_ERROR"]);
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type Model = (typeof MODELS)[number];
type FinishReason = (typeof FINISH_REASONS)[number];
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type ChatEvent =
  | { type: "status"; phase: "thinking" | "responding" }
  | { type: "delta"; text: string }
  | { type: "done"; model: Model; finish_reason: FinishReason; usage?: Usage };
export type ChatRequest = { model: string; thinking: boolean; messages: { role: "user" | "assistant"; content: string }[] };
export type StreamChatOptions = {
  baseUrl: string;
  token: string;
  request: ChatRequest;
  onEvent: (event: ChatEvent) => void;
  signal?: AbortSignal;
  transport?: typeof fetch;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
const invalidResponse = (): never => { throw new ChatError("INVALID_RESPONSE"); };
function textLength(value: unknown, max: number): number | null {
  if (typeof value !== "string" || value.length > max * 2 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) return null;
  let length = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (++length > max || (code >= 0xd800 && code <= 0xdfff)) return null;
  }
  return length;
}

export function decodeAiStatus(value: unknown): { configured: boolean; models: { id: Model; name: string }[] } {
  if (!record(value) || typeof value.configured !== "boolean" || !Array.isArray(value.models) || value.models.length > MODELS.length) return invalidResponse();
  const ids = new Set<string>();
  const models = value.models.map(item => {
    if (!record(item) || !oneOf(item.id, MODELS) || textLength(item.name, 80) === null || typeof item.name !== "string" || !item.name.trim() || ids.has(item.id)) return invalidResponse();
    ids.add(item.id);
    return { id: item.id, name: item.name };
  });
  return { configured: value.configured, models };
}

function validateRequest(value: ChatRequest): ChatRequest {
  if (!record(value) || !oneOf(value.model, MODELS) || typeof value.thinking !== "boolean" || !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) throw new ChatError("VALIDATION_ERROR");
  let total = 0;
  const messages = value.messages.map(message => {
    if (!record(message) || !oneOf(message.role, ["user", "assistant"] as const) || typeof message.content !== "string" || !message.content.trim()) throw new ChatError("VALIDATION_ERROR");
    const length = textLength(message.content, 12000);
    if (length === null || (total += length) > 24000) throw new ChatError("VALIDATION_ERROR");
    return { role: message.role, content: message.content };
  });
  if (messages[messages.length - 1].role !== "user") throw new ChatError("VALIDATION_ERROR");
  return { model: value.model, thinking: value.thinking, messages };
}

function endpoint(baseUrl: string): string {
  let base: URL;
  try { base = new URL(baseUrl); } catch { throw new ChatError("INSECURE_API_URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(base.hostname);
  if (!base.hostname || base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !(base.protocol === "http:" && local))) throw new ChatError("INSECURE_API_URL");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/v1/ai/chat`;
  return base.toString();
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_CODES.has(value) ? value : fallback;
}
function usage(value: unknown): Usage {
  if (!record(value)) return invalidResponse();
  const { prompt_tokens, completion_tokens, total_tokens } = value;
  for (const number of [prompt_tokens, completion_tokens, total_tokens]) {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return invalidResponse();
  }
  if ((prompt_tokens as number) + (completion_tokens as number) !== total_tokens) return invalidResponse();
  return { prompt_tokens: prompt_tokens as number, completion_tokens: completion_tokens as number, total_tokens: total_tokens as number };
}

/** Bytes are buffered per SSE line, so UTF-8 and CRLF may cross any read boundary. */
class ChatParser {
  finished = false;
  private line: number[] = [];
  private data: string[] = [];
  private event = "";
  private frameBytes = 0;
  private pendingCR = false;
  private firstLine = true;
  private hasAnswer = false;
  private responding = false;
  private decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private model: string;
  private emit: (event: ChatEvent) => void;
  constructor(model: string, emit: (event: ChatEvent) => void) { this.model = model; this.emit = emit; }
  push(bytes: Uint8Array) {
    for (const byte of bytes) {
      if (this.finished) return;
      if (this.pendingCR) {
        this.pendingCR = false;
        if (byte === 10) { this.count(); this.endLine(); continue; }
        this.endLine();
        if (this.finished) return;
      }
      this.count();
      if (byte === 13) this.pendingCR = true;
      else if (byte === 10) this.endLine();
      else this.line.push(byte);
    }
  }
  end() {
    if (this.pendingCR && !this.finished) { this.pendingCR = false; this.endLine(); }
    if (!this.finished) throw new ChatError("INCOMPLETE_RESPONSE");
  }
  private count() {
    if (++this.frameBytes > MAX_FRAME_BYTES) throw new ChatError("RESPONSE_TOO_LARGE");
  }
  private endLine() {
    let line: string;
    try { line = this.decoder.decode(Uint8Array.from(this.line)); } catch { return invalidResponse(); }
    this.line = [];
    if (this.firstLine) { line = line.replace(/^\uFEFF/, ""); this.firstLine = false; }
    if (!line) {
      if (this.data.length) this.dispatch();
      this.data = []; this.event = ""; this.frameBytes = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    // id, retry and unrecognized SSE fields do not carry application data.
  }
  private dispatch() {
    let value: unknown;
    try { value = JSON.parse(this.data.join("\n")); } catch { return invalidResponse(); }
    if (!record(value)) return invalidResponse();
    const kind = this.event || value.type;
    if (value.type !== undefined && value.type !== kind) return invalidResponse();
    if (kind === "error") throw new ChatError(safeCode(value.code, "AI_UPSTREAM_ERROR"));
    if (kind === "status") {
      if (!oneOf(value.phase, ["thinking", "responding"] as const) || (this.responding && value.phase === "thinking")) return invalidResponse();
      if (value.phase === "responding") this.responding = true;
      this.emit({ type: "status", phase: value.phase });
    } else if (kind === "delta") {
      if (typeof value.text !== "string" || textLength(value.text, MAX_FRAME_BYTES) === null) return invalidResponse();
      this.responding = true;
      if (value.text.trim()) this.hasAnswer = true;
      this.emit({ type: "delta", text: value.text });
    } else if (kind === "done") {
      if (!this.hasAnswer || !oneOf(value.model, MODELS) || value.model !== this.model || !oneOf(value.finish_reason, FINISH_REASONS)) return invalidResponse();
      const event: ChatEvent = { type: "done", model: value.model, finish_reason: value.finish_reason };
      if (value.usage !== undefined) event.usage = usage(value.usage);
      this.finished = true;
      this.emit(event);
    } else return invalidResponse();
  }
}

/** One authenticated request, with no retries and no provider secrets in URLs or errors. */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const url = endpoint(options.baseUrl);
  const request = validateRequest(options.request);
  if (typeof options.token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/.test(options.token) || options.token.length > 8192) throw new ChatError("UNAUTHORIZED");
  const totalMs = options.totalTimeoutMs ?? 190000;
  const idleMs = options.idleTimeoutMs ?? 40000;
  if (![totalMs, idleMs].every(value => Number.isFinite(value) && value > 0 && value <= 2147483647)) throw new ChatError("VALIDATION_ERROR");
  if (options.signal?.aborted) throw new ChatError("CANCELLED");
  const controller = new AbortController();
  let failure: ChatError | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelledReader = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelReader = () => {
    if (!reader || cancelledReader) return;
    cancelledReader = true;
    try { void reader.cancel().catch(() => undefined); } catch { /* Already released. */ }
  };
  const stop = (error: ChatError) => {
    if (failure) return;
    failure = error;
    controller.abort();
    cancelReader();
  };
  const cancel = () => stop(new ChatError("CANCELLED"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const resetIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop(new ChatError("REQUEST_TIMEOUT")), idleMs);
  };
  const totalTimer = setTimeout(() => stop(new ChatError("REQUEST_TIMEOUT")), totalMs);
  resetIdle();

  // Remove each temporary listener after its operation; do not accumulate races per token.
  const waitFor = <T,>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const interrupted = () => { controller.signal.removeEventListener("abort", interrupted); reject(failure || new ChatError("CANCELLED")); };
    if (controller.signal.aborted) {
      void operation.catch(() => undefined);
      interrupted();
      return;
    }
    controller.signal.addEventListener("abort", interrupted, { once: true });
    operation.then(value => {
      controller.signal.removeEventListener("abort", interrupted);
      if (controller.signal.aborted) reject(failure || new ChatError("CANCELLED"));
      else resolve(value);
    }, error => { controller.signal.removeEventListener("abort", interrupted); reject(error); });
  });
  const read = async () => {
    const result = await waitFor(reader!.read());
    if (!result.done && result.value.byteLength) resetIdle();
    return result;
  };
  try {
    if (controller.signal.aborted) throw failure || new ChatError("CANCELLED");
    const pending = (options.transport ?? fetch)(url, {
      method: "POST", signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
      body: JSON.stringify(request),
    }).then(response => {
      if (controller.signal.aborted) { try { void response.body?.cancel().catch(() => undefined); } catch { /* Transport already closed. */ } }
      return response;
    });
    const response = await waitFor(pending);
    resetIdle();
    if (response.redirected || (response.url && new URL(response.url).origin !== new URL(url).origin)) throw new ChatError("INSECURE_API_URL");
    if (response.body) reader = response.body.getReader();
    if (!response.ok) {
      let size = 0;
      const parts: Uint8Array[] = [];
      if (reader) while (true) {
        const chunk = await read();
        if (chunk.done) break;
        if ((size += chunk.value.byteLength) > MAX_FRAME_BYTES) throw new ChatError("RESPONSE_TOO_LARGE", response.status);
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { payload = null; }
      const fallback = response.status === 401 ? "UNAUTHORIZED" : response.status === 400 ? "VALIDATION_ERROR" : response.status === 429 ? "AI_RATE_LIMITED" : "REQUEST_FAILED";
      const error = record(payload) && record(payload.error) ? payload.error : null;
      throw new ChatError(safeCode(error?.code, fallback), response.status);
    }
    if (response.status !== 200 || !reader || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "text/event-stream") return invalidResponse();
    const parser = new ChatParser(request.model, event => {
      if (controller.signal.aborted) throw failure || new ChatError("CANCELLED");
      options.onEvent(event);
      if (controller.signal.aborted) throw failure || new ChatError("CANCELLED");
    });
    let bytes = 0;
    while (!parser.finished) {
      const chunk = await read();
      if (chunk.done) { parser.end(); break; }
      if (!(chunk.value instanceof Uint8Array)) return invalidResponse();
      if ((bytes += chunk.value.byteLength) > MAX_RESPONSE_BYTES) throw new ChatError("RESPONSE_TOO_LARGE");
      parser.push(chunk.value);
    }
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof ChatError) throw error;
    throw new ChatError("NETWORK_ERROR");
  } finally {
    clearTimeout(totalTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", cancel);
    cancelReader();
    try { reader?.releaseLock(); } catch { /* A native transport may already release its reader. */ }
  }
}
