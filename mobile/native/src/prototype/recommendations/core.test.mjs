import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const core = await import('./core.ts');
test.after(() => resolver.deregister());
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const candidate = { id: 'module:market-data', title: '公开金融数据', description: '查询市场资料', reason: '可查询相关资料', kind: 'module', access: 'ready',
  connection_id: null, connection_revision: null, module: 'market-data', provider_id: null, bank_id: null, capability_version: 'v1', price_note: null };
const record = { id, conversation_id: other, source_message_id: 'user-1', status: 'complete', candidates: [candidate], catalog_version: 'v1', created_at: '2026-11-08T00:00:00Z', expires_at: '2026-11-09T00:00:00Z' };
const user = { id: 'user-1', role: 'user', content: 'Query bitcoin', status: 'complete' };
const conversation = { id: other, title: 'Question', messages: [user, { id: 'answer-1', role: 'assistant', content: 'Answer', status: 'complete' }] };

test('invalidated cards offer a new request instead of an impossible authorization loop', () => {
  assert.match(core.recommendationError('RECOMMENDATION_STALE', (zh) => zh), /重新描述需求/);
  assert.match(core.recommendationError('RECOMMENDATION_STALE', (_zh, en) => en), /Describe your request again/);
  assert.doesNotMatch(core.recommendationError('RECOMMENDATION_STALE', (_zh, en) => en), /Review it on the Plugins page/);
  assert.match(core.recommendationError('PLUGIN_RECONFIRM_REQUIRED', (zh) => zh), /确认后/);
});

test('strict wire decoding bounds text, candidate counts, identity and lifecycle fields', () => {
  assert.deepEqual(core.decodeRecommendation(record), record);
  assert.deepEqual(core.decodeRecommendationPage({ items: [record], next_cursor: null }).items, [record]);
  for (const value of [
    { ...record, candidates: [candidate, candidate] }, { ...record, candidates: Array(4).fill(candidate) },
    { ...record, id: '../other' }, { ...record, expires_at: record.created_at }, { ...record, status: 'pending' }, { ...record, status: 'skipped' },
    { ...record, candidates: [{ ...candidate, access: 'execute' }] }, { ...record, candidates: [{ ...candidate, title: '\u202eConfused' }] },
    { ...record, candidates: [{ ...candidate, connection_id: 'secret' }] }, { ...record, candidates: [{ ...candidate, connection_revision: -1 }] },
  ]) assert.throws(() => core.decodeRecommendation(value), error => error.code === 'INVALID_RESPONSE');
});

test('selection accepts a regular public-query chat and rejects mismatched plugin authority', () => {
  const detail = { ...conversation, id, revision: 1, updated_at: record.created_at, messages: [user] };
  assert.equal(core.decodeSelection({ kind: 'conversation', candidate, conversation: detail, created: true }).conversation.id, id);
  const pluginCandidate = { ...candidate, kind: 'plugin', connection_id: id };
  assert.throws(() => core.decodeSelection({ kind: 'conversation', candidate: pluginCandidate, conversation: detail, created: true }));
  assert.throws(() => core.decodeSelection({ kind: 'navigate', candidate, conversation: detail, created: true }));
  assert.throws(() => core.decodeSelection({ kind: 'conversation', candidate, conversation: { ...detail, messages: [{ ...user, localFinance: true }] }, created: true }));
  assert.equal(core.canContinueRecommendation(detail), true);
  assert.equal(core.canContinueRecommendation(conversation), false, 'an existing answer is never replayed');
  assert.equal(core.canContinueRecommendation({ ...detail, messages: [{ ...user, status: 'pending' }] }), false);
});

test('a source user turn appears only below its final answer and existing app actions win', () => {
  const records = { [record.id]: record };
  assert.equal(core.recommendationUnderAnswer(conversation, user.id, records), null);
  assert.equal(core.recommendationUnderAnswer(conversation, 'answer-1', records), record);
  const continued = { ...conversation, messages: [...conversation.messages, { id: 'answer-2', role: 'assistant', content: 'Continuation', status: 'complete' }] };
  assert.equal(core.recommendationUnderAnswer(continued, 'answer-1', records), null);
  assert.equal(core.recommendationUnderAnswer(continued, 'answer-2', records), record);
  assert.deepEqual(core.visibleCandidates(record, [{ module: 'market-data', label: 'Existing result' }]), []);
  assert.equal(core.visibleCandidates(record, [{ module: 'wallet', label: 'Other capability' }]).length, 1);
  assert.deepEqual(core.visibleCandidates(record, [], ['market-data']), []);
  assert.equal(core.visibleCandidates(record, [], ['insurance']).length, 1);
});

test('completed public query types suppress recommendations even without navigation actions', () => {
  const success = { text: 'Read result', actions: [] };
  assert.equal(core.completedRecommendationModule({ name: 'market_query', arguments: { kind: 'crypto', asset: 'BTC' } }, success), 'market-data');
  assert.equal(core.completedRecommendationModule({ name: 'company_search', arguments: { query: 'Toyota' } }, success), 'market-data');
  assert.equal(core.completedRecommendationModule({ name: 'insurance_search', arguments: { query: 'medical' } }, success), 'insurance');
  assert.equal(core.completedRecommendationModule({ name: 'app_info', arguments: { module: 'all' } }, success), null);
  for (const data of [{ success: false }, { pending: true }]) assert.equal(core.completedRecommendationModule({ name: 'market_query' }, { ...success, data }), null);
});

test('bounded recovery supersedes a source turn without treating saved cards as permission', () => {
  const skipped = { ...record, id: other, status: 'skipped', candidates: [] };
  assert.deepEqual(Object.values(core.mergeRecommendations({ [id]: record }, [skipped])), [skipped]);
  const entries = Array.from({ length: 120 }, (_, index) => ({ ...record, id: `record-${index}`, source_message_id: `source-${index}` }));
  assert.equal(Object.keys(core.mergeRecommendations({}, entries)).length, 100);
  assert.deepEqual(core.decodePending({ recordId: id, candidateId: candidate.id, sourceConversationId: other, token: 'must not persist', prompt: 'private' }), { recordId: id, candidateId: candidate.id, sourceConversationId: other });
  assert.throws(() => core.decodePending({ recordId: id, candidateId: candidate.id, sourceConversationId: 'other-owner' }));
});

test('navigation keeps known modules and only prefills supported query conditions', () => {
  const insurance = core.recommendationNavigation({ ...candidate, module: 'insurance' }, '医疗保险\n'.repeat(80));
  assert.equal(insurance.module, 'insurance'); assert.ok(Array.from(insurance.query).length <= 120); assert.equal(insurance.query.includes('\n'), false);
  assert.equal(core.recommendationNavigation({ ...candidate, module: 'https://evil.invalid' }, 'private'), null);
  assert.equal(core.recommendationNavigation(candidate, 'private').query, undefined);
});
