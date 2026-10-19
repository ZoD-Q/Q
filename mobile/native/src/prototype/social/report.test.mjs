import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { SocialError } from './core.ts';

const resolver = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './core' && context.parentURL?.includes('/prototype/social/')) return next('./core.ts', context);
  return next(specifier, context);
} });
const { createReportStore, inspectReportReceipt, isFinalReportRejection, recoverReportRequest } = await import('./report-core.ts');
const { decodeReportReceipt, socialRequest } = await import('./api.ts');
resolver.deregister();

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const reportId = '33333333-3333-4333-8333-333333333333', messageId = '44444444-4444-4444-8444-444444444444';
const hash = async value => createHash('sha256').update(value).digest('hex');
const request = { client_report_id: reportId, user_id: other, message_id: messageId, reason: '测试原因', include_evidence: true };
const receipt = { client_report_id: reportId, status: 'accepted', expires_at: '2026-11-18T00:00:00Z', server_time: '2026-10-19T00:00:00Z' };
function memory() {
  const values = new Map();
  return { values, adapter: { get: async key => values.get(key) ?? null, set: async (key, value) => { assert.ok(Buffer.byteLength(value) <= 2048); values.set(key, value); }, remove: async key => { values.delete(key); } } };
}

test('native report persistence restores the exact consent, reason and original UUID after restart', async () => {
  const memoryStore = memory(), initial = createReportStore(memoryStore.adapter, hash, true), full = { ...request, reason: '😀'.repeat(500) };
  await initial.save(owner, full);
  const restarted = createReportStore(memoryStore.adapter, hash, true), pending = await restarted.read(owner);
  assert.deepEqual(await recoverReportRequest(pending, owner, pending.reason, hash), full);
  const metadata = await restarted.meta(owner);
  assert.equal('reason' in metadata, false);
  assert.equal(await restarted.read(other), null);
  await assert.rejects(recoverReportRequest(pending, other, full.reason, hash), { code: 'UNAUTHORIZED' });
  await assert.rejects(restarted.save(owner, { ...full, client_report_id: messageId }), { code: 'PENDING_REPORT_EXISTS' });
  await assert.rejects(restarted.save(owner, { ...full, include_evidence: false }), { code: 'PENDING_REPORT_EXISTS' });
  await restarted.remove(owner, messageId); assert.ok(await restarted.read(owner));
  await restarted.remove(owner, reportId); assert.equal(memoryStore.values.size, 0);
});

test('Web report persistence contains no reason or evidence body; a retry must match the original reason digest', async () => {
  const memoryStore = memory(), store = createReportStore(memoryStore.adapter, hash, false);
  await store.save(owner, { ...request, evidence_body: 'must not persist' });
  const raw = [...memoryStore.values.values()].join('');
  assert.ok(!raw.includes(request.reason)); assert.ok(!raw.includes('must not persist'));
  const restarted = createReportStore(memoryStore.adapter, hash, false), pending = await restarted.read(owner);
  assert.equal(pending.reason, null);
  await assert.rejects(recoverReportRequest(pending, owner, '另一个原因', hash), { code: 'REPORT_REASON_MISMATCH' });
  assert.deepEqual(await recoverReportRequest(pending, owner, request.reason, hash), request);
  assert.equal(pending.clientReportId, reportId);
});

test('restart recovery checks a report receipt without resubmitting or exposing the original reason', async () => {
  const memoryStore = memory(), store = createReportStore(memoryStore.adapter, hash, false); await store.save(owner, request);
  const restarted = createReportStore(memoryStore.adapter, hash, false), pending = await restarted.read(owner);
  let calls = 0;
  const lookup = clientId => socialRequest({ baseUrl: 'https://example.com', path: `/v1/social/reports/by-client/${clientId}`, token: 'opaque', decode: decodeReportReceipt,
    transport: async (url, options) => { calls++; assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.ok(!url.includes(request.reason)); return Response.json(receipt); } });
  assert.equal(await inspectReportReceipt(pending, owner, lookup), 'accepted'); assert.equal(calls, 1);
  await restarted.remove(owner, pending.clientReportId); assert.equal(await restarted.meta(owner), null);
});

test('unknown or expired report outcomes preserve identity and never create another report', async () => {
  const memoryStore = memory(), store = createReportStore(memoryStore.adapter, hash, false), pending = await store.save(owner, request);
  assert.equal(await inspectReportReceipt(pending, owner, async () => { throw new SocialError('SOCIAL_NOT_FOUND', 404); }), 'unknown');
  assert.equal((await store.meta(owner)).clientReportId, reportId);
  assert.equal(await inspectReportReceipt(pending, owner, async () => { throw new SocialError('SOCIAL_REPORT_EXPIRED', 410); }), 'expired');
  let called = false;
  await assert.rejects(inspectReportReceipt(pending, other, async () => { called = true; return receipt; }), { code: 'UNAUTHORIZED' });
  assert.equal(called, false);
  await assert.rejects(inspectReportReceipt(pending, owner, async () => ({ ...receipt, client_report_id: messageId })), { code: 'INVALID_RESPONSE' });
  await assert.rejects(inspectReportReceipt(pending, owner, async () => { throw new SocialError('NETWORK_ERROR'); }), { code: 'NETWORK_ERROR' });
});

test('a report manifest whose write rejected after commit is still recoverable with its original ID', async () => {
  const memoryStore = memory(); let reject = true;
  const store = createReportStore({ ...memoryStore.adapter, set: async (key, value) => {
    await memoryStore.adapter.set(key, value);
    if (reject && key === `q.social.report.v1.${owner}`) { reject = false; throw new Error('lost storage acknowledgement'); }
  } }, hash, true);
  await assert.rejects(store.save(owner, request));
  assert.equal((await store.read(owner)).clientReportId, reportId);
  await assert.rejects(store.save(owner, { ...request, client_report_id: messageId }), { code: 'PENDING_REPORT_EXISTS' });
});

test('expired or forbidden evidence is a definitive POST rejection; cleanup never drops unknown outcomes', async () => {
  const memoryStore = memory(), store = createReportStore(memoryStore.adapter, hash, false);
  for (const [code, status] of [['SOCIAL_MESSAGE_EXPIRED', 410], ['SOCIAL_REPORT_EXPIRED', 410], ['SOCIAL_FORBIDDEN', 403]]) {
    const pending = await store.save(owner, request);
    const error = new SocialError(code, status);
    assert.equal(isFinalReportRejection(error), true);
    await store.remove(owner, messageId); assert.equal((await store.meta(owner)).clientReportId, reportId);
    if (isFinalReportRejection(error)) await store.remove(owner, pending.clientReportId);
    assert.equal(await store.meta(owner), null);
  }
  for (const error of [new SocialError('NETWORK_ERROR'), new SocialError('RATE_LIMITED', 429), new SocialError('UNAUTHORIZED', 401), new SocialError('IDEMPOTENCY_CONFLICT', 409), new SocialError('SOCIAL_MESSAGE_EXPIRED', 500), new SocialError('SOCIAL_BLOCKED', 403)]) assert.equal(isFinalReportRejection(error), false);
});
