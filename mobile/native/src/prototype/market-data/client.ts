import {
  MarketDataError, marketSource, cryptoReadRequest, parseCryptoReport, parseFedReport, parseFilingsReport,
  parseGdeltReport, validateMarketQuery,
} from './core';
import type { MarketQuery, MarketReport } from './core';
export { MarketDataError, marketErrorText } from './core';

export const MARKET_RESPONSE_LIMIT_BYTES = 512 * 1024;
export const MARKET_TIMEOUT_MS = 10_000;
export type MarketRequestOptions = {
  transport: typeof fetch;
  signal?: AbortSignal;
};

function retryAfter(value: string | null): number | null {
  if (!value) return null;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 24 * 60 * 60_000) : null;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal, abortError: () => MarketDataError): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(abortError());
    if (signal.aborted) { void promise.then(() => undefined, () => undefined); reject(abortError()); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function readBounded(response: Response, signal: AbortSignal, abortError: () => MarketDataError): Promise<string> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MARKET_RESPONSE_LIMIT_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new MarketDataError('too_large');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new MarketDataError('stream_unavailable');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const result = await abortable(reader.read(), signal, abortError);
      if (signal.aborted) throw abortError();
      if (result.done) { complete = true; break; }
      if (!(result.value instanceof Uint8Array)) throw new MarketDataError('invalid_data');
      total += result.value.byteLength;
      if (total > MARKET_RESPONSE_LIMIT_BYTES) throw new MarketDataError('too_large');
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MarketDataError('invalid_data'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

/** One anonymous fixed-source read request. No account, credential, storage or retry access. */
export async function requestMarketReport(query: MarketQuery, options: MarketRequestOptions): Promise<MarketReport> {
  let valid: MarketQuery;
  try { valid = validateMarketQuery(query); }
  catch { throw new MarketDataError('invalid_query'); }
  const source = marketSource(valid);
  if (options.signal?.aborted) throw new MarketDataError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abortError = () => new MarketDataError(timedOut ? 'timeout' : 'cancelled');
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MARKET_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: source.id === 'federal-reserve' ? 'application/rss+xml, application/xml, text/xml' : 'application/json' };
    if (source.id === 'sec') headers['User-Agent'] = 'Q-Public-Research/0.1 (+https://q.kaicloudpay.com)';
    if (valid.kind === 'crypto') headers['Content-Type'] = 'application/json';
    const pending = options.transport(source.url, {
      method: valid.kind === 'crypto' ? 'POST' : 'GET',
      ...(valid.kind === 'crypto' ? { body: JSON.stringify(cryptoReadRequest(valid)) } : {}), headers, credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal,
    }).then(response => {
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw abortError();
      }
      return response;
    });
    const response = await abortable(pending, controller.signal, abortError);
    if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      || (response.url && response.url !== source.url)) {
      void response.body?.cancel().catch(() => undefined);
      throw new MarketDataError('redirect');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new MarketDataError(response.status === 429 ? 'rate_limited' : 'http', response.status, response.status === 429 ? retryAfter(response.headers.get('Retry-After')) : null);
    }
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const allowed = source.id === 'federal-reserve' ? ['application/rss+xml', 'application/xml', 'text/xml'] : ['application/json'];
    if (!contentType || !allowed.includes(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw new MarketDataError('invalid_data');
    }
    const body = await readBounded(response, controller.signal, abortError);
    if (controller.signal.aborted) throw abortError();
    const fetchedAt = new Date().toISOString();
    if (valid.kind === 'news' && valid.topic === 'fed') return parseFedReport(body, valid, fetchedAt);
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new MarketDataError('invalid_data'); }
    if (valid.kind === 'crypto') return parseCryptoReport(data, valid, fetchedAt);
    if (valid.kind === 'filings') return parseFilingsReport(data, valid, fetchedAt);
    return parseGdeltReport(data, valid, fetchedAt);
  } catch (error) {
    if (controller.signal.aborted) throw abortError();
    if (error instanceof MarketDataError) throw error;
    throw new MarketDataError('network');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    // Expo reader.cancel() only stops delivery; abort also terminates the native transfer.
    // Do this after catch has selected the outcome, preserving its original error code.
    controller.abort();
  }
}
