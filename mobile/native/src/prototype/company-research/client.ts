import { CompanyResearchError, SEC_DIRECTORY, buildCompanyResearchText, calculateFacts, entityUrl, factsUrl, parseDirectory, parseEntity, parseFinancialFacts, parseSubmissions, record, submissionsUrl, validateCompanyQuery, validateIssuerId } from './core';
import type { CompanyCandidate, CompanyResearchReport, CompanySearchReport, SourceName, SourceStatus } from './core';
export { buildCompanyResearchText, validateCompanyQuery, validateIssuerId, CompanyResearchError };
export type { CompanyCandidate, CompanyResearchReport, CompanySearchReport };
export type CompanyRequestOptions = { signal: AbortSignal; transport: typeof fetch };
export const COMPANY_TIMEOUT_MS = 12_000;
export const COMPANY_FACTS_LIMIT = 12 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
// Shared by requests using the same transport; no stored queries or responses.
const hostLimits = new WeakMap<typeof fetch, Map<string, { next: number; blockedUntil: number }>>();
async function reserveHost(host: string, options: CompanyRequestOptions): Promise<void> {
  const limits = hostLimits.get(options.transport) ?? new Map<string, { next: number; blockedUntil: number }>();
  hostLimits.set(options.transport, limits);
  const state = limits.get(host) ?? { next: 0, blockedUntil: 0 };
  if (Date.now() < state.blockedUntil) throw new CompanyResearchError('rate_limited');
  const delay = Math.max(0, state.next - Date.now());
  state.next = Date.now() + delay + 1000; limits.set(host, state);
  if (delay) await new Promise<void>((resolve, reject) => {
    const finish = () => { options.signal.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(finish, delay);
    const stop = () => { clearTimeout(timer); options.signal.removeEventListener('abort', stop); reject(new CompanyResearchError('cancelled')); };
    if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
  });
  if (Date.now() < state.blockedUntil) throw new CompanyResearchError('rate_limited');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal, error: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(error());
    if (signal.aborted) { void promise.catch(() => undefined); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
async function getJson(url: string, options: CompanyRequestOptions, maxBytes = MAX_JSON): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['www.sec.gov', 'data.sec.gov', 'www.wikidata.org', 'query.wikidata.org'].includes(u.hostname) || u.username || u.password || u.port) throw new CompanyResearchError('invalid_source');
  if (options.signal.aborted) throw new CompanyResearchError('cancelled');
  await reserveHost(u.hostname, options);
  if (options.signal.aborted) throw new CompanyResearchError('cancelled');
  const controller = new AbortController(); let timeout = false;
  const error = () => new CompanyResearchError(timeout ? 'timeout' : 'cancelled');
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timeout = true; cancel(); }, COMPANY_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const pending = options.transport(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'Q-Public-Research/0.1 (+https://q.kaicloudpay.com)' } }).then(response => {
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw error(); } return response;
    });
    const response = await abortable(pending, controller.signal, error);
    const fail = (code: string): never => { void response.body?.cancel().catch(() => undefined); throw new CompanyResearchError(code); };
    if (response.redirected || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400 || response.url && response.url !== url) fail('redirect');
    if (!response.ok) {
      if (response.status === 429) {
        const value = response.headers.get('Retry-After') ?? '';
        const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
        const state = hostLimits.get(options.transport)?.get(u.hostname);
        if (state) state.blockedUntil = Date.now() + Math.max(60_000, Number.isFinite(ms) ? Math.min(ms, 86_400_000) : 60_000);
      }
      fail(response.status === 429 ? 'rate_limited' : `http_${response.status}`);
    }
    if (!['application/json', 'application/sparql-results+json'].includes(response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '')) fail('invalid_data');
    const length = response.headers.get('Content-Length');
    if (length && Number(length) > maxBytes) fail('too_large');
    reader = response.body?.getReader(); if (!reader) fail('stream_unavailable');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const chunk = await abortable(reader!.read(), controller.signal, error);
      if (controller.signal.aborted) throw error();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new CompanyResearchError('invalid_data');
      size += chunk.value.byteLength; if (size > maxBytes) throw new CompanyResearchError('too_large'); chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CompanyResearchError('invalid_data'); }
  } catch (e) {
    if (controller.signal.aborted) throw error();
    if (e instanceof CompanyResearchError) throw e;
    throw new CompanyResearchError('network');
  } finally {
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    clearTimeout(timer); options.signal.removeEventListener('abort', cancel); controller.abort();
  }
}
async function source<T>(statuses: SourceStatus[], name: SourceName, url: string, options: CompanyRequestOptions, parse: (data: unknown) => T, maxBytes?: number): Promise<T | null> {
  try { const value = parse(await getJson(url, options, maxBytes)); statuses.push({ source: name, status: 'available', url }); return value; }
  catch (e) { if (options.signal.aborted) throw new CompanyResearchError('cancelled'); statuses.push({ source: name, status: 'error', url, error: e instanceof CompanyResearchError ? e.code : 'invalid_data' }); return null; }
}
const publicGaps = ['Global candidate directory is incomplete; company type and current listing status are not independently verified.', 'SEC coverage is limited to EDGAR issuers. Other markets may have directory entries but no financial reports connected.', 'Anonymous requests expose the search term and network address to the selected public sources; browser CORS or source limits may prevent access.'];
function idsFromSearch(data: unknown): string[] {
  if (!record(data) || !Array.isArray(data.search)) throw new CompanyResearchError('invalid_data');
  return data.search.slice(0, 6).flatMap(v => record(v) && typeof v.id === 'string' && /^Q[1-9][0-9]{0,15}$/.test(v.id) ? [v.id] : []);
}
function idsFromQuery(data: unknown): string[] {
  if (!record(data) || !record(data.results) || !Array.isArray(data.results.bindings)) throw new CompanyResearchError('invalid_data');
  return data.results.bindings.slice(0, 6).flatMap(v => {
    const id = record(v) && record(v.item) && typeof v.item.value === 'string' ? v.item.value.match(/^https?:\/\/www.wikidata.org\/entity\/(Q[1-9][0-9]{0,15})$/)?.[1] : null;
    return id ? [id] : [];
  });
}
export async function searchCompanies(query: string, options: CompanyRequestOptions): Promise<CompanySearchReport> {
  if (!validateCompanyQuery(query)) throw new CompanyResearchError('invalid_query');
  const report: CompanySearchReport = { kind: 'company-search', query: query.trim(), fetchedAt: new Date().toISOString(), candidates: [], sources: [], gaps: [...publicGaps, 'Results are bounded to 12 SEC and 6 Wikidata candidates; no result does not establish that an issuer does not exist.'] };
  const q = query.trim();
  const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=${/[\u3400-\u9fff]/u.test(q) ? 'zh' : 'en'}&uselang=en&type=item&limit=6&format=json&origin=*`;
  const ticker = q.includes(':') ? q.slice(q.lastIndexOf(':') + 1) : q;
  const tickerLike = /^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/.test(ticker);
  const sparql = `SELECT DISTINCT ?item WHERE { ?item p:P414 ?s . ?s pq:P249 ${JSON.stringify(ticker.toUpperCase())} . } LIMIT 6`;
  const tickerUrl = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  const results = await Promise.all([
    source(report.sources, 'sec-directory', SEC_DIRECTORY, options, data => parseDirectory(data, q)),
    source(report.sources, 'wikidata-search', searchUrl, options, idsFromSearch),
    tickerLike ? source(report.sources, 'wikidata-ticker', tickerUrl, options, idsFromQuery) : Promise.resolve([]),
  ]);
  report.candidates.push(...(results[0] ?? []));
  const ids = [...new Set([...(results[2] ?? []), ...(results[1] ?? [])])].slice(0, 6);
  // Bounded batches avoid flooding the public entity service; each candidate is validated before display.
  for (let i = 0; i < ids.length; i += 2) {
    const batch = await Promise.all(ids.slice(i, i + 2).map(id => source(report.sources, 'wikidata-entity', entityUrl(id), options, data => parseEntity(data, id))));
    for (const item of batch) if (item && item.candidate.listings.length) report.candidates.push(item.candidate);
  }
  if (q.includes(':')) report.gaps.push('SEC exchange filters use exchange names. Wikidata exchange IDs are shown as candidates; verify the requested venue before choosing.');
  report.fetchedAt = new Date().toISOString(); return report;
}
export async function researchCompany(issuerId: string, options: CompanyRequestOptions): Promise<CompanyResearchReport> {
  if (!validateIssuerId(issuerId)) throw new CompanyResearchError('invalid_issuer');
  const report: CompanyResearchReport = { kind: 'company-research', issuerId, fetchedAt: new Date().toISOString(), company: null, sources: [], facts: [], calculations: [], gaps: [...publicGaps, 'Financial overview uses standard whole-entity XBRL facts, not the full annual-report narrative or custom tags.', 'Only annual filings in the SEC recent submission window are used; older history and prior balance-sheet dates absent from this window are not fetched. Missing values are unavailable, never zero.'] };
  let cik: string | null = issuerId.startsWith('sec:') ? issuerId.slice(4) : null;
  let mapped: ReturnType<typeof parseEntity> | undefined;
  if (!cik) {
    const id = issuerId.slice(9);
    const entity = await source(report.sources, 'wikidata-entity', entityUrl(id), options, data => parseEntity(data, id));
    if (!entity) return report;
    mapped = entity; report.company = entity.candidate; cik = entity.candidate.cik;
    if (!entity.candidate.listings.length) { report.gaps.push('No validated exchange/ticker candidate exists for this entity.'); return report; }
    if (!cik) { report.gaps.push('No unique SEC CIK mapping; this issuer’s financial reports are not connected.'); return report; }
  }
  const verifiedCik = cik;
  const submissions = await source(report.sources, 'sec-submissions', submissionsUrl(cik), options, data => ({ raw: data, company: parseSubmissions(data, verifiedCik, mapped) }));
  if (!submissions) { report.gaps.push('SEC identity could not be verified; financial facts were not requested.'); return report; }
  report.company = mapped ? { ...submissions.company, issuerId, sourceUrl: mapped.candidate.sourceUrl } : submissions.company;
  const facts = await source(report.sources, 'sec-facts', factsUrl(cik), options, data => parseFinancialFacts(data, verifiedCik, submissions.raw), COMPANY_FACTS_LIMIT);
  report.facts = facts ?? []; report.calculations = calculateFacts(report.facts);
  if (!report.facts.length) report.gaps.push('No supported, verified annual financial facts available; no financial conclusion can be drawn.');
  if (!report.facts.some(f => f.metric === 'revenue')) report.gaps.push('Revenue is unavailable; industry-specific revenue concepts are not inferred.');
  report.fetchedAt = new Date().toISOString(); return report;
}
