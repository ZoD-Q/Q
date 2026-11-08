import { resolveApiUrl } from '../../services/api-target.mjs';
import { CompanyResearchError } from './core';
import { decodeFilingCatalog, decodeFilingDocument, isFilingAccession, isFilingCik, isFilingIssuerId } from './filings-core';
import type { FilingCatalog, FilingDocument } from './filings-core';

export type FilingRequestOptions = { transport: typeof fetch; signal: AbortSignal; apiBaseUrl?: string };
export type FilingPageOptions = FilingRequestOptions & { offset?: number; expectedSha256?: string };
export const FILING_RESPONSE_LIMIT = 512 * 1024;
export const FILING_TIMEOUT_MS = 40_000;
const cooldowns = new WeakMap<typeof fetch, number>();
const knownCodes = new Set(['RESEARCH_FILING_NOT_FOUND', 'RESEARCH_SOURCE_UNAVAILABLE', 'RESEARCH_SOURCE_RATE_LIMITED', 'RESEARCH_SOURCE_TIMEOUT', 'RESEARCH_SOURCE_INVALID', 'RESEARCH_SOURCE_TOO_LARGE', 'RESEARCH_DOCUMENT_CHANGED', 'VALIDATION_ERROR']);
function abortable<T>(promise: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(error());
    if (signal.aborted) { void promise.catch(() => undefined); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function request<T>(path: string, options: FilingRequestOptions, decode: (value: unknown) => T): Promise<T> {
  if (options.signal.aborted) throw new CompanyResearchError('cancelled');
  if (Date.now() < (cooldowns.get(options.transport) ?? 0)) throw new CompanyResearchError('RESEARCH_SOURCE_RATE_LIMITED');
  const base = resolveApiUrl(options.apiBaseUrl ?? process.env.EXPO_PUBLIC_API_URL);
  try {
    const parsedBase = new URL(base);
    if (!['https:', 'http:'].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) throw new Error('invalid API base');
  } catch { throw new CompanyResearchError('filing_service_unavailable'); }
  const url = `${base}${path}`;
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new CompanyResearchError('filing_service_unavailable');
  const controller = new AbortController(); let timeout = false;
  const cancel = () => controller.abort();
  const error = () => new CompanyResearchError(timeout ? 'RESEARCH_SOURCE_TIMEOUT' : 'cancelled');
  options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timeout = true; cancel(); }, FILING_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const transport = options.transport;
    const pending = transport(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'application/json' } }).then(response => {
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw error(); } return response;
    });
    const response = await abortable(pending, controller.signal, error);
    const fail = (code: string): never => { void response.body?.cancel().catch(() => undefined); throw new CompanyResearchError(code); };
    if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.url && response.url !== url) fail('redirect');
    if (response.status === 429) {
      const retry = response.headers.get('Retry-After') ?? '';
      const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      cooldowns.set(transport, Date.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 60_000));
      fail('RESEARCH_SOURCE_RATE_LIMITED');
    }
    if (response.status === 501) fail('filing_service_unavailable');
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (mime !== 'application/json') fail(response.status === 404 ? 'filing_service_unavailable' : response.ok ? 'invalid_data' : 'RESEARCH_SOURCE_UNAVAILABLE');
    const length = response.headers.get('Content-Length');
    if (length && /^\d+$/.test(length) && Number(length) > FILING_RESPONSE_LIMIT) fail('too_large');
    reader = response.body?.getReader(); if (!reader) fail('stream_unavailable');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await abortable(reader!.read(), controller.signal, error);
      if (controller.signal.aborted) throw error();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new CompanyResearchError('invalid_data');
      size += chunk.value.byteLength; if (size > FILING_RESPONSE_LIMIT) throw new CompanyResearchError('too_large'); chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CompanyResearchError(response.status === 404 ? 'filing_service_unavailable' : 'invalid_data'); }
    if (!response.ok) {
      const code = value !== null && typeof value === 'object' && 'error' in value && value.error !== null && typeof value.error === 'object' && 'code' in value.error ? value.error.code : null;
      throw new CompanyResearchError(typeof code === 'string' && knownCodes.has(code) ? code : response.status === 404 ? 'filing_service_unavailable' : 'RESEARCH_SOURCE_UNAVAILABLE');
    }
    return decode(value);
  } catch (e) {
    if (controller.signal.aborted) throw error();
    if (e instanceof CompanyResearchError) throw e;
    throw new CompanyResearchError('network');
  } finally {
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    clearTimeout(timer); options.signal.removeEventListener('abort', cancel); controller.abort();
  }
}
export function listCompanyFilings(issuerId: string, options: FilingRequestOptions): Promise<FilingCatalog> {
  if (!isFilingIssuerId(issuerId)) return Promise.reject(new CompanyResearchError('invalid_issuer'));
  return request(`/v1/research/filings?${new URLSearchParams({ issuer_id: issuerId })}`, options, value => decodeFilingCatalog(value, issuerId));
}
export function readCompanyFiling(issuerId: string, accession: string, options: FilingPageOptions): Promise<FilingDocument> {
  const cik = issuerId.slice(4), offset = options.offset ?? 0, expected = options.expectedSha256;
  if (!isFilingIssuerId(issuerId) || !isFilingCik(cik) || !isFilingAccession(accession) || !Number.isSafeInteger(offset) || offset < 0 || offset >= 2_000 || expected !== undefined && !/^[a-f0-9]{64}$/.test(expected) || offset > 0 && expected === undefined) return Promise.reject(new CompanyResearchError('invalid_issuer'));
  const query = new URLSearchParams({ offset: String(offset), ...(expected === undefined ? {} : { expected_sha256: expected }) });
  return request(`/v1/research/filings/${cik}/${accession}?${query}`, options, value => {
    const result = decodeFilingDocument(value, issuerId, accession, offset);
    if (expected !== undefined && result.sha256 !== expected) throw new CompanyResearchError('RESEARCH_DOCUMENT_CHANGED');
    return result;
  });
}

export function filingErrorText(error: unknown, locale: 'zh' | 'en'): string {
  const code = error instanceof CompanyResearchError ? error.code : 'network';
  const labels: Record<string, [string, string]> = {
    filing_service_unavailable: ['当前服务器尚未提供财报原文读取。', 'This server does not provide filing text yet.'],
    RESEARCH_FILING_NOT_FOUND: ['此文件不在可核验的最近申报范围内，请刷新文件目录。', 'This filing is outside the verified recent window. Refresh the filing list.'],
    RESEARCH_SOURCE_UNAVAILABLE: ['暂时无法读取官方来源，请稍后再试。', 'The official source is unavailable. Try later.'],
    RESEARCH_SOURCE_RATE_LIMITED: ['请求较多，请稍后再试。', 'Too many research requests. Please try later.'],
    RESEARCH_SOURCE_TIMEOUT: ['官方来源响应超时，请稍后重试。', 'The official source timed out. Try later.'],
    RESEARCH_SOURCE_INVALID: ['原文身份或格式核验未通过。', 'The source identity or format could not be verified.'],
    RESEARCH_SOURCE_TOO_LARGE: ['原文超过安全读取范围，可前往官方文件核对。', 'The source exceeds the reading limit. Inspect the official filing.'],
    RESEARCH_DOCUMENT_CHANGED: ['原文版本已变化，请重新打开文件后继续阅读。', 'The source document changed. Reopen it before continuing.'],
    cancelled: ['读取已取消。', 'Reading cancelled.'], network: ['暂时无法连接，请稍后再试。', 'Cannot connect. Try later.'],
    invalid_data: ['原文响应校验未通过。', 'The filing response could not be verified.'], too_large: ['原文响应超过读取上限。', 'The filing response exceeds the reading limit.'],
    redirect: ['原文来源跳转未获接受。', 'The source redirect was rejected.'], stream_unavailable: ['当前环境无法安全读取原文。', 'This environment cannot safely read the filing.'],
  };
  return (labels[code] ?? labels.invalid_data)[locale === 'zh' ? 0 : 1];
}
