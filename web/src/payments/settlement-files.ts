/** Bounded local evidence validation. No requests, storage, logging, or document rendering. */
export const MAPPING_MAX_BYTES = 128 * 1024;
export const SOURCE_MAX_BYTES = 256 * 1024;
export type SettlementKind = 'order_reconciliation' | 'bank_settlement' | 'hkd_reserve';
export type SourceMedia = 'application/pdf' | 'text/csv';
export type SettlementRow = {
  entry_kind: 'payment' | 'refund'; refund_external_reference: string | null;
  merchant_order_no: string; provider_trade_no: string;
  gross_minor: number; channel_fee_minor: number; net_minor: number;
};
export type SettlementMapping = { currency: 'CNY' | 'HKD'; rows: SettlementRow[] };
export type SettlementImport = {
  client_request_id: string; kind: SettlementKind; source: string;
  bank_reference: string | null; bank_amount_minor: number | null;
  evidence_base64: string; source_document_base64: string; source_document_media_type: SourceMedia;
};
export type PreparedSettlement = {
  body: SettlementImport; mapping: SettlementMapping;
  mappingHash: string; evidenceHash: string; mappingBytes: number; sourceBytes: number;
};
export type SettlementCheck = { check_version: number; matched_count: number; differences: { row: number; code: string }[]; actor_id: string; created_at: string };
export type SettlementCheckPage = { items: SettlementCheck[]; next_cursor: string | null };
export type RecheckIdentity = { settlement_id: string; check_version: number; evidence_sha256: string; mapping_sha256: string };
export function parseSettlementChecks(value: unknown): SettlementCheckPage {
  const page = object(value, ['items', 'next_cursor']);
  requireValue(Array.isArray(page.items) && page.items.length <= 100 && (page.next_cursor === null || (typeof page.next_cursor === 'string' && /^[1-9]\d*$/.test(page.next_cursor) && Number.isSafeInteger(Number(page.next_cursor)))), 'fields');
  const items = page.items.map((value): SettlementCheck => {
    const check = object(value, ['check_version', 'matched_count', 'differences', 'actor_id', 'created_at']);
    requireValue(typeof check.check_version === 'number' && Number.isSafeInteger(check.check_version) && check.check_version >= 1
      && typeof check.matched_count === 'number' && Number.isSafeInteger(check.matched_count) && check.matched_count >= 0 && check.matched_count <= 200
      && typeof check.actor_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(check.actor_id)
      && typeof check.created_at === 'string' && Number.isFinite(Date.parse(check.created_at))
      && Array.isArray(check.differences) && check.differences.length <= 201, 'fields');
    const differences = check.differences.map((value) => {
      const entry = object(value, ['row', 'code']);
      requireValue(typeof entry.row === 'number' && Number.isSafeInteger(entry.row) && entry.row >= 0 && entry.row <= 200
        && typeof entry.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(entry.code), 'fields');
      return { row: entry.row, code: entry.code };
    });
    return { check_version: check.check_version, matched_count: check.matched_count, differences, actor_id: check.actor_id, created_at: check.created_at };
  });
  requireValue(new Set(items.map((item) => item.check_version)).size === items.length, 'fields');
  requireValue(items.every((item, index) => index === 0 || items[index - 1].check_version > item.check_version), 'fields');
  if (page.next_cursor !== null) requireValue(items.length > 0 && String(items.at(-1)?.check_version) === page.next_cursor, 'fields');
  return { items, next_cursor: page.next_cursor as string | null };
}
/** Recovery observes a later check by this actor; it never replays POST or changes evidence. */
export function hasRecheckEvidence(original: RecheckIdentity, current: RecheckIdentity, checks: readonly SettlementCheck[], actor: string): boolean {
  return current.settlement_id === original.settlement_id && current.mapping_sha256 === original.mapping_sha256
    && current.evidence_sha256 === original.evidence_sha256 && current.check_version > original.check_version
    && checks.some((check) => check.actor_id === actor && check.check_version > original.check_version && check.check_version <= current.check_version);
}
export type SettlementFileErrorCode = 'size' | 'json' | 'fields' | 'rows' | 'integer' | 'reference' | 'currency' | 'amount' | 'document' | 'crypto';
export class SettlementFileError extends Error {
  constructor(readonly code: SettlementFileErrorCode) { super(`SETTLEMENT_FILE_${code.toUpperCase()}`); }
}
function requireValue(value: unknown, code: SettlementFileErrorCode): asserts value {
  if (!value) throw new SettlementFileError(code);
}
function bounded(data: Uint8Array, limit: number) {
  requireValue(data.byteLength > 0 && data.byteLength <= limit, 'size');
}
function utf8(data: Uint8Array, code: SettlementFileErrorCode): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new SettlementFileError(code); }
}
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'fields');
  const record = value as Record<string, unknown>;
  requireValue(keys.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => keys.includes(key) || optional.includes(key)), 'fields');
  return record;
}
export function validReference(value: string): boolean {
  return value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 200 && !/[\p{Cc}]/u.test(value);
}
export function parseMinorAmount(value: string, mode: 'positive' | 'signed' = 'positive'): number {
  requireValue((mode === 'signed' ? /^(?:0|-?[1-9]\d*)$/ : /^[1-9]\d*$/).test(value), 'integer');
  const amount = Number(value);
  requireValue(Number.isSafeInteger(amount) && (mode === 'signed' || amount > 0), 'integer');
  return amount;
}

/** JSON.parse alone silently accepts duplicate keys and rounds unsafe numeric literals. */
function checkJsonTokens(text: string): void {
  let offset = 0;
  const space = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue; }
      if (text[offset++] === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new SettlementFileError('json');
  };
  const value = (depth: number): void => {
    requireValue(depth <= 8, 'json'); space();
    const token = text[offset];
    if (token === '{' || token === '[') {
      const end = token === '{' ? '}' : ']';
      const keys = new Set<string>(); offset++; space();
      if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        if (token === '{') {
          space(); requireValue(text[offset] === '"', 'json');
          const key = string(); requireValue(!keys.has(key), 'fields'); keys.add(key);
          space(); requireValue(text[offset++] === ':', 'json');
        }
        value(depth + 1); space();
        if (text[offset] === end) { offset++; return; }
        requireValue(text[offset++] === ',', 'json');
      }
      throw new SettlementFileError('json');
    }
    if (token === '"') { string(); return; }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    requireValue(literal, 'json');
    if (/^-?\d/.test(literal[0])) requireValue(/^(?:0|-?[1-9]\d*)$/.test(literal[0]) && Number.isSafeInteger(Number(literal[0])), 'integer');
    offset += literal[0].length;
  };
  value(0); space(); requireValue(offset === text.length, 'json');
}

export function parseMapping(data: Uint8Array, kind: SettlementKind, bankReference: string | null, bankAmount: number | null): SettlementMapping {
  bounded(data, MAPPING_MAX_BYTES);
  const text = utf8(data, 'json');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SettlementFileError('json'); }
  checkJsonTokens(text);
  const mapping = object(parsed, ['currency', 'rows']);
  requireValue(Array.isArray(mapping.rows) && mapping.rows.length <= 200, 'rows');
  requireValue(['order_reconciliation', 'bank_settlement', 'hkd_reserve'].includes(kind), 'currency');
  const bank = bankReference !== null && validReference(bankReference) && bankAmount !== null && Number.isSafeInteger(bankAmount);
  requireValue(kind === 'hkd_reserve'
    ? mapping.currency === 'HKD' && mapping.rows.length === 0 && bank && bankAmount! > 0
    : mapping.currency === 'CNY' && mapping.rows.length > 0 && (kind === 'order_reconciliation' ? bankReference === null && bankAmount === null : bank), 'currency');
  const orders = new Set<string>(); const trades = new Set<string>();
  const rows = mapping.rows.map((input): SettlementRow => {
    const row = object(input, ['merchant_order_no', 'provider_trade_no', 'gross_minor', 'channel_fee_minor', 'net_minor'], ['entry_kind', 'refund_external_reference']);
    const entryKind = row.entry_kind === undefined ? 'payment' : row.entry_kind;
    const refundReference = row.refund_external_reference ?? null;
    requireValue(entryKind === 'payment' || entryKind === 'refund', 'fields');
    requireValue(entryKind === 'payment' ? refundReference === null : typeof refundReference === 'string' && validReference(refundReference), 'reference');
    requireValue(typeof row.merchant_order_no === 'string' && validReference(row.merchant_order_no)
      && typeof row.provider_trade_no === 'string' && validReference(row.provider_trade_no), 'reference');
    const orderKey = JSON.stringify([entryKind, row.merchant_order_no, refundReference]);
    const tradeKey = JSON.stringify([entryKind, row.provider_trade_no, refundReference]);
    requireValue(!orders.has(orderKey) && !trades.has(tradeKey), 'reference');
    orders.add(orderKey); trades.add(tradeKey);
    const { gross_minor: gross, channel_fee_minor: fee, net_minor: net } = row;
    requireValue(typeof gross === 'number' && Number.isSafeInteger(gross)
      && typeof fee === 'number' && Number.isSafeInteger(fee)
      && typeof net === 'number' && Number.isSafeInteger(net), 'integer');
    requireValue(entryKind === 'payment' ? gross > 0 && fee >= 0 && net >= 0 : gross < 0, 'amount');
    requireValue(BigInt(gross) - BigInt(fee) === BigInt(net), 'amount');
    return { entry_kind: entryKind, refund_external_reference: refundReference as string | null, merchant_order_no: row.merchant_order_no, provider_trade_no: row.provider_trade_no, gross_minor: gross, channel_fee_minor: fee, net_minor: net };
  });
  if (kind === 'bank_settlement') requireValue(rows.reduce((sum, row) => sum + BigInt(row.net_minor), 0n) === BigInt(bankAmount!), 'amount');
  return { currency: mapping.currency as 'CNY' | 'HKD', rows };
}

export function validateSourceDocument(data: Uint8Array, media: SourceMedia): void {
  bounded(data, SOURCE_MAX_BYTES);
  if (media === 'application/pdf') requireValue(new TextDecoder().decode(data.subarray(0, 5)) === '%PDF-', 'document');
  else if (media === 'text/csv') utf8(data, 'document');
  else throw new SettlementFileError('document');
}
function base64(data: Uint8Array): string {
  let value = '';
  for (let start = 0; start < data.length; start += 8192) value += String.fromCharCode(...data.subarray(start, start + 8192));
  return btoa(value);
}
async function hash(data: Uint8Array): Promise<string> {
  requireValue(globalThis.crypto?.subtle, 'crypto');
  const result = await crypto.subtle.digest('SHA-256', Uint8Array.from(data));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function prepareSettlement(input: {
  mappingFile: Pick<File, 'size' | 'arrayBuffer'>; sourceFile: Pick<File, 'size' | 'arrayBuffer'>;
  kind: SettlementKind; source: string; media: SourceMedia; bankReference: string | null; bankAmount: number | null; requestId: string;
}): Promise<PreparedSettlement> {
  requireValue(input.mappingFile.size > 0 && input.mappingFile.size <= MAPPING_MAX_BYTES
    && input.sourceFile.size > 0 && input.sourceFile.size <= SOURCE_MAX_BYTES, 'size');
  requireValue(validReference(input.source), 'reference');
  requireValue(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId), 'reference');
  const [mappingBytes, sourceBytes] = await Promise.all([input.mappingFile.arrayBuffer(), input.sourceFile.arrayBuffer()]);
  const normalized = new Uint8Array(mappingBytes); const original = new Uint8Array(sourceBytes);
  const mapping = parseMapping(normalized, input.kind, input.bankReference, input.bankAmount);
  validateSourceDocument(original, input.media);
  const [mappingHash, evidenceHash] = await Promise.all([hash(normalized), hash(original)]);
  return {
    body: { client_request_id: input.requestId, kind: input.kind, source: input.source,
      bank_reference: input.bankReference, bank_amount_minor: input.bankAmount, evidence_base64: base64(normalized),
      source_document_base64: base64(original), source_document_media_type: input.media },
    mapping, mappingHash, evidenceHash, mappingBytes: normalized.byteLength, sourceBytes: original.byteLength,
  };
}
