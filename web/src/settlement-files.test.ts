import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAPPING_MAX_BYTES, SOURCE_MAX_BYTES, parseMapping, parseMinorAmount, prepareSettlement, validateSourceDocument, parseSettlementChecks, hasRecheckEvidence, SettlementFileError } from './payments/settlement-files';

const bytes = (text: string) => new TextEncoder().encode(text);
const row = { merchant_order_no: 'order-1', provider_trade_no: 'trade-1', gross_minor: 10000, channel_fee_minor: 125, net_minor: 9875 };
const mapping = (rows: unknown[] = [row], currency = 'CNY') => bytes(JSON.stringify({ currency, rows }));
const source = bytes('%PDF-1.7\nopaque original evidence\n');
const requestId = '11111111-1111-4111-8111-111111111111';
const file = (data: Uint8Array) => ({ size: data.byteLength, arrayBuffer: async () => Uint8Array.from(data).buffer });
const prepare = (data = mapping()) => prepareSettlement({ mappingFile: file(data), sourceFile: file(source), kind: 'order_reconciliation', source: 'Original statement', media: 'application/pdf', bankReference: null, bankAmount: null, requestId });

test('prepared evidence preserves original bytes and binds independent SHA-256 hashes without rendering content', async () => {
  const raw = bytes('{ "rows": [{"net_minor":9875,"channel_fee_minor":125,"gross_minor":10000,"provider_trade_no":"trade-1","merchant_order_no":"order-1"}], "currency":"CNY" }\n');
  const result = await prepare(raw);
  assert.equal(result.mappingHash, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.evidenceHash, createHash('sha256').update(source).digest('hex'));
  assert.deepEqual(Buffer.from(result.body.evidence_base64, 'base64'), Buffer.from(raw));
  assert.deepEqual(Buffer.from(result.body.source_document_base64, 'base64'), Buffer.from(source));
  assert.equal(result.body.client_request_id, requestId);
  assert.equal(result.mapping.rows[0]?.net_minor, 9875);
});

test('three import kinds keep CNY reconciliation separate from HKD reserve evidence', () => {
  assert.equal(parseMapping(mapping(), 'order_reconciliation', null, null).currency, 'CNY');
  assert.equal(parseMapping(mapping(), 'bank_settlement', 'bank-ref', 9875).rows.length, 1);
  assert.deepEqual(parseMapping(mapping([], 'HKD'), 'hkd_reserve', 'reserve-ref', 200000), { currency: 'HKD', rows: [] });
  for (const attempt of [
    () => parseMapping(mapping(), 'order_reconciliation', 'bank-ref', 9875),
    () => parseMapping(mapping([], 'CNY'), 'order_reconciliation', null, null),
    () => parseMapping(mapping(), 'bank_settlement', null, 9875),
    () => parseMapping(mapping(), 'bank_settlement', 'bank-ref', 9874),
    () => parseMapping(mapping(), 'hkd_reserve', 'bank-ref', 9875),
    () => parseMapping(mapping([row], 'HKD'), 'hkd_reserve', 'bank-ref', 9875),
    () => parseMapping(mapping([], 'HKD'), 'hkd_reserve', 'bank-ref', 0),
  ]) assert.throws(attempt, SettlementFileError);
});

test('reject duplicate JSON keys, unknown fields, noninteger syntax and unsafe amounts before upload', () => {
  const raw = new TextDecoder().decode(mapping());
  for (const invalid of [
    raw.replace('"currency":"CNY"', '"currency":"HKD","currency":"CNY"'),
    raw.replace('"gross_minor":10000', '"gross_minor":9999,"gross_minor":10000'),
    raw.replace('"gross_minor":10000', '"gross_minor":1e4'),
    raw.replace('"gross_minor":10000', '"gross_minor":9007199254740991.1'),
    raw.replace('"gross_minor":10000', '"gross_minor":9007199254740992'),
    raw.replace('"channel_fee_minor":125', '"channel_fee_minor":-1'),
    raw.replace('"net_minor":9875', '"net_minor":9876'),
    raw.replace('"rows":', '"secret":"unaccepted","rows":'),
    raw.replace('"merchant_order_no":"order-1"', '"merchant_order_no":""'),
    raw.replace('"merchant_order_no":"order-1"', '"merchant_order_no":"bad\\nreference"'),
  ]) assert.throws(() => parseMapping(bytes(invalid), 'order_reconciliation', null, null), SettlementFileError);
  assert.throws(() => parseMapping(new Uint8Array([255]), 'order_reconciliation', null, null), SettlementFileError);
  assert.throws(() => parseMapping(bytes('\uFEFF' + raw), 'order_reconciliation', null, null), SettlementFileError);
});

test('reference uniqueness, 200 row limit and integer aggregation cannot silently drop or round money', () => {
  assert.throws(() => parseMapping(mapping([row, row]), 'order_reconciliation', null, null), SettlementFileError);
  const rows = Array.from({ length: 200 }, (_, index) => ({ ...row, merchant_order_no: `order-${index}`, provider_trade_no: `trade-${index}` }));
  assert.equal(parseMapping(mapping(rows), 'bank_settlement', 'bank-ref', 200 * 9875).rows.length, 200);
  assert.throws(() => parseMapping(mapping([...rows, { ...row, merchant_order_no: 'order-201', provider_trade_no: 'trade-201' }]), 'order_reconciliation', null, null), SettlementFileError);
  const huge = [{ ...row, gross_minor: Number.MAX_SAFE_INTEGER, channel_fee_minor: 0, net_minor: Number.MAX_SAFE_INTEGER }, { ...row, merchant_order_no: 'order-2', provider_trade_no: 'trade-2', gross_minor: 1, channel_fee_minor: 0, net_minor: 1 }];
  assert.throws(() => parseMapping(mapping(huge), 'bank_settlement', 'bank-ref', Number.MAX_SAFE_INTEGER), SettlementFileError);
  assert.throws(() => parseMapping(mapping([{ ...row, merchant_order_no: '账'.repeat(67) }]), 'order_reconciliation', null, null), SettlementFileError);
});

test('mapping and source byte limits reject before reading and validate bytes again after reading', async () => {
  let reads = 0;
  const oversized = { size: SOURCE_MAX_BYTES + 1, arrayBuffer: async () => { reads++; return source.buffer; } };
  await assert.rejects(() => prepareSettlement({ mappingFile: file(mapping()), sourceFile: oversized, kind: 'order_reconciliation', source: 'statement', media: 'application/pdf', bankReference: null, bankAmount: null, requestId }), SettlementFileError);
  assert.equal(reads, 0);
  await assert.rejects(() => prepare(new Uint8Array(MAPPING_MAX_BYTES + 1)), SettlementFileError);
  assert.throws(() => validateSourceDocument(new Uint8Array(), 'text/csv'), SettlementFileError);
  assert.throws(() => validateSourceDocument(new Uint8Array(SOURCE_MAX_BYTES + 1), 'text/csv'), SettlementFileError);
  const lyingFile = { size: 1, arrayBuffer: async () => new Uint8Array(MAPPING_MAX_BYTES + 1).buffer };
  await assert.rejects(() => prepareSettlement({ mappingFile: lyingFile, sourceFile: file(source), kind: 'order_reconciliation', source: 'statement', media: 'application/pdf', bankReference: null, bankAmount: null, requestId }), SettlementFileError);
});

test('original documents stay opaque, PDF must have a signature and CSV must be UTF-8', () => {
  validateSourceDocument(source, 'application/pdf');
  validateSourceDocument(bytes('order,amount\n1,100\n'), 'text/csv');
  // Formula text is never evaluated or displayed inline; this remains an attachment.
  validateSourceDocument(bytes('value\n=1+1\n'), 'text/csv');
  assert.throws(() => validateSourceDocument(bytes('<html>fake pdf</html>'), 'application/pdf'), SettlementFileError);
  assert.throws(() => validateSourceDocument(new Uint8Array([255]), 'text/csv'), SettlementFileError);
  assert.equal(parseMinorAmount('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of ['0', '-1', '1.5', '1e3', 'NaN', '9007199254740992', '']) assert.throws(() => parseMinorAmount(value), SettlementFileError);
});

test('payment and refund rows for the same original order coexist with exact signed bank totals', () => {
  const refund = { ...row, entry_kind: 'refund', refund_external_reference: 'original-refund-1', gross_minor: -10000, channel_fee_minor: -125, net_minor: -9875 };
  const zero = parseMapping(mapping([row, refund]), 'bank_settlement', 'bank-zero', 0);
  assert.equal(zero.rows[0]?.entry_kind, 'payment', 'old files still default to payment');
  assert.equal(zero.rows[1]?.entry_kind, 'refund');
  assert.equal(zero.rows[1]?.refund_external_reference, 'original-refund-1');
  assert.equal(zero.rows[1]?.channel_fee_minor, -125, 'a returned fee remains signed');
  const negative = { ...refund, channel_fee_minor: -100, net_minor: -9900 };
  assert.equal(parseMapping(mapping([row, negative]), 'bank_settlement', 'bank-negative', -25).rows.length, 2);
  const positive = { ...refund, channel_fee_minor: -200, net_minor: -9800 };
  assert.equal(parseMapping(mapping([row, positive]), 'bank_settlement', 'bank-positive', 75).rows.length, 2);
  assert.throws(() => parseMapping(mapping([row, negative]), 'bank_settlement', 'bank-negative', 25), SettlementFileError);
  assert.equal(parseMapping(mapping([refund]), 'order_reconciliation', null, null).rows[0]?.net_minor, -9875);
});

test('refund references are mandatory and uniqueness includes entry kind and original refund reference', () => {
  const refund = { ...row, entry_kind: 'refund', refund_external_reference: 'refund-1', gross_minor: -10000, channel_fee_minor: 25, net_minor: -10025 };
  assert.equal(parseMapping(mapping([row, refund, { ...refund, refund_external_reference: 'refund-2' }]), 'order_reconciliation', null, null).rows.length, 3);
  for (const invalid of [
    { ...refund, refund_external_reference: undefined }, { ...refund, refund_external_reference: null },
    { ...refund, refund_external_reference: '' }, { ...refund, refund_external_reference: 'ref\ninvalid' },
    { ...refund, entry_kind: 'reversal' }, { ...refund, entry_kind: null },
    { ...refund, gross_minor: 10000, channel_fee_minor: 25, net_minor: 9975 },
    { ...refund, gross_minor: 0, channel_fee_minor: 25, net_minor: -25 },
    { ...row, entry_kind: 'payment', refund_external_reference: 'refund-1' },
    { ...row, entry_kind: 'payment', channel_fee_minor: -25, net_minor: 10025 },
  ]) assert.throws(() => parseMapping(mapping([invalid]), 'order_reconciliation', null, null), SettlementFileError);
  assert.throws(() => parseMapping(mapping([refund, refund]), 'order_reconciliation', null, null), SettlementFileError);
  assert.throws(() => parseMapping(mapping([refund, { ...refund, provider_trade_no: 'other-trade' }]), 'order_reconciliation', null, null), SettlementFileError);
  assert.throws(() => parseMapping(mapping([refund, { ...refund, merchant_order_no: 'other-order' }]), 'order_reconciliation', null, null), SettlementFileError);
});

test('signed minor bounds remain exact while HKD reserve amounts must stay positive', () => {
  for (const value of ['0', '-25', '25', '-9007199254740991', '9007199254740991']) assert.equal(parseMinorAmount(value, 'signed'), Number(value));
  for (const value of ['-9007199254740992', '9007199254740992', '-1.5', '-1e3', '+1', '-0', '']) assert.throws(() => parseMinorAmount(value, 'signed'), SettlementFileError);
  for (const bankAmount of [0, -1]) assert.throws(() => parseMapping(mapping([], 'HKD'), 'hkd_reserve', 'reserve', bankAmount), SettlementFileError);
  const refund = { ...row, entry_kind: 'refund', refund_external_reference: 'refund-boundary', gross_minor: -Number.MAX_SAFE_INTEGER, channel_fee_minor: 0, net_minor: -Number.MAX_SAFE_INTEGER };
  assert.equal(parseMapping(mapping([refund]), 'bank_settlement', 'bank-boundary', -Number.MAX_SAFE_INTEGER).rows[0]?.net_minor, -Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseMapping(mapping([{ ...refund, channel_fee_minor: 1, net_minor: -9007199254740992 }]), 'bank_settlement', 'bank-boundary', -Number.MAX_SAFE_INTEGER), SettlementFileError);
  const returnedFee = { ...refund, gross_minor: -100, channel_fee_minor: -125, net_minor: 25 };
  assert.equal(parseMapping(mapping([returnedFee]), 'bank_settlement', 'bank-fee-return', 25).rows[0]?.net_minor, 25);
});

test('refund imports hash exact original bytes and duplicate or fractional signed fields remain invalid', async () => {
  const raw = bytes('{"currency":"CNY","rows":[{"entry_kind":"refund","refund_external_reference":"refund-1","merchant_order_no":"order-1","provider_trade_no":"trade-1","gross_minor":-10000,"channel_fee_minor":-125,"net_minor":-9875}]}');
  const result = await prepare(raw);
  assert.equal(result.mappingHash, createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(Buffer.from(result.body.evidence_base64, 'base64'), Buffer.from(raw));
  for (const text of [
    new TextDecoder().decode(raw).replace('"entry_kind":"refund"', '"entry_kind":"payment","entry_kind":"refund"'),
    new TextDecoder().decode(raw).replace('"channel_fee_minor":-125', '"channel_fee_minor":-125.0'),
    new TextDecoder().decode(raw).replace('"gross_minor":-10000', '"gross_minor":-1e4'),
  ]) assert.throws(() => parseMapping(bytes(text), 'order_reconciliation', null, null), SettlementFileError);
});

test('recheck recovery requires immutable documents, a newer version, and the same actor', () => {
  const original = { settlement_id: requestId, check_version: 4, evidence_sha256: 'a'.repeat(64), mapping_sha256: 'b'.repeat(64) };
  const current = { ...original, check_version: 5 };
  const check = { check_version: 5, matched_count: 1, differences: [], actor_id: requestId, created_at: '2026-11-05T02:00:00Z' };
  assert.equal(hasRecheckEvidence(original, current, [check], requestId), true);
  assert.equal(hasRecheckEvidence(original, original, [check], requestId), false);
  assert.equal(hasRecheckEvidence(original, current, [{ ...check, actor_id: 'other' }], requestId), false);
  assert.equal(hasRecheckEvidence(original, current, [{ ...check, check_version: 6 }], requestId), false);
  assert.equal(hasRecheckEvidence(original, current, [{ ...check, check_version: 4 }], requestId), false);
  assert.equal(hasRecheckEvidence(original, { ...current, evidence_sha256: 'c'.repeat(64) }, [check], requestId), false);
  assert.equal(hasRecheckEvidence(original, { ...current, mapping_sha256: 'c'.repeat(64) }, [check], requestId), false);
  assert.equal(hasRecheckEvidence(original, { ...current, settlement_id: 'other' }, [check], requestId), false);
});

test('check history validates bounded difference metadata and keeps its original version cursor', () => {
  const check = { check_version: 3, matched_count: 0, differences: [{ row: 1, code: 'WALLET_NOT_CREDITED' }], actor_id: requestId, created_at: '2026-11-05T02:00:00Z' };
  assert.deepEqual(parseSettlementChecks({ items: [check], next_cursor: '3' }), { items: [check], next_cursor: '3' });
  for (const value of [
    { items: [check, check], next_cursor: null },
    { items: [{ ...check, check_version: 0 }], next_cursor: null },
    { items: [{ ...check, matched_count: 201 }], next_cursor: null },
    { items: [{ ...check, actor_id: 'not-an-actor-id' }], next_cursor: null },
    { items: [{ ...check, differences: [{ row: 201, code: 'OUTSIDE_MAPPING' }] }], next_cursor: null },
    { items: [{ ...check, document_body: 'must not be accepted' }], next_cursor: null },
  ]) assert.throws(() => parseSettlementChecks(value), SettlementFileError);
});
