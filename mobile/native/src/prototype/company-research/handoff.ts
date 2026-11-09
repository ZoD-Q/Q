import { validateCompanyQuery, validateIssuerId, type CompanyResearchReport, type CompanySearchReport } from './core';
import { isFilingAccession, isFilingIssuerId, type FilingCatalog, type FilingDocument } from './filings-core';

type CompanyResult = CompanySearchReport | CompanyResearchReport;
type FilingResult = FilingCatalog | FilingDocument;
type PublicResult = CompanyResult | FilingResult;
type Entry = { result: PublicResult; expiresAt: number };
const results = new Map<string, Entry>();
const RESULT_LIMIT = 8;
const RESULT_LIFETIME_MS = 5 * 60_000;
const queryKey = (query: string) => query.normalize('NFKC').trim().toLowerCase();
const copy = <T extends PublicResult>(result: T): T => JSON.parse(JSON.stringify(result)) as T;

function discardExpired(now: number) {
  for (const [key, value] of results) if (value.expiresAt <= now) results.delete(key);
}

function remember(key: string, result: PublicResult) {
  const now = Date.now();
  discardExpired(now);
  results.delete(key);
  results.set(key, { result: copy(result), expiresAt: now + RESULT_LIFETIME_MS });
  while (results.size > RESULT_LIMIT) {
    const oldest = results.keys().next().value;
    if (oldest === undefined) break;
    results.delete(oldest);
  }
}

/** Public results only: a short, bounded handoff to the page, never persistent storage. */
export function rememberCompanyResult(result: CompanyResult): void {
  const key = result.kind === 'company-search'
    ? validateCompanyQuery(result.query) ? `query:${queryKey(result.query)}` : null
    : validateIssuerId(result.issuerId) ? `issuer:${result.issuerId}` : null;
  if (key) remember(key, result);
}

export function rememberCompanyFilingResult(result: FilingResult): void {
  if (!isFilingIssuerId(result.issuer_id)) return;
  if ('filings' in result) remember(`filings:${result.issuer_id}`, result);
  else if (isFilingAccession(result.filing.accession)) remember(`filing:${result.issuer_id}:${result.filing.accession}`, result);
}

/** Reads never refresh the lifetime or trigger a query. An issuer takes precedence. */
export function readCompanyResult({ query, issuerId }: { query?: string; issuerId?: string }): CompanyResult | null {
  discardExpired(Date.now());
  if (query !== undefined && !validateCompanyQuery(query) || issuerId !== undefined && !validateIssuerId(issuerId)) return null;
  if (issuerId) {
    const newest = [...results.values()].reverse().flatMap(entry => 'kind' in entry.result ? [entry.result] : []);
    const research = newest.find(result => result.kind === 'company-research'
      && (result.issuerId === issuerId || result.company?.issuerId === issuerId));
    if (research) return copy(research);
    const search = newest.find(result => result.kind === 'company-search'
      && result.candidates.some(candidate => candidate.issuerId === issuerId));
    return search ? copy(search) : null;
  }
  const cached = query ? results.get(`query:${queryKey(query)}`) : undefined;
  return cached && 'kind' in cached.result ? copy(cached.result) : null;
}

export function readCompanyFilingResult({ issuerId, accession }: { issuerId: string; accession?: string }): FilingResult | null {
  discardExpired(Date.now());
  if (!isFilingIssuerId(issuerId) || accession !== undefined && !isFilingAccession(accession)) return null;
  const cached = results.get(accession ? `filing:${issuerId}:${accession}` : `filings:${issuerId}`);
  return cached && !('kind' in cached.result) ? copy(cached.result) : null;
}

export function forgetCompanyFilingResult({ issuerId, accession }: { issuerId: string; accession: string }): void {
  if (isFilingIssuerId(issuerId) && isFilingAccession(accession)) results.delete(`filing:${issuerId}:${accession}`);
}

export function clearCompanyResults(): void { results.clear(); }
