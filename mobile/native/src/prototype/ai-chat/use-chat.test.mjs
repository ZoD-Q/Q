import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from '../api-workbench/core.ts';

import * as stateModel from './state-model.ts';
import { registerHooks } from 'node:module';
import { createAiStatusMonitor } from './status-monitor.ts';
import { createAiConsentGate, createAiPermission } from './consent.ts';
import { createSessionStore } from '../../services/session-core.ts';
import { getMascotPresentation } from './mascot-state.ts';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const stream = await import('./stream.ts');
const appCore = await import('../app-assistant/core.ts');
const appPresentation = await import('../app-assistant/presentation.ts');
const companyHandoff = await import('../company-research/handoff.ts');
const history = await import('./history.ts');
const pluginCore = await import('../plugin-host/core.ts');
const bankIntent = await import('../banking/intent.ts');
const bankCatalog = await import('../banking/catalog.ts');
const bankData = await import('../banking/data.ts');
const financeConversation = await import('../finance-agent/conversation.ts');
const financeIntent = await import('../finance-agent/intent.ts');
const recommendationCore = await import('../recommendations/core.ts');
test.after(() => resolver.deregister());

const token = 'q_' + 'a'.repeat(43);
const user = { id: '11111111-1111-4111-8111-111111111111', handle: 'fixture', display_name: 'Fixture', avatar: 'orbit', bio: '', theme: 'light', locale: 'en', created_at: '2026-10-21T00:00:00Z' };
const configured = { configured: true, models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] };
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const hookSource = ts.transpileModule(readFileSync(new URL('./use-chat.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

/** Execute the actual hook's async actions with deterministic state/effect plumbing.
 * This verifies orchestration, not React rendering, layout, or native transport. */
function harness({ stored = token, statusFetch = async () => json(configured), meFetch = async () => json(user),
  historyFetch = async () => new Response('', { status: 404 }), historySave, historyDetail, bankFetch, appExecute, recommendationFetch, recommendationPending = null, pendingSave,
} = {}) {
  const appCalls = [];
  const slots = [], calls = [], timers = new Map(), streams = [], streamCompletions = [], streamFailures = [], historyPosts = [], ordering = [];
  let cursor = 0, dirty = true, visible = true, mounted = true, pendingEffects = [], result, now = 0, nextId = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffectEvent(callback) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { event: (...args) => slots[index].callback(...args) };
      slots[index].callback = callback;
      return slots[index].event;
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!slots[index] || dependencies.some((value, position) => value !== slots[index].dependencies[position])) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { dependencies };
        pendingEffects.push(() => { cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const session = createSessionStore({ get: async () => stored, set: async value => { stored = value; }, remove: async () => { stored = null; } });
  const consent = createAiPermission();
  let savedRecommendation = recommendationPending;
  const appListeners = new Set();
  const appState = { currentState: 'active', addEventListener: (_, listener) => { appListeners.add(listener); return { remove: () => appListeners.delete(listener) }; } };
  const imports = {
    react,
    'react-native': { AppState: appState },
    'expo/fetch': { fetch: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method, signal: options.signal, body: options.body });
      if (path.startsWith('/v1/banking/') || path.startsWith('/v1/plugins/')) { ordering.push(path + ':' + options.method); if (bankFetch) return bankFetch(path, options); throw new Error('Unexpected bank action'); }
      if (path === '/v1/ai/status') return statusFetch(options);
      if (path === '/v1/me') return meFetch(options);
      if (path.startsWith('/v1/ai/recommendations')) { ordering.push('recommendation:' + options.method); return recommendationFetch ? recommendationFetch(path, options) : json({ items: [], next_cursor: null }); }
      if (path === '/v1/ai/conversations') return historyFetch(options);
      if (path.startsWith('/v1/ai/conversations/') && options.method === 'GET' && historyDetail) return historyDetail(path.split('/').at(-1), options);
      if (path.startsWith('/v1/ai/conversations/') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        const id = path.split('/').at(-1);
        historyPosts.push({ id, body }); ordering.push('history:POST');
        return historySave ? historySave(id, body, options) : json({ id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at });
      }
      throw new Error('Unexpected network action');
    } },
    'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` },
    '../../services/api': { API_URL: 'https://review.invalid' },
    '../../services/session-store': { ...session, readSessionSnapshot: session.readSnapshot, getSessionRevision: session.getRevision, subscribeSession: session.subscribe },
    '../api-workbench/core': core,
    '../plugin-host/core': pluginCore,
    '../banking/intent': bankIntent,
    '../banking/catalog': bankCatalog,
    '../banking/client': bankData,
    '../finance-agent/conversation': financeConversation,
    '../finance-agent/intent': financeIntent,
    '../app-assistant/core': appCore,
    '../app-assistant/presentation': appPresentation,
    '../company-research/handoff': companyHandoff,
    '../recommendations/core': recommendationCore,
    '../recommendations/pending': {
      readPendingRecommendation: async () => savedRecommendation,
      savePendingRecommendation: async (owner, value) => { if (pendingSave) await pendingSave(owner, value); savedRecommendation = value; },
    },
    '../app-assistant/executor': {
      executeAppCommand: async (command, locale, options) => { appCalls.push({ command, signal: options.signal }); return appExecute ? appExecute(command, locale, options) : appCore.executeLocalAppCommand(command, locale); },
      appResultContext: result => JSON.stringify({ text: result.modelText ?? result.text, data: result.data }),
    },
    './stream': { ...stream, streamChat: options => {
      streams.push(options); ordering.push('chat:POST');
      return new Promise((resolve, reject) => {
        streamCompletions.push(resolve);
        streamFailures.push(reject);
        options.signal.addEventListener('abort', () => reject(new stream.ChatError('CANCELLED')), { once: true });
      });
    } },
    './state-model': stateModel,
    './history': history,
    './consent': { createAiConsentGate: () => createAiConsentGate(consent), hasAiConsent: consent.allows, revokeAiConsent: consent.revoke, subscribeAiConsent: consent.subscribe },
    './status-monitor': {
      initialAiStatus: { phase: 'checking', status: null, error: '' },
      createAiStatusMonitor: options => createAiStatusMonitor({ ...options, schedule: (callback, delay) => {
        const timer = { at: now + delay, callback }; timers.set(timer, timer); return () => timers.delete(timer);
      } }),
    },
  };
  const module = { exports: {} };
  runInNewContext(hookSource, { module, exports: module.exports, require: name => {
    assert.ok(name in imports, `Unmocked module: ${name}`); return imports[name];
  }, AbortController, Error, setTimeout: (callback, delay) => { const timer = { at: now + delay, callback }; timers.set(timer, timer); return timer; }, clearTimeout: timer => timers.delete(timer) });
  const render = () => {
    cursor = 0; dirty = false;
    result = module.exports.useChat(visible);
    const effects = pendingEffects; pendingEffects = [];
    effects.forEach(effect => effect());
    return result;
  };
  render();
  return {
    get current() { return dirty ? render() : result; },
    calls, streams, historyPosts, ordering, appCalls,
    token: () => stored,
    pendingRecommendation: () => savedRecommendation,
    grantConsent: () => consent.grant(stored),
    revokeConsent: () => consent.revoke(),
    changeToken: session.writeToken,
    finishStream(index = 0, content = 'fixture answer') {
      streams[index].onEvent({ type: 'delta', text: content });
      streams[index].onEvent({ type: 'done', model: 'deepseek-flash', finish_reason: 'stop' });
      streamCompletions[index]();
    },
    finishToolStream(proposal, index = 0) {
      streams[index].onEvent({ type: 'tool_proposal', ...proposal });
      streams[index].onEvent({ type: 'done', model: 'deepseek-flash', finish_reason: 'tool_calls' });
      streamCompletions[index]();
    },
    finishAppStream(command, index = 0) {
      streams[index].onEvent({ type: 'app_tool', ...command });
      streams[index].onEvent({ type: 'done', model: 'deepseek-flash', finish_reason: 'tool_calls' });
      streamCompletions[index]();
    },
    failStream(index, code) { streamFailures[index](new stream.ChatError(code)); },
    async flush() { for (let i = 0; i < 80; i++) { await Promise.resolve(); if (dirty && mounted) render(); } },
    setVisible(value) { visible = value; if (mounted) render(); },
    setAppState(value) { appState.currentState = value; for (const listener of appListeners) listener(value); },
    advance(duration) {
      now += duration;
      for (const timer of [...timers.values()].sort((a, b) => a.at - b.at)) if (timer.at <= now && timers.delete(timer)) timer.callback();
    },
    close() { mounted = false; slots.forEach(slot => slot?.cleanup?.()); },
  };
}

test('cold start and closing sign-in cannot turn an in-flight status check into unavailable', async t => {
  const pending = deferred();
  const view = harness({ stored: null, statusFetch: () => pending.promise }); t.after(view.close);
  await view.flush();
  assert.equal(view.current.authBusy, false);
  assert.equal(view.current.session, null);
  assert.equal(view.current.statusPhase, 'checking');
  assert.equal(view.current.statusBusy, true);
  view.current.openAuth(); view.current.closeAuth(); await view.flush();
  assert.equal(view.calls.find(call => call.path === '/v1/ai/status').signal.aborted, false);
  pending.resolve(json(configured)); await view.flush();
  assert.equal(view.current.statusPhase, 'ready');
  assert.equal(view.current.status.configured, true);
  assert.equal(view.calls.length, 1);
});

const recommendedStatus = { ...configured, recommendations_version: 1, app_tools_version: 1 };
const recommendationCandidate = { id: 'module:market-data', title: '公开市场资料', description: '查询市场资料', reason: '可以查询这类资料', kind: 'module', access: 'ready',
  connection_id: null, connection_revision: null, module: 'market-data', provider_id: null, bank_id: null, capability_version: 'fixture-v1', price_note: null };
const recommendationRecord = (body, fields = {}) => ({ id: '44444444-4444-4444-8444-444444444444', conversation_id: body.conversation_id, source_message_id: body.source_message_id,
  status: 'complete', candidates: [recommendationCandidate], catalog_version: 'fixture-v1', created_at: '2026-11-08T00:00:00Z', expires_at: '2026-11-09T00:00:00Z', ...fields });
const childId = '55555555-5555-4555-8555-555555555555';
const childHistory = (content = '查询比特币资料', fields = {}) => ({ id: childId, title: '公开市场资料', revision: 1, updated_at: '2026-11-08T00:00:00Z',
  messages: [{ id: 'child-user', role: 'user', content, status: 'complete' }], ...fields });

test('recommendations start after durable history alongside the answer, including deep thinking', async t => {
  const save = deferred(), recommend = deferred();
  let firstSave;
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    historySave: (id, body) => { if (!firstSave) { firstSave = { id, body }; return save.promise; } return json({ id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at }); },
    recommendationFetch: (_path, options) => options.method === 'POST' ? recommend.promise : json({ items: [], next_cursor: null }),
  }); t.after(view.close);
  await view.flush(); view.grantConsent(); view.current.setThink(true);
  assert.equal(view.current.send('查询比特币资料'), true); await view.flush();
  assert.equal(view.calls.some(call => call.path === '/v1/ai/recommendations' && call.method === 'POST'), false);
  assert.equal(view.streams.length, 0);
  save.resolve(json({ ...firstSave.body, id: firstSave.id, revision: 1, updated_at: user.created_at })); await view.flush();
  const request = view.calls.find(call => call.path === '/v1/ai/recommendations' && call.method === 'POST');
  assert.ok(request); assert.equal(view.streams.length, 1, 'a pending recommendation never blocks the answer');
  assert.equal(view.streams[0].request.thinking, true);
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body).sort(), ['conversation_id', 'locale', 'request_id', 'source_message_id']);
  assert.equal(body.source_message_id, view.current.conversation.messages[0].id);
  recommend.resolve(json(recommendationRecord(body))); await view.flush();
  assert.equal(Object.keys(view.current.recommendations).length, 1);
  view.finishStream(); await view.flush(); assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
});

test('recommendations stay off without version, consent or cloud persistence and never enter local finance', async t => {
  for (const setting of [
    { statusFetch: async () => json(configured), historyFetch: cloudHistory, consent: true },
    { statusFetch: async () => json(recommendedStatus), historyFetch: async () => new Response('', { status: 404 }), consent: true },
    { statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory, consent: false },
  ]) {
    const view = harness(setting); t.after(view.close); await view.flush(); if (setting.consent) view.grantConsent();
    view.current.send('查一查股票行情'); await view.flush();
    assert.equal(view.calls.some(call => call.path === '/v1/ai/recommendations' && call.method === 'POST'), false);
    view.close();
  }
  const local = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory }); t.after(local.close);
  await local.flush(); local.grantConsent();
  local.current.addLocalFinance({ request: 'Private finance', title: 'Private', answer: 'Local result', result: { kind: 'help', content: 'Only local' } });
  await local.flush(); assert.equal(local.calls.some(call => call.path === '/v1/ai/recommendations' && call.method === 'POST'), false);
});

test('stopping, changing conversation, background and account changes abort discovery and reject late cards', async t => {
  for (const exit of ['stop', 'conversation', 'background', 'account']) {
    const pending = deferred();
    const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
      recommendationFetch: (_path, options) => options.method === 'POST' ? pending.promise : json({ items: [], next_cursor: null }),
    }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('比特币价格查询'); await view.flush();
    const request = view.calls.find(call => call.path === '/v1/ai/recommendations' && call.method === 'POST');
    if (exit === 'stop') view.current.stop();
    else if (exit === 'conversation') view.current.newConversation();
    else if (exit === 'background') view.setAppState('background');
    else await view.changeToken('q_' + 'b'.repeat(43));
    await view.flush(); assert.equal(request.signal.aborted, true, exit);
    pending.resolve(json(recommendationRecord(JSON.parse(request.body)))); await view.flush();
    assert.deepEqual(Object.keys(view.current.recommendations), [], exit);
    view.close();
  }
});

test('recommendation failure leaves the answer and its ordinary retry intact without rediscovery', async t => {
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (_path, options) => options.method === 'POST' ? new Response('', { status: 503 }) : json({ items: [], next_cursor: null }),
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('比特币价格查询'); await view.flush();
  assert.equal(view.streams.length, 1); assert.equal(view.current.messageError, '');
  view.failStream(0, 'AI_TIMEOUT'); await view.flush(); view.current.retry(); await view.flush();
  assert.equal(view.streams.length, 2);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/recommendations' && call.method === 'POST').length, 1);
  view.finishStream(1); await view.flush(); assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
});

test('first successful recommendation selection seeds the child revision and continues its existing user turn once', async t => {
  const selection = deferred(); let record;
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (path, options) => {
      if (path.endsWith('/select')) return selection.promise;
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush(); view.finishStream(); await view.flush();
  view.current.setDraft('尚未发送的新想法');
  const first = view.current.selectRecommendation(record.id, recommendationCandidate.id);
  assert.equal(await view.current.selectRecommendation(record.id, recommendationCandidate.id), null, 'rapid clicks share one selection');
  await view.flush();
  assert.equal(view.pendingRecommendation().recordId, record.id, 'recovery identifiers are saved before the request');
  selection.resolve(json({ kind: 'conversation', candidate: recommendationCandidate, conversation: childHistory(), created: true }));
  await first; await view.flush();
  assert.equal(view.current.activeId, childId);
  assert.equal(view.current.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(view.streams.length, 2);
  assert.equal(view.streams[1].request.app_tools_version, 1);
  assert.equal(view.historyPosts.find(post => post.id === childId).body.expected_revision, 1);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/recommendations' && call.method === 'POST').length, 1, 'handoff does not recommend its already-selected capability again');
  assert.equal(view.current.draft, '');
  view.finishStream(1); await view.flush(); view.current.openRecommendationSource(); await view.flush();
  assert.equal(view.current.activeId, record.conversation_id); assert.equal(view.current.draft, '尚未发送的新想法', 'returning restores the unsent source draft');
});

test('lost selection response reopens the server child, and an explicit continue cannot repeat an existing answer', async t => {
  let record, calls = 0, detail = childHistory();
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (path, options) => {
      if (path.endsWith('/select')) { if (++calls === 1) throw new Error('lost response after commit'); return json({ kind: 'conversation', candidate: recommendationCandidate, conversation: detail, created: false }); }
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush(); view.finishStream(); await view.flush();
  assert.equal(await view.current.selectRecommendation(record.id, recommendationCandidate.id), null); await view.flush();
  assert.equal(view.current.recommendationError.recordId, record.id);
  await view.current.selectRecommendation(record.id, recommendationCandidate.id); await view.flush();
  assert.equal(view.current.activeId, childId); assert.equal(view.streams.length, 1, 'created:false never automatically starts a model');
  assert.equal(view.current.canContinueRecommendation, true);
  await view.current.selectRecommendation(record.id, recommendationCandidate.id, true); await view.flush();
  assert.equal(view.streams.length, 2); view.finishStream(1); await view.flush();
  detail = childHistory('查询比特币资料', { revision: 3, messages: [...view.current.conversation.messages] });
  await view.current.selectRecommendation(record.id, recommendationCandidate.id, true); await view.flush();
  assert.equal(view.streams.length, 2, 'even explicit recovery only continues an untouched user turn');
  assert.equal(view.current.canContinueRecommendation, false);
});

test('recommended research switches out of thinking and preserves filing evidence through explanation recovery', async t => {
  let record;
  const command = { name: 'company_filing', arguments: { issuerId: 'sec:0000320193', accession: '0000320193-26-000026', offset: 146, expectedSha256: 'a'.repeat(64) } };
  const view = harness({ statusFetch: async () => json({ ...recommendedStatus, company_research_version: 1, filing_research_version: 1 }), historyFetch: cloudHistory,
    appExecute: async () => ({ text: 'SEC excerpt [p000146], source hash and limitations retained', actions: [] }),
    recommendationFetch: (path, options) => {
      if (path.endsWith('/select')) return json({ kind: 'conversation', candidate: recommendationCandidate, conversation: childHistory('Read Apple risk factors'), created: true });
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.setThink(true);
  view.current.send('Read Apple risk factors'); await view.flush();
  assert.equal(view.streams[0].request.thinking, true);
  assert.equal(view.streams[0].request.filing_research_version, undefined);
  view.finishStream(); await view.flush();
  await view.current.selectRecommendation(record.id, recommendationCandidate.id); await view.flush();
  assert.equal(view.streams[1].request.thinking, false);
  assert.equal(view.streams[1].request.app_tools_version, 1);
  assert.equal(view.streams[1].request.filing_research_version, 1);
  view.finishAppStream(command, 1); await view.flush();
  assert.equal(view.appCalls.length, 1);
  const collected = view.streams[2].request.app_context;
  assert.equal(collected[0].name, 'company_filing');
  assert.deepEqual(collected[0].arguments, command.arguments);
  view.failStream(2, 'AI_UPSTREAM_ERROR'); await view.flush(); view.current.retry(); await view.flush();
  assert.equal(view.appCalls.length, 1, 'explanation recovery never reads the filing twice');
  assert.equal(view.streams[3].request.app_final_only, true);
  assert.equal(view.streams[3].request.filing_research_version, 1);
  assert.deepEqual(view.streams[3].request.app_context, collected);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/recommendations' && call.method === 'POST').length, 1);
});

test('saved recommendation history and pending identifiers recover without starting a model or selecting a plugin', async t => {
  const sourceId = '66666666-6666-4666-8666-666666666666';
  const record = recommendationRecord({ conversation_id: sourceId, source_message_id: 'source-user' });
  const detail = { ...childHistory(), id: sourceId, messages: [{ id: 'source-user', role: 'user', content: '查询比特币资料', status: 'complete' }, { id: 'source-answer', role: 'assistant', content: 'Answer', status: 'complete' }] };
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: async () => json({ items: [{ id: sourceId, title: detail.title, revision: 1, updated_at: detail.updated_at }], next_cursor: null }),
    historyDetail: async () => json(detail), recommendationPending: { recordId: record.id, candidateId: recommendationCandidate.id, sourceConversationId: sourceId },
    recommendationFetch: (_path, options) => { assert.equal(options.method, 'GET'); return json({ items: [record], next_cursor: null }); },
  }); t.after(view.close); await view.flush(); await view.current.openConversation(sourceId); await view.flush();
  assert.equal(Object.keys(view.current.recommendations).length, 1); assert.equal(view.streams.length, 0);
  assert.equal(view.current.pendingRecommendation.sourceConversationId, sourceId);
  assert.equal(view.calls.some(call => call.path.endsWith('/select')), false);
});

test('late selection after leaving the chat preserves recovery but cannot open or execute the target', async t => {
  const pending = deferred(); let record;
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (path, options) => {
      if (path.endsWith('/select')) return pending.promise;
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush(); view.finishStream(); await view.flush();
  const selecting = view.current.selectRecommendation(record.id, recommendationCandidate.id); await view.flush();
  const request = view.calls.find(call => call.path.endsWith('/select'));
  view.current.newConversation(); assert.equal(request.signal.aborted, true);
  pending.resolve(json({ kind: 'conversation', candidate: recommendationCandidate, conversation: childHistory(), created: true }));
  await selecting; await view.flush();
  assert.equal(view.current.activeId, null); assert.equal(view.streams.length, 1); assert.equal(view.pendingRecommendation().recordId, record.id);
});

test('a five-second recommendation deadline cannot cancel a completed answer', async t => {
  const pending = deferred();
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (_path, options) => options.method === 'POST' ? pending.promise : json({ items: [], next_cursor: null }),
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查一查股票市场'); await view.flush();
  const request = view.calls.find(call => call.path === '/v1/ai/recommendations' && call.method === 'POST');
  view.finishStream(); await view.flush();
  assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
  await new Promise(resolve => setTimeout(resolve, 5100)); await view.flush();
  assert.equal(request.signal.aborted, true); assert.equal(view.streams[0].signal.aborted, false);
  assert.equal(view.current.messageError, ''); assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
  pending.resolve(json(recommendationRecord(JSON.parse(request.body)))); await view.flush();
  assert.deepEqual(Object.keys(view.current.recommendations), []);
});

test('connection recovery revalidates access, waits for renewed AI consent, and does not repeat the saved user message', async t => {
  let record, selections = 0;
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    recommendationFetch: (path, options) => {
      if (path.endsWith('/select')) return json(++selections === 1
        ? { kind: 'authorize', candidate: { ...recommendationCandidate, access: 'authorize' }, conversation: null, created: false }
        : { kind: 'conversation', candidate: recommendationCandidate, conversation: childHistory(), created: true });
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush(); view.finishStream(); await view.flush();
  const needsAuth = await view.current.selectRecommendation(record.id, recommendationCandidate.id); await view.flush();
  assert.equal(needsAuth.kind, 'authorize'); assert.equal(view.current.activeId, record.conversation_id); assert.equal(view.streams.length, 1);
  view.revokeConsent(); await view.flush();
  await view.current.selectRecommendation(record.id, recommendationCandidate.id, true); await view.flush();
  assert.equal(selections, 2); assert.equal(view.current.aiConsentOpen, true); assert.equal(view.streams.length, 1);
  view.current.confirmAiSharing(); await view.flush();
  assert.equal(view.streams.length, 2); assert.equal(view.streams[1].request.app_tools_version, 1);
  assert.equal(view.current.conversation.messages.filter(message => message.role === 'user').length, 1);
});

test('failed local recovery storage prevents a selection with an unrecoverable outcome', async t => {
  let record;
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory, pendingSave: async () => { throw new Error('storage full'); },
    recommendationFetch: (_path, options) => {
      if (options.method === 'POST') { record = recommendationRecord(JSON.parse(options.body)); return json(record); }
      return json({ items: record ? [record] : [], next_cursor: null });
    },
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush(); view.finishStream(); await view.flush();
  assert.equal(await view.current.selectRecommendation(record.id, recommendationCandidate.id), null); await view.flush();
  assert.equal(view.current.recommendationError.code, 'STORAGE_ERROR'); assert.equal(view.calls.some(call => call.path.endsWith('/select')), false);
  assert.equal(view.streams.length, 1);
});

test('a completed public lookup marks only its current source turn even when it has no navigation actions', async t => {
  const view = harness({ statusFetch: async () => json(recommendedStatus), historyFetch: cloudHistory,
    appExecute: async () => ({ text: 'Public market result', actions: [] }),
    recommendationFetch: (_path, options) => options.method === 'POST' ? json(recommendationRecord(JSON.parse(options.body))) : json({ items: [], next_cursor: null }),
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查询比特币资料'); await view.flush();
  const source = view.current.conversation.messages[0];
  view.finishAppStream({ name: 'market_query', arguments: { kind: 'crypto', asset: 'BTC' } }); await view.flush();
  const key = recommendationCore.recommendationTurnKey(view.current.activeId, source.id);
  assert.equal(view.current.recommendationCoverage[key][0], 'market-data');
  assert.equal(view.current.appActions[view.current.conversation.messages.at(-1).id].length, 0);
  view.finishStream(1); await view.flush(); view.current.send('还有其他问题'); await view.flush();
  const next = view.current.conversation.messages.findLast(message => message.role === 'user');
  assert.equal(view.current.recommendationCoverage[recommendationCore.recommendationTurnKey(view.current.activeId, next.id)], undefined);
});

test('turning off the advertised feature cancels in-flight recommendations but preserves the running answer', async t => {
  let feature = 1; const pending = deferred();
  const view = harness({ statusFetch: async () => json({ ...configured, recommendations_version: feature }), historyFetch: cloudHistory,
    recommendationFetch: (_path, options) => options.method === 'POST' ? pending.promise : json({ items: [], next_cursor: null }),
  }); t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('查看市场资料'); await view.flush();
  const request = view.calls.find(call => call.path === '/v1/ai/recommendations' && call.method === 'POST');
  feature = 0; view.current.reconnect(); await view.flush();
  assert.equal(request.signal.aborted, true); assert.equal(view.streams[0].signal.aborted, false);
  pending.resolve(json(recommendationRecord(JSON.parse(request.body)))); await view.flush(); assert.deepEqual(Object.keys(view.current.recommendations), []);
  view.finishStream(); await view.flush(); assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
});

test('bounded status retries retain restored identity and draft and never send a chat', async t => {
  let attempts = 0;
  const view = harness({ statusFetch: async () => { if (++attempts < 3) throw new Error('offline'); return json(configured); } }); t.after(view.close);
  await view.flush(); view.current.setDraft('unsent fixture');
  assert.equal(view.current.session.user.id, user.id);
  view.advance(1000); await view.flush(); view.advance(3000); await view.flush();
  assert.equal(view.current.statusPhase, 'ready');
  assert.equal(view.current.draft, 'unsent fixture');
  assert.equal(view.token(), token);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/status').length, 3);
  assert.equal(view.calls.some(call => call.method !== 'GET'), false);
});

test('rechecking public status does not cancel an answer or invalidate the session', async t => {
  const view = harness(); t.after(view.close); await view.flush(); view.grantConsent();
  assert.equal(view.current.send('stream fixture'), true); await view.flush();
  assert.equal(view.current.busy, true);
  const conversation = view.current.activeId;
  view.current.reconnect(); await view.flush();
  assert.equal(view.current.statusPhase, 'ready');
  assert.equal(view.current.session.user.id, user.id);
  assert.equal(view.current.activeId, conversation);
  assert.equal(view.current.busy, true);
  assert.equal(view.streams[0].signal.aborted, false);
  assert.equal(view.calls.filter(call => call.path === '/v1/me').length, 1);
});

test('mascot follows actual stream events and late events cannot revive a stopped answer', async t => {
  const view = harness(); t.after(view.close); await view.flush(); view.grantConsent();
  const presentation = () => getMascotPresentation({
    phase: view.current.phase,
    message: view.current.conversation?.messages.at(-1),
    statusPhase: view.current.statusPhase,
  });
  assert.equal(view.current.send('state fixture'), true); await view.flush();
  assert.equal(presentation().title.zh, '正在准备回答');
  const active = view.streams[0];
  active.onEvent({ type: 'status', phase: 'thinking' }); await view.flush();
  assert.equal(presentation().title.zh, '思考中');
  active.onEvent({ type: 'delta', text: 'preserved partial' }); await view.flush();
  assert.equal(presentation().state, 'streaming');
  view.current.stop(); await view.flush();
  assert.equal(active.signal.aborted, true);
  assert.equal(presentation().state, 'paused');
  active.onEvent({ type: 'delta', text: 'late text' });
  active.onEvent({ type: 'done', model: 'deepseek-flash', finish_reason: 'stop' });
  await view.flush();
  assert.equal(presentation().state, 'paused');
  assert.equal(view.current.conversation.messages.at(-1).content, 'preserved partial');
  view.current.newConversation(); await view.flush();
  active.onEvent({ type: 'status', phase: 'thinking' }); await view.flush();
  assert.equal(view.current.conversation, null);
  assert.equal(presentation().state, 'ready');
});

test('mascot completion follows successful done and is cleared on a new conversation', async t => {
  const view = harness(); t.after(view.close); await view.flush(); view.grantConsent();
  assert.equal(view.current.send('completion fixture'), true); await view.flush();
  view.finishStream(); await view.flush();
  const completed = getMascotPresentation({ phase: view.current.phase, message: view.current.conversation.messages.at(-1) });
  assert.equal(completed.state, 'complete');
  assert.equal(completed.busy, false);
  view.current.newConversation(); await view.flush();
  assert.equal(getMascotPresentation({ phase: view.current.phase, message: view.current.conversation?.messages.at(-1) }).state, 'ready');
});

test('mascot waits for the actual final history save before showing completion or sync recovery', async t => {
  for (const failed of [false, true]) {
    const finalSave = deferred();
    let finalSnapshot;
    const view = harness({
      historyFetch: async () => json({ items: [], next_cursor: null }),
      historySave: (id, body) => {
        const snapshot = { id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at };
        if (body.messages.at(-1)?.status === 'complete') { finalSnapshot = snapshot; return finalSave.promise; }
        return json(snapshot);
      },
    });
    t.after(view.close); await view.flush(); view.grantConsent();
    assert.equal(view.current.send('save state fixture'), true); await view.flush();
    view.finishStream(); await view.flush();
    assert.ok(finalSnapshot);
    assert.equal(view.current.phase, 'responding');
    assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
    const presentation = () => getMascotPresentation({
      phase: view.current.phase,
      message: view.current.conversation.messages.at(-1),
      historyError: view.current.historyError,
    });
    assert.equal(presentation().title.zh, '正在保存回答');
    assert.equal(presentation().busy, true);
    finalSave.resolve(failed ? new Response('', { status: 503 }) : json(finalSnapshot));
    await view.flush();
    assert.equal(view.current.phase, 'idle');
    assert.equal(presentation().state, failed ? 'error' : 'complete');
    assert.equal(presentation().title.zh, failed ? '历史尚未同步' : '回答完成');
    assert.equal(presentation().busy, false);
  }
});

test('temporary session restore failure preserves the existing identity and last known service config', async t => {
  let offline = false;
  const view = harness({ meFetch: async () => { if (offline) throw new Error('offline'); return json(user); } }); t.after(view.close);
  await view.flush(); view.current.setDraft('keep draft'); offline = true;
  await view.current.restore(); await view.flush();
  assert.equal(view.current.authError, 'NETWORK_ERROR');
  assert.equal(view.current.session.user.id, user.id);
  assert.equal(view.current.draft, 'keep draft');
  assert.equal(view.current.statusPhase, 'ready');
  assert.equal(view.token(), token);
});

test('leaving cancels backoff; returning uses the existing visibility lifecycle for a fresh check', async t => {
  let attempts = 0;
  const view = harness({ statusFetch: async () => { if (++attempts === 1) throw new Error('offline'); return json(configured); } }); t.after(view.close);
  await view.flush(); view.setVisible(false); view.advance(30000); await view.flush();
  assert.equal(attempts, 1);
  view.setVisible(true); await view.flush();
  assert.equal(attempts, 2);
  assert.equal(view.current.statusPhase, 'ready');
});

test('public status authorization errors do not clear identity; authenticated session 401 still does', async t => {
  let expired = false;
  const unauthorized = () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
  const view = harness({ statusFetch: async () => unauthorized(), meFetch: async () => expired ? unauthorized() : json(user) }); t.after(view.close);
  await view.flush();
  assert.equal(view.current.statusPhase, 'error');
  assert.equal(view.current.statusError, 'UNAUTHORIZED');
  assert.equal(view.current.session.user.id, user.id);
  assert.equal(view.token(), token);
  view.advance(60000); await view.flush();
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/status').length, 1);
  expired = true; await view.current.restore(); await view.flush();
  assert.equal(view.current.session, null);
  assert.equal(view.token(), null);
  assert.equal(view.current.authError, 'UNAUTHORIZED');
});

test('a failed later status check remains visible without blocking a known-configured user request', async t => {
  let offline = false;
  const view = harness({ statusFetch: async () => { if (offline) throw new Error('temporary error'); return json(configured); } }); t.after(view.close);
  await view.flush(); offline = true; view.current.reconnect(); await view.flush();
  view.advance(1000); await view.flush(); view.advance(3000); await view.flush();
  assert.equal(view.current.statusPhase, 'error');
  assert.equal(view.current.status.configured, true);
  assert.equal(view.current.statusError, 'NETWORK_ERROR');
  assert.equal(view.streams.length, 0);
  view.grantConsent(); assert.equal(view.current.send('explicit new fixture'), true); await view.flush();
  assert.equal(view.streams.length, 1);
  assert.equal(view.current.statusPhase, 'error');
});

test('an initial missing history collection permits explicit session-only chat without cloud writes', async t => {
  for (const status of [404, 405]) {
    const view = harness({ historyFetch: async () => new Response('', { status }) }); t.after(view.close);
    await view.flush();
    assert.equal(view.current.historyUnavailable, true);
    assert.equal(view.current.historyBusy, false);
    assert.equal(view.current.historyError, '');
    view.grantConsent(); assert.equal(view.current.send('local-only fixture'), true); await view.flush();
    assert.equal(view.streams.length, 1);
    assert.equal(view.historyPosts.length, 0);
    view.finishStream(); await view.flush();
    assert.equal(view.current.conversation.messages.at(-1).content, 'fixture answer');
    assert.equal(view.historyPosts.length, 0);
    assert.equal(view.current.historyUnavailable, true);
  }
});

test('pending or failed history capability probes block paid requests without discarding the draft', async t => {
  const probe = deferred(); let attempts = 0;
  const view = harness({ historyFetch: () => ++attempts === 1 ? probe.promise : Promise.resolve(json({ items: [], next_cursor: null })) }); t.after(view.close);
  await view.flush(); view.current.setDraft('preserved fixture'); view.grantConsent();
  assert.equal(view.current.historyBusy, true);
  assert.equal(view.current.send('preserved fixture'), false);
  probe.resolve(new Response('', { status: 503 })); await view.flush();
  assert.equal(view.current.historyBusy, false);
  assert.equal(view.current.historyUnavailable, false);
  assert.equal(view.current.historyError, 'REQUEST_FAILED');
  assert.equal(view.current.send('preserved fixture'), false);
  assert.equal(view.current.draft, 'preserved fixture');
  assert.equal(view.streams.length, 0); assert.equal(view.historyPosts.length, 0);
  await view.current.retryHistory(); await view.flush();
  assert.equal(view.current.historyError, '');
  assert.equal(view.current.send('preserved fixture'), true); await view.flush();
  assert.equal(view.streams.length, 1); assert.equal(view.historyPosts.length, 1);
});

test('a supported history server must finish the first save before streaming and save the final answer', async t => {
  const firstSave = deferred(); let writes = 0;
  const view = harness({ historyFetch: async () => json({ items: [], next_cursor: null }), historySave: (id, body) => {
    if (++writes === 1) return firstSave.promise;
    return Promise.resolve(json({ id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at }));
  } }); t.after(view.close);
  await view.flush(); view.grantConsent(); assert.equal(view.current.send('cloud fixture'), true); await view.flush();
  assert.equal(view.historyPosts.length, 1); assert.equal(view.streams.length, 0);
  const submitted = view.historyPosts[0];
  firstSave.resolve(json({ id: submitted.id, ...submitted.body, revision: 1, updated_at: user.created_at })); await view.flush();
  assert.deepEqual(view.ordering, ['history:POST', 'chat:POST']);
  view.finishStream(); await view.flush();
  assert.equal(view.historyPosts.length, 2);
  assert.equal(view.historyPosts[1].body.expected_revision, 1);
  assert.equal(view.historyPosts[1].body.messages.at(-1).status, 'complete');
  assert.equal(view.historyPosts[1].body.messages.at(-1).content, 'fixture answer');
});

test('failed cloud writes stay pending; status retries and a later collection 404 cannot bypass them', async t => {
  let statusOffline = false, collectionGone = false, saveFailed = true;
  const view = harness({
    statusFetch: async () => { if (statusOffline) throw new Error('offline'); return json(configured); },
    historyFetch: async () => collectionGone ? new Response('', { status: 404 }) : json({ items: [], next_cursor: null }),
    historySave: async (id, body) => saveFailed ? new Response('', { status: 500 }) : json({ id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at }),
  }); t.after(view.close);
  await view.flush(); view.grantConsent(); assert.equal(view.current.send('keep original snapshot'), true); await view.flush();
  assert.equal(view.streams.length, 0); assert.equal(view.historyPosts.length, 1);
  const original = structuredClone(view.historyPosts[0]);
  assert.equal(view.current.send('keep original snapshot'), false);
  statusOffline = true; view.current.reconnect(); await view.flush();
  view.advance(1000); await view.flush(); view.advance(3000); await view.flush();
  assert.equal(view.historyPosts.length, 1); assert.equal(view.streams.length, 0);
  collectionGone = true; await view.current.loadHistory(); await view.flush();
  assert.equal(view.current.historyUnavailable, false);
  assert.equal(view.current.send('keep original snapshot'), false);
  saveFailed = false; await view.current.retryHistory(); await view.flush();
  assert.deepEqual(view.historyPosts[1], original);
  assert.equal(view.streams.length, 0);
});

test('a late 404 from the previous account cannot disable cloud history for the current account', async t => {
  const old = deferred(); const nextToken = 'q_' + 'b'.repeat(43);
  const nextUser = { ...user, id: '22222222-2222-4222-8222-222222222222', handle: 'next' };
  const view = harness({
    meFetch: async options => json(options.headers.Authorization === `Bearer ${nextToken}` ? nextUser : user),
    historyFetch: options => options.headers.Authorization === `Bearer ${token}` ? old.promise : Promise.resolve(json({ items: [], next_cursor: null })),
  }); t.after(view.close);
  await view.flush(); assert.equal(view.current.historyBusy, true);
  await view.changeToken(nextToken); await view.flush();
  assert.equal(view.current.session.user.id, nextUser.id);
  assert.equal(view.current.historyBusy, false);
  old.resolve(new Response('', { status: 404 })); await view.flush();
  assert.equal(view.current.historyUnavailable, false);
  assert.equal(view.current.historyError, '');
  view.grantConsent(); assert.equal(view.current.send('next account fixture'), true); await view.flush();
  assert.deepEqual(view.ordering.slice(0, 2), ['history:POST', 'chat:POST']);
});

test('session-only history is sticky for its login and a new login probes independently', async t => {
  let supported = false;
  const nextToken = 'q_' + 'b'.repeat(43);
  const view = harness({ historyFetch: async () => supported ? json({ items: [], next_cursor: null }) : new Response('', { status: 404 }) }); t.after(view.close);
  await view.flush(); view.grantConsent();
  assert.equal(view.current.send('keep this conversation local'), true); await view.flush();
  view.finishStream(); await view.flush(); supported = true;
  await view.current.loadHistory(); await view.flush();
  assert.equal(view.current.historyUnavailable, true);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/conversations').length, 1);
  assert.equal(view.current.send('still local after the server upgrade'), true); await view.flush();
  view.finishStream(1); await view.flush();
  assert.equal(view.historyPosts.length, 0);
  await view.changeToken(nextToken); await view.flush();
  assert.equal(view.current.historyUnavailable, false);
  assert.equal(view.current.items.length, 0);
  assert.equal(view.calls.filter(call => call.path === '/v1/ai/conversations').length, 2);
  view.grantConsent(); assert.equal(view.current.send('new login cloud conversation'), true); await view.flush();
  assert.equal(view.historyPosts.length, 1);
  assert.equal(view.historyPosts[0].body.messages[0].content, 'new login cloud conversation');
});

const bankConnectionId='22222222-2222-4222-8222-222222222222';
const bankConnection={id:bankConnectionId,card_url:'urn:q:bank-demo:hsbc',endpoint_url:'urn:q:bank-demo:hsbc',name:'q.bank-demo.hsbc',title:'汇丰模拟',description:'Q simulation',version:'1.0.0',revision:1,status:'ready',auth_status:'anonymous',last_error_code:null,created_at:user.created_at,updated_at:user.created_at,pending_update:false,connection_kind:'bank_demo',builtin_service_id:'q.bank-demo.hsbc'};
const bankWallet={mode:'demo',currency:'HKD',accounts:[{id:user.id,bank_id:'hsbc',bank_name:'汇丰银行',bank_name_en:'HSBC',balance_minor:10000000,masked_number:'DEMO 1111',connection_id:bankConnectionId},{id:'33333333-3333-4333-8333-333333333333',bank_id:'bochk',bank_name:'中银香港',bank_name_en:'BOCHK',balance_minor:10000000,masked_number:'DEMO 2222',connection_id:'44444444-4444-4444-8444-444444444444'}],total_balance_minor:20000000,recipients:[{id:'demo_chen',display_name:'陈小明',demo:true}]};
function bankFixture({prepare, wallet=bankWallet, readWallet}={}) {return async(path,options)=>{
 if(path==='/v1/banking/wallet')return readWallet?readWallet(options):json(wallet);
 if(path===`/v1/plugins/connections/${bankConnectionId}`)return json(bankConnection);
 if(path==='/v1/plugins/invocations') {const body=JSON.parse(options.body);if(prepare)return prepare(body,options);return json({id:'55555555-5555-4555-8555-555555555555',connection_id:bankConnectionId,connection_revision:1,connection_title:bankConnection.title,card_url:bankConnection.card_url,endpoint_url:bankConnection.endpoint_url,connection_kind:'bank_demo',builtin_service_id:'q.bank-demo.hsbc',tool_name:body.tool_name,arguments:body.arguments,status:'awaiting_confirmation',result:null,error_code:null,created_at:user.created_at,updated_at:user.created_at,expires_at:'2026-10-22T00:00:00Z'});}
 throw new Error('No confirmation or connection mutation is permitted in chat planning');
};}
const cloudHistory=()=>json({items:[],next_cursor:null});
const historyPluginFields = new Set(['id', 'title', 'endpoint_url', 'connection_kind', 'builtin_service_id']);
function strictPluginHistory(id, body) {
  if (Object.keys(body.plugin ?? {}).some(key => !historyPluginFields.has(key))) {
    return new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid history plugin display metadata.' } }), { status: 400 });
  }
  return json({ id, ...body, revision: body.expected_revision + 1, updated_at: user.created_at });
}

test('all new selected-bank messages reach the model unchanged and save only plugin display metadata', async t => {
  for (const prompt of [
    '我卡里有多少钱', '我还有多少可以花的钱？', '戶口仲有幾多錢？', 'Check my balance',
    '帮我转给我朋友200港币', 'Transfer HKD 500 from HSBC to Chen at BOCHK',
    "Transfer 500 from Chen's account to my BOCHK account", 'What can you do?', '给我讲个笑话',
  ]) {
    const view = harness({ historyFetch: cloudHistory, historySave: strictPluginHistory }); t.after(view.close);
    await view.flush(); view.grantConsent();
    const connection = structuredClone(bankConnection);
    view.current.selectPlugin(connection); await view.flush();
    assert.notStrictEqual(view.current.plugin, connection);
    assert.deepEqual(Object.keys(view.current.plugin).sort(), [...historyPluginFields].sort());
    connection.title = 'Later connection update';
    assert.equal(view.current.plugin.title, bankConnection.title);
    assert.equal(view.streams.length, 0, 'selecting a plugin only refreshes its model status');
    assert.equal(view.current.send(prompt), true); await view.flush();
    assert.equal(view.streams.length, 1, prompt);
    assert.equal(view.streams[0].request.plugin_connection_id, bankConnection.id);
    assert.equal(view.streams[0].request.thinking, false);
    assert.deepEqual(JSON.parse(JSON.stringify(view.streams[0].request.messages)), [{ role: 'user', content: prompt }]);
    view.finishStream(); await view.flush();
    assert.ok(view.historyPosts.length >= 1, prompt);
    for (const { body } of view.historyPosts) {
      assert.deepEqual(Object.keys(body.plugin).sort(), [...historyPluginFields].sort());
      assert.equal(body.plugin.id, bankConnection.id);
      assert.equal(body.plugin.connection_kind, 'bank_demo');
      assert.equal(body.plugin.builtin_service_id, bankConnection.builtin_service_id);
    }
    assert.equal(view.current.historyError, '', prompt);
    assert.equal(view.current.conversation.messages.at(-1).status, 'complete', prompt);
    assert.equal(view.current.conversation.messages.at(-1).content, 'fixture answer');
    assert.equal(view.current.conversation.messages.at(-1).bankCommand, undefined);
    assert.equal(view.calls.some(call => call.path.startsWith('/v1/banking/') || call.path.startsWith('/v1/plugins/')), false, prompt);
  }
});

test('a complete remote connection keeps its chat identity while history excludes connection metadata', async t => {
  const connection = { ...bankConnection, card_url: 'https://example.invalid/card', endpoint_url: 'https://example.invalid/mcp', name: 'remote', title: 'Remote plugin', connection_kind: 'remote_mcp', builtin_service_id: null, owner_name: 'Publisher' };
  const view = harness({ historyFetch: cloudHistory, historySave: strictPluginHistory }); t.after(view.close);
  await view.flush(); view.grantConsent(); view.current.selectPlugin(connection); await view.flush();
  assert.equal(view.current.send('What can you do?'), true); await view.flush();
  assert.equal(view.streams.length, 1);
  assert.equal(view.streams[0].request.plugin_connection_id, connection.id);
  assert.equal(view.streams[0].request.thinking, false);
  view.finishStream(); await view.flush();
  assert.equal(view.current.historyError, '');
  assert.deepEqual(view.historyPosts[0].body.plugin, { id: connection.id, title: connection.title, endpoint_url: connection.endpoint_url, connection_kind: 'remote_mcp', builtin_service_id: null });
  assert.equal(view.calls.some(call => call.path.startsWith('/v1/banking/') || call.path.startsWith('/v1/plugins/')), false);
});

test('bank chat saves history before the model and displays its saved proposal without confirming',async t=>{
 const gate=deferred();let first=true;
 const invocationId='55555555-5555-4555-8555-555555555555';
 const view=harness({historyFetch:cloudHistory,bankFetch:async(path)=>{assert.equal(path,`/v1/plugins/invocations/${invocationId}`);return json(savedInvocation({id:invocationId}));},historySave:(id,body)=>{if(first){first=false;return gate.promise;}return strictPluginHistory(id,body);}});t.after(view.close);
 await view.flush();view.grantConsent();view.current.selectPlugin(bankConnection);await view.flush();
 assert.equal(view.current.send('Transfer HKD 500 from HSBC to Chen at BOCHK'),true);await view.flush();assert.equal(view.streams.length,0);
 const firstPost=view.historyPosts[0];assert.equal(firstPost.body.plugin.connection_kind,'bank_demo');assert.equal(firstPost.body.messages.at(-1).bankCommand,undefined);
 gate.resolve(json({id:firstPost.id,...firstPost.body,revision:1,updated_at:user.created_at}));await view.flush();
 assert.equal(view.streams.length,1);assert.deepEqual(view.ordering,['history:POST','chat:POST']);
 view.finishToolStream({invocation_id:invocationId,connection_id:bankConnectionId,tool_name:'bank_transfer',arguments:{to_bank_id:'bochk',recipient:'demo_chen',amount_minor:50000}});await view.flush();
 const answer=view.current.conversation.messages.at(-1);assert.equal(answer.status,'tool');assert.equal(answer.toolProposalId,invocationId);
 assert.equal(view.historyPosts.at(-1).body.messages.at(-1).toolProposalId,invocationId);
 assert.equal(view.streams.length,1,'a proposal does not automatically continue the model');
 view.current.resumeTool(answer.id,invocationId);await view.flush();
 assert.equal(view.streams.length,2);assert.deepEqual([...view.streams[1].request.tool_invocation_ids],[invocationId]);
 assert.equal(view.streams[1].request.plugin_connection_id,bankConnectionId);
 assert.equal('tool_result' in view.streams[1].request,false);
 assert.deepEqual(view.calls.filter(call=>call.path.startsWith('/v1/plugins/')).map(call=>[call.path,call.method]),[[`/v1/plugins/invocations/${invocationId}`,'GET']]);
});

test('only an explicit legacy bank retry reuses its old preparation key and payload',async t=>{
 const conversationId='66666666-6666-4666-8666-666666666666',answerId='77777777-7777-4777-8777-777777777777';
 const original={id:conversationId,title:'Legacy transfer',revision:1,updated_at:user.created_at,plugin:history.chatPluginSnapshot(bankConnection),messages:[{id:user.id,role:'user',content:'Transfer HKD 500 from HSBC to Chen at BOCHK',status:'complete'},{id:answerId,role:'assistant',content:'',status:'error',errorCode:'NETWORK_ERROR',bankCommand:true}]};
 const attempts=[];let fail=true;
 const ordinary=bankFixture();const view=harness({historyFetch:()=>json({items:[{id:conversationId,title:original.title,revision:1,updated_at:user.created_at}],next_cursor:null}),historyDetail:()=>json(original),bankFetch:bankFixture({prepare:async(body,options)=>{attempts.push(body);if(fail){fail=false;throw Error('lost response');}return ordinary('/v1/plugins/invocations',{...options,body:JSON.stringify(body)});}})});t.after(view.close);await view.flush();
 await view.current.openConversation(conversationId);await view.flush();assert.equal(attempts.length,0);
 view.current.retry();await view.flush();assert.equal(view.current.conversation.messages.at(-1).status,'error');view.current.retry();await view.flush();
 assert.equal(attempts[0].idempotency_key,answerId);
 assert.deepEqual(attempts[0],attempts[1]);assert.equal(view.current.conversation.messages.filter(m=>m.role==='user').length,1);assert.equal(view.current.conversation.messages.at(-1).status,'tool');assert.equal(view.streams.length,0);
 assert.equal(view.calls.some(call=>call.path.endsWith('/confirm')),false);
});

test('a model clarification and a short follow-up retain the selected bank and conversation context',async t=>{
 const view=harness({historyFetch:cloudHistory,historySave:strictPluginHistory});t.after(view.close);await view.flush();view.grantConsent();
 view.current.selectPlugin(bankConnection);await view.flush();view.current.send('帮我转给我朋友200港币');await view.flush();
 view.finishStream(0,'请告诉我收款人和收款银行。');await view.flush();
 view.current.send('陈小明的中银账户');await view.flush();
 assert.equal(view.streams.length,2);assert.equal(view.streams[1].request.plugin_connection_id,bankConnectionId);
 assert.deepEqual(JSON.parse(JSON.stringify(view.streams[1].request.messages)),[{role:'user',content:'帮我转给我朋友200港币'},{role:'assistant',content:'请告诉我收款人和收款银行。'},{role:'user',content:'陈小明的中银账户'}]);
 assert.equal(view.calls.some(call=>call.path.startsWith('/v1/banking/')||call.path.startsWith('/v1/plugins/')),false);
});

test('bank words without a selected plugin never auto-select a connection or prepare a transfer',async t=>{
 const view=harness({historyFetch:cloudHistory});t.after(view.close);await view.flush();view.grantConsent();
 assert.equal(view.current.send('Transfer HKD 500 from HSBC to Chen at BOCHK'),true);await view.flush();
 assert.equal(view.streams.length,1);assert.equal(view.streams[0].request.plugin_connection_id,undefined);
 assert.equal(view.current.plugin,null);assert.equal(view.current.conversation.plugin,undefined);
 assert.equal(view.calls.some(call=>call.path.startsWith('/v1/banking/')||call.path.startsWith('/v1/plugins/')),false);
});

test('a late model bank proposal after account invalidation cannot publish or execute',async t=>{
 const view=harness({historyFetch:cloudHistory});t.after(view.close);await view.flush();view.grantConsent();
 view.current.selectPlugin(bankConnection);await view.flush();view.current.send('我卡里有多少钱');await view.flush();
 await view.changeToken('q_'+'b'.repeat(43));await view.flush();
 view.finishToolStream({invocation_id:'55555555-5555-4555-8555-555555555555',connection_id:bankConnectionId,tool_name:'bank_balance',arguments:{}});await view.flush();
 assert.equal(view.current.items.length,0);assert.equal(view.calls.some(call=>call.path.startsWith('/v1/banking/')||call.path.startsWith('/v1/plugins/')),false);
});

test('selecting a bank refreshes model availability without sending, and manual refresh can recover',async t=>{
 let available=false;
 const view=harness({historyFetch:cloudHistory,statusFetch:async()=>json({...configured,configured:available})});t.after(view.close);await view.flush();view.grantConsent();
 assert.equal(view.current.statusPhase,'unconfigured');
 view.current.selectPlugin(bankConnection);await view.flush();
 assert.equal(view.calls.filter(call=>call.path==='/v1/ai/status').length,2);assert.equal(view.streams.length,0);
 assert.equal(view.current.send('我卡里有多少钱'),false);assert.equal(view.current.messageError,'AI_NOT_CONFIGURED');
 available=true;view.current.reconnect();await view.flush();
 assert.equal(view.current.statusPhase,'ready');assert.equal(view.current.plugin.id,bankConnectionId);assert.equal(view.streams.length,0);
 assert.equal(view.current.send('我卡里有多少钱'),true);await view.flush();assert.equal(view.streams.length,1);
 assert.equal(view.current.messageError,'');
});

test('failed bank chat history keeps its exact pending snapshot until explicit replay succeeds',async t=>{
 let failed=true;
 const view=harness({historyFetch:cloudHistory,historySave:(id,body)=>failed?new Response('',{status:503}):strictPluginHistory(id,body)});t.after(view.close);await view.flush();view.grantConsent();
 view.current.selectPlugin(bankConnection);await view.flush();view.current.send('我卡里有多少钱');await view.flush();
 const original=structuredClone(view.historyPosts[0]);
 assert.equal(view.streams.length,0);assert.equal(view.current.send('我卡里有多少钱'),false);
 failed=false;await view.current.retryHistory();await view.flush();
 assert.deepEqual(view.historyPosts[1],original);assert.equal(view.streams.length,0);
 view.current.retry();await view.flush();assert.equal(view.streams.length,1);
 assert.equal(view.current.conversation.messages.filter(message=>message.role==='user').length,1);
 assert.equal(view.calls.some(call=>call.path.startsWith('/v1/banking/')||call.path.startsWith('/v1/plugins/')),false);
});


test('a rejected history snapshot preserves the prompt and accurate error without starting AI; explicit sync precedes answer retry', async t => {
  let rejectSave = true;
  const view = harness({ historyFetch: cloudHistory, historySave: (id, body) => rejectSave
    ? new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Invalid history snapshot.' } }), { status: 400 })
    : strictPluginHistory(id, body) });
  t.after(view.close);
  await view.flush(); view.grantConsent(); view.current.selectPlugin(bankConnection); await view.flush();
  assert.equal(view.current.send('你好'), true); await view.flush();
  assert.equal(view.current.historyError, 'VALIDATION_ERROR');
  assert.equal(view.current.conversation.messages[0].content, '你好');
  assert.equal(view.current.conversation.messages.at(-1).errorCode, 'HISTORY_SAVE_FAILED');
  assert.equal(view.streams.length, 0);
  const original = structuredClone(view.historyPosts[0]);
  assert.equal(view.current.send('你好'), false);
  view.current.retry(); await view.flush();
  assert.equal(view.streams.length, 0);
  rejectSave = false; await view.current.retryHistory(); await view.flush();
  assert.equal(view.historyPosts[1].id, original.id);
  assert.equal(view.historyPosts[1].body.expected_revision, original.body.expected_revision);
  assert.equal(view.historyPosts[1].body.messages[0].content, '你好');
  assert.notEqual(view.historyPosts[1].body.request_id, original.body.request_id);
  assert.equal(view.current.historyError, ''); assert.equal(view.streams.length, 0);
  view.current.retry(); await view.flush();
  assert.equal(view.streams.length, 1);
  assert.equal(view.current.conversation.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(view.current.conversation.messages[0].content, '你好');
});

function savedInvocation(overrides = {}) {
  return { ...bankConnection, id:'55555555-5555-4555-8555-555555555555', connection_id:bankConnectionId,
    connection_title:bankConnection.title, connection_revision:1, tool_name:'bank_balance', arguments:{}, status:'succeeded',
    result:{content:[{type:'text',text:'HK$100,000 demo balance'}],structuredContent:{kind:'bank_balance',mode:'demo',currency:'HKD',bank_id:'hsbc',balance_minor:10000000}},
    error_code:null, expires_at:'2026-10-26T00:10:00Z', ...overrides };
}
function automaticHarness(options = {}) {
  return harness({ historyFetch:cloudHistory, statusFetch:async()=>json({...configured,automatic_readonly_tools:true}),
    bankFetch:async(path,options)=>{assert.equal(options.method,'GET');return json(savedInvocation({id:path.split('/').at(-1)}));}, ...options });
}
async function sendBalance(view) {
  await view.flush(); view.grantConsent(); view.current.selectPlugin(bankConnection); await view.flush();
  assert.equal(view.current.send('查询余额'),true); await view.flush();
  assert.equal(view.streams.length,1);
}
function automaticProposal(id = savedInvocation().id) {
  return {invocation_id:id,connection_id:bankConnectionId,tool_name:'bank_balance',arguments:{},automatic:true};
}

test('advertised trusted queries save the tool history, read its result, then answer once without confirming a tool',async t=>{
  const view=automaticHarness();t.after(view.close);await sendBalance(view);
  assert.equal(view.streams[0].request.automatic_readonly_tools,true);
  const id=savedInvocation().id;view.finishToolStream(automaticProposal());await view.flush();
  assert.equal(view.streams.length,2);assert.deepEqual([...view.streams[1].request.tool_invocation_ids],[id]);
  assert.deepEqual(view.ordering.slice(0,6),['history:POST','chat:POST','history:POST',`/v1/plugins/invocations/${id}:GET`,'history:POST','chat:POST']);
  const tool=view.current.conversation.messages.find(message=>message.toolProposalId===id);
  await view.current.resumeTool(tool.id,id);await view.flush();assert.equal(view.streams.length,2);
  view.finishStream(1,'你的汇丰模拟余额为 HK$100,000。');await view.flush();
  assert.equal(view.current.conversation.messages.filter(message=>message.role==='user').length,1);
  assert.equal(view.current.conversation.messages.at(-1).status,'complete');
  assert.equal(stateModel.toolResultIsAnswered(view.current.conversation,tool.id),true);
  assert.ok(view.calls.filter(call=>call.path.startsWith('/v1/plugins/')).every(call=>call.method==='GET'));
});

test('old servers never receive the opt-in field and ordinary proposals never silently continue',async t=>{
  const view=harness({historyFetch:cloudHistory});t.after(view.close);await sendBalance(view);
  assert.equal('automatic_readonly_tools' in view.streams[0].request,false);
  const proposal=automaticProposal();delete proposal.automatic;view.finishToolStream(proposal);await view.flush();
  assert.equal(view.streams.length,1);assert.equal(view.calls.some(call=>call.path.startsWith('/v1/plugins/')),false);
});

test('automatic continuation waits for the final history commit and cannot be duplicated by a premature callback',async t=>{
  const gate=deferred();let held;
  const view=automaticHarness({historySave:(id,body)=>{
    if(!held&&body.messages.at(-1)?.toolProposalId){held={id,body};return gate.promise;}
    return strictPluginHistory(id,body);
  }});t.after(view.close);await sendBalance(view);view.finishToolStream(automaticProposal());await view.flush();
  assert.equal(view.current.busy,true);assert.equal(view.streams.length,1);
  const answer=view.current.conversation.messages.at(-1);await view.current.resumeTool(answer.id,answer.toolProposalId);await view.flush();
  assert.equal(view.streams.length,1);assert.equal(view.calls.some(call=>call.path.startsWith('/v1/plugins/')),false);
  gate.resolve(strictPluginHistory(held.id,held.body));await view.flush();assert.equal(view.streams.length,2);
});

test('failed final history storage stops automatic continuation and later sync requires an explicit continue action',async t=>{
  let failure=true;
  const view=automaticHarness({historySave:(id,body)=>failure&&body.messages.at(-1)?.toolProposalId
    ?new Response('',{status:503}):strictPluginHistory(id,body)});t.after(view.close);await sendBalance(view);
  view.finishToolStream(automaticProposal());await view.flush();assert.equal(view.streams.length,1);
  const target=view.current.toolResumeTarget;assert.equal(target.invocationId,savedInvocation().id);
  assert.ok(view.current.historyError);assert.equal(view.calls.some(call=>call.path.startsWith('/v1/plugins/')),false);
  failure=false;await view.current.retryHistory();await view.flush();assert.equal(view.current.historyError,'');assert.equal(view.streams.length,1);
  await view.current.resumeTool(target.messageId,target.invocationId);await view.flush();assert.equal(view.streams.length,2);
});

test('a failed saved-result read exposes explicit recovery, preserving the result without re-executing the tool',async t=>{
  let reads=0;
  const view=automaticHarness({bankFetch:async()=>{if(++reads===1)throw Error('offline');return json(savedInvocation());}});t.after(view.close);await sendBalance(view);
  view.finishToolStream(automaticProposal());await view.flush();assert.equal(view.streams.length,1);
  assert.equal(view.current.messageError,'PLUGIN_CONTINUATION_FAILED');
  const target=view.current.toolResumeTarget;assert.ok(target);
  await Promise.all([view.current.resumeTool(target.messageId,target.invocationId),view.current.resumeTool(target.messageId,target.invocationId)]);await view.flush();
  assert.equal(reads,2);assert.equal(view.streams.length,2);assert.equal(view.current.toolResumeTarget,null);
  assert.ok(view.calls.filter(call=>call.path.startsWith('/v1/plugins/')).every(call=>call.method==='GET'));
});

test('saved results must match the conversation and be completed before any automatic answer',async t=>{
  for(const invalid of [
    {id:'99999999-9999-4999-8999-999999999999'}, {connection_id:'99999999-9999-4999-8999-999999999999'},
    {status:'unknown'}, {status:'running'}, {status:'awaiting_confirmation'}, {result:null},
  ]){
    const view=automaticHarness({bankFetch:async()=>json(savedInvocation(invalid))});t.after(view.close);await sendBalance(view);
    view.finishToolStream(automaticProposal());await view.flush();assert.equal(view.streams.length,1,JSON.stringify(invalid));
    assert.ok(view.current.toolResumeTarget);assert.equal(view.current.messageError,'PLUGIN_CONTINUATION_FAILED');
  }
});

test('stop, leaving, a new chat and account changes cancel a delayed automatic result read',async t=>{
  for(const action of ['stop','leave','new','account']){
    const gate=deferred();const view=automaticHarness({bankFetch:()=>gate.promise});t.after(view.close);await sendBalance(view);
    view.finishToolStream(automaticProposal());await view.flush();assert.equal(view.streams.length,1);assert.equal(view.current.busy,true);
    if(action==='stop')view.current.stop();else if(action==='leave')view.setVisible(false);else if(action==='new')view.current.newConversation();else await view.changeToken('q_'+'b'.repeat(43));
    await view.flush();gate.resolve(json(savedInvocation()));await view.flush();assert.equal(view.streams.length,1,action);
  }
});

test('opening completed tool history never automatically calls the model or confirms an operation',async t=>{
  const id='66666666-6666-4666-8666-666666666666',invocation=savedInvocation();
  const detail={id,title:'Saved query',revision:1,updated_at:user.created_at,plugin:history.chatPluginSnapshot(bankConnection),messages:[{id:'u',role:'user',content:'balance',status:'complete'},{id:'a',role:'assistant',content:'',status:'tool',toolProposalId:invocation.id}]};
  const view=automaticHarness({historyFetch:async()=>json({items:[{id,title:detail.title,revision:1,updated_at:user.created_at}],next_cursor:null}),historyDetail:async()=>json(detail)});t.after(view.close);await view.flush();view.grantConsent();
  await view.current.openConversation(id);await view.flush();assert.equal(view.streams.length,0);assert.equal(view.calls.some(call=>call.path.startsWith('/v1/plugins/')),false);
});

test('automatic chains cannot exceed eight saved results and preserve factual fallback when a reply fails',async t=>{
  const view=automaticHarness();t.after(view.close);await sendBalance(view);
  for(let step=0;step<8;step++){
    const id=`55555555-5555-4555-8555-${String(step+1).padStart(12,'0')}`;
    view.finishToolStream(automaticProposal(id),step);await view.flush();assert.equal(view.streams.length,step+2);
    assert.equal(view.streams[step+1].request.tool_invocation_ids.length,step+1);
  }
  view.failStream(8,'AI_TIMEOUT');await view.flush();
  const conversation=view.current.conversation;assert.equal(conversation.messages.at(-1).status,'error');
  assert.ok(conversation.messages.filter(message=>message.toolProposalId).every(message=>!stateModel.toolResultIsAnswered(conversation,message.id)));
  view.current.retry();await view.flush();assert.equal(view.streams.length,10);assert.equal(view.streams[9].request.tool_invocation_ids.length,8);
  view.finishToolStream(automaticProposal('55555555-5555-4555-8555-000000000009'),9);await view.flush();
  assert.equal(view.streams.length,10);assert.equal(view.current.messageError,'PLUGIN_TURN_LIMIT');
});

test('retired guest financial tasks remain local and never start a model or save history', async t => {
  const view = harness({ stored: null }); t.after(view.close); await view.flush();
  assert.equal(view.current.send('分期 CNY 8000 12 240'), true);
  await view.flush();
  const local = view.current.conversation;
  assert.equal(local.localOnly, true);
  assert.equal(local.messages.at(-1).financeResult, undefined);
  assert.match(local.messages.at(-1).content, /已从首页移除/);
  assert.equal(view.current.authOpen, false);
  assert.equal(view.current.aiConsentOpen, false);
  assert.equal(view.streams.length, 0);
  assert.equal(view.historyPosts.length, 0);
  assert.equal(view.calls.some(call => call.method !== 'GET'), false);
});

test('private local results stay outside cloud detail, save, retry and bank-tool paths', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush(); view.grantConsent();
  const secret = 'PRIVATE_BILL_MARKER_62015';
  assert.equal(view.current.send(`账单 CNY\n收入 ${secret} 123.45\n支出 Food 20`), true);
  const id = view.current.conversation.id;
  const count = view.calls.length;
  await view.current.openConversation(id); await view.current.retryHistory(); view.current.reloadCloud(); view.current.retry();
  await view.current.resumeTool('fake-message', '11111111-1111-4111-8111-111111111111');
  assert.equal(view.current.send('从汇丰转500港币到陈小明的中银账户'), true);
  await view.flush();
  assert.equal(view.current.conversation.id, id);
  assert.equal(view.calls.length, count);
  assert.equal(view.streams.length, 0);
  assert.equal(view.historyPosts.length, 0);
  assert.equal(JSON.stringify(view.calls).includes(secret), false);
});

test('opening a local task cancels a pending AI permission and never reuses a cloud identity', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush();
  assert.equal(view.current.send('pending cloud question'), false);
  assert.equal(view.current.aiConsentOpen, true);
  assert.equal(view.current.addLocalFinance({ prompt: 'local task', answer: 'PRIVATE_LOCAL_RESULT' }), true);
  const localId = view.current.conversation.id;
  assert.equal(view.current.aiConsentOpen, false);
  view.current.confirmAiSharing(); await view.flush();
  assert.equal(view.streams.length, 0);
  view.current.newFinancialAi(); view.grantConsent();
  assert.equal(view.current.send('What is APR?'), true); await view.flush();
  assert.notEqual(view.current.conversation.id, localId);
  assert.equal(view.current.conversation.localOnly, undefined);
  assert.equal(view.streams.length, 1);
  const context = JSON.stringify(view.streams[0].request.messages);
  assert.equal(context.includes('PRIVATE_LOCAL_RESULT'), false);
  assert.ok(context.includes('source-based market research'));
  assert.ok(context.includes('What is APR?'));
  assert.equal(JSON.stringify(view.historyPosts).includes('PRIVATE_LOCAL_RESULT'), false);
  assert.equal(JSON.stringify(view.historyPosts).includes('financeResult'), false);
});

test('guest sign-in and account changes discard local notes and drafts', async t => {
  const view = harness({ stored: null, historyFetch: cloudHistory }); t.after(view.close); await view.flush();
  view.current.addLocalFinance({ prompt: 'guest private', answer: 'guest result' });
  view.current.setDraft('private draft');
  await view.changeToken(token); await view.flush();
  assert.equal(view.current.session.user.id, user.id);
  assert.equal(view.current.items.some(item => item.localOnly), false);
  assert.equal(view.current.draft, '');
  view.current.addLocalFinance({ prompt: 'signed in private', answer: 'signed in result' });
  await view.changeToken('q_' + 'b'.repeat(43)); await view.flush();
  assert.equal(view.current.items.some(item => item.localOnly), false);
  assert.equal(view.historyPosts.length, 0);
});

test('switching from an active cloud answer to a local task preserves the old cloud ID only for its own result', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush(); view.grantConsent();
  assert.equal(view.current.send('cloud question'), true); await view.flush();
  const cloudId = view.current.conversation.id;
  assert.equal(view.current.addLocalFinance({ prompt: 'new private local task', answer: 'PRIVATE_NEW_LOCAL' }), true);
  const localId = view.current.conversation.id;
  assert.notEqual(localId, cloudId);
  assert.equal(view.streams[0].signal.aborted, true);
  await view.flush();
  assert.equal(view.current.conversation.id, localId);
  assert.equal(view.current.items.find(item => item.id === cloudId).localOnly, undefined);
  assert.equal(view.historyPosts.some(item => item.id === localId), false);
  assert.equal(JSON.stringify(view.historyPosts).includes('PRIVATE_NEW_LOCAL'), false);
});

test('long UTF-16 financial input cannot fall back to a cloud request', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush(); view.grantConsent();
  const value = '账单 CNY\n收入 PRIVATE_SALARY 10000\n支出 ' + '💸'.repeat(6000) + ' 20';
  assert.ok(value.length > 12000 && Array.from(value).length < 12000);
  assert.equal(view.current.send(value), true); await view.flush();
  assert.equal(view.current.conversation.localOnly, true);
  assert.equal(view.historyPosts.length, 0);
  assert.equal(view.streams.length, 0);
  assert.equal(JSON.stringify(view.calls).includes('PRIVATE_SALARY'), false);
  assert.equal(view.current.send('账单 CNY\n收入 PRIVATE_TOO_LONG ' + '💸'.repeat(13000)), false);
  await view.flush();
  assert.equal(view.current.messageError, 'MESSAGE_TOO_LONG');
  assert.equal(view.historyPosts.length, 0);
  assert.equal(view.streams.length, 0);
});

test('financial AI mode survives reopening its existing cloud conversation', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush(); view.grantConsent();
  view.current.newFinancialAi();
  assert.equal(view.current.send('What is APR?'), true); await view.flush();
  const id = view.current.conversation.id;
  view.finishStream(0, 'APR includes relevant borrowing costs.'); await view.flush();
  view.current.newConversation(); await view.current.openConversation(id); await view.flush();
  assert.equal(view.current.financialAi, true);
  assert.equal(view.current.send('What is APR?'), true); await view.flush();
  assert.equal(view.current.conversation.id, id);
  assert.equal(view.current.conversation.localOnly, undefined);
  assert.equal(view.streams.length, 2);
  assert.ok(JSON.stringify(view.streams[1].request.messages).includes('source-based market research'));
  assert.ok(JSON.stringify(view.streams[1].request.messages).includes('APR includes relevant borrowing costs.'));
});

test('financial AI mode restores from saved visible history without a new wire field', async t => {
  const id = '88888888-8888-4888-8888-888888888888';
  const detail = { id, title: 'Finance Q&A · What is APR?', revision: 1, updated_at: user.created_at,
    messages: [{ id: 'u', role: 'user', content: 'What is APR?', status: 'complete' }, { id: 'a', role: 'assistant', content: 'A reference borrowing rate.', status: 'complete' }] };
  const view = harness({ historyFetch: async () => json({ items: [{ id, title: detail.title, revision: 1, updated_at: user.created_at }], next_cursor: null }), historyDetail: async () => json(detail) });
  t.after(view.close); await view.flush(); view.grantConsent();
  await view.current.openConversation(id); await view.flush();
  assert.equal(view.current.financialAi, true);
  assert.equal(view.current.send('What is APR?'), true); await view.flush();
  assert.equal(view.current.conversation.id, id);
  assert.equal(view.streams.length, 1);
  assert.ok(JSON.stringify(view.streams[0].request.messages).includes('source-based market research'));
});

const researchId = '99999999-9999-4999-8999-999999999999';
const researchText = 'Analyze these public Treasury bills headlines. Source: https://example.invalid/news; retrieved 2026-11-01T00:00:00Z.';
const researchDetail = (extra = {}) => ({ id: researchId, title: 'Existing market discussion', revision: 1, updated_at: user.created_at,
  messages: [{ id: 'prior-user', role: 'user', content: 'Explain bonds', status: 'complete' }, { id: 'prior-answer', role: 'assistant', content: 'Public bond concepts', status: 'complete' }], ...extra });
const researchHistory = async () => json({ items: [{ id: researchId, title: 'Existing market discussion', revision: 1, updated_at: user.created_at }], next_cursor: null });

test('research handoff creates a separate draft from a hidden chat without sending or copying local notes', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush();
  view.current.addLocalFinance({ prompt: 'PRIVATE_LOCAL_NOTE', answer: 'Private local answer' });
  const localId = view.current.activeId;
  view.setVisible(false); await view.flush();
  assert.equal(await view.current.prepareResearchDraft(researchText), true);
  assert.equal(view.current.activeId, null); assert.equal(view.current.plugin, null); assert.equal(view.current.financialAi, true);
  assert.equal(view.current.draft, researchText);
  assert.equal(view.current.items.find(item => item.id === localId).localOnly, true);
  assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
  view.setVisible(true); await view.flush();
  assert.equal(view.current.draft, researchText);
  view.grantConsent(); assert.equal(view.current.send(view.current.draft), true); await view.flush();
  assert.equal(view.streams.length, 1);
  assert.equal(view.current.conversation.localOnly, undefined);
  assert.ok(!JSON.stringify(view.streams[0].request).includes('PRIVATE_LOCAL_NOTE'));
  assert.ok(!JSON.stringify(view.streams[0].request.messages).includes(token));
  assert.equal(view.streams[0].request.plugin_connection_id, undefined);
});

test('research handoff loads an existing ordinary conversation before changing selection and uses market mode', async t => {
  const response = deferred();
  const view = harness({ historyFetch: researchHistory, historyDetail: () => response.promise }); t.after(view.close); await view.flush();
  view.setVisible(false); await view.flush();
  const pending = view.current.prepareResearchDraft(researchText, researchId);
  assert.equal(view.current.researchBusy, true); assert.equal(view.current.activeId, null); assert.equal(view.current.draft, '');
  assert.equal(await view.current.prepareResearchDraft('second request', researchId), false);
  response.resolve(json(researchDetail()));
  assert.equal(await pending, true); await view.flush();
  assert.equal(view.current.activeId, researchId); assert.equal(view.current.draft, researchText); assert.equal(view.current.researchBusy, false);
  assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
  view.setVisible(true); await view.flush(); view.grantConsent();
  assert.equal(view.current.send(view.current.draft), true); await view.flush();
  assert.equal(view.current.activeId, researchId); assert.equal(view.current.conversation.localOnly, undefined);
  assert.ok(JSON.stringify(view.streams[0].request.messages).includes('Public bond concepts'));
  assert.equal(view.streams[0].request.plugin_connection_id, undefined);
});

test('research handoff preserves selection after failed, mismatched or ineligible cloud detail', async t => {
  const cases = [
    () => new Response('', { status: 503 }),
    () => json({ ...researchDetail(), id: '88888888-8888-4888-8888-888888888888' }),
    () => json(researchDetail({ plugin: history.chatPluginSnapshot(bankConnection) })),
    () => json(researchDetail({ localOnly: true })),
    () => json(researchDetail({ messages: [{ id: 'u', role: 'user', content: 'PRIVATE', status: 'complete', localFinance: true }] })),
    () => json(researchDetail({ messages: [{ id: 'u', role: 'user', content: 'PRIVATE', status: 'complete', financeResult: {} }] })),
    () => json({ invalid: true }),
  ];
  for (const respond of cases) {
    const view = harness({ historyFetch: researchHistory, historyDetail: async () => respond() }); t.after(view.close); await view.flush();
    view.current.addLocalFinance({ prompt: 'PRIVATE_KEEP', answer: 'Existing result' });
    const previousId = view.current.activeId;
    view.setVisible(false); await view.flush();
    assert.equal(await view.current.prepareResearchDraft(researchText, researchId), false);
    assert.equal(view.current.activeId, previousId); assert.equal(view.current.draft, '');
    assert.equal(view.current.conversation.localOnly, true); assert.equal(view.current.financialAi, false);
    assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
  }
});

test('research handoff cannot overwrite drafts or enter local and plugin conversations', async t => {
  const view = harness({ historyFetch: researchHistory, historyDetail: async () => json(researchDetail({ plugin: history.chatPluginSnapshot(bankConnection) })) }); t.after(view.close); await view.flush();
  view.current.setDraft('UNSENT_USER_DRAFT');
  assert.equal(await view.current.prepareResearchDraft(researchText), false);
  assert.equal(view.current.draft, 'UNSENT_USER_DRAFT');
  view.current.setDraft(''); await view.current.openConversation(researchId); await view.flush();
  assert.equal(await view.current.prepareResearchDraft(researchText, researchId), false);
  view.current.addLocalFinance({ prompt: 'PRIVATE', answer: 'Local' });
  const localId = view.current.activeId;
  assert.equal(await view.current.prepareResearchDraft(researchText, localId), false);
  assert.equal(await view.current.prepareResearchDraft(researchText, 'unknown'), false);
  assert.equal(await view.current.prepareResearchDraft(''), false);
  assert.equal(await view.current.prepareResearchDraft('x'.repeat(12001)), false);
  assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
});

test('aborted, backgrounded, superseded and account-changed research loads cannot insert late drafts', async t => {
  for (const change of ['abort', 'background', 'edited-draft', 'new-conversation', 'account', 'hide', 'unmount']) {
    const response = deferred(), cancel = new AbortController();
    const view = harness({ historyFetch: researchHistory, historyDetail: () => response.promise }); t.after(view.close); await view.flush();
    // Hide is a separate test of the hook's own invalidation; other cases start on the market page.
    if (change !== 'hide') { view.setVisible(false); await view.flush(); }
    const operation = view.current.prepareResearchDraft(researchText, researchId, cancel.signal);
    await view.flush();
    const request = view.calls.find(call => call.path.endsWith(researchId));
    if (change === 'abort') cancel.abort();
    if (change === 'background') view.setAppState('background');
    if (change === 'edited-draft') { view.current.setDraft('New user edit'); view.current.setDraft(''); }
    if (change === 'new-conversation') view.current.newConversation();
    if (change === 'account') await view.changeToken('q_' + 'b'.repeat(43));
    if (change === 'hide') view.setVisible(false);
    if (change === 'unmount') view.close();
    response.resolve(json(researchDetail()));
    assert.equal(await operation, false, change); await view.flush();
    assert.equal(view.current.draft, '', change); assert.equal(view.current.activeId, null, change);
    assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
    if (['abort', 'background', 'account', 'hide', 'unmount'].includes(change)) assert.equal(request.signal.aborted, true, change);
  }
});

test('research handoff does not cancel a running response or an open AI sharing confirmation', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close); await view.flush();
  assert.equal(view.current.send('Explain markets'), false); await view.flush();
  assert.equal(view.current.aiConsentOpen, true);
  assert.equal(await view.current.prepareResearchDraft(researchText), false);
  assert.equal(view.current.aiConsentOpen, true);
  view.current.confirmAiSharing(); await view.flush();
  assert.equal(view.streams.length, 1);
  const previous = view.current.activeId;
  assert.equal(await view.current.prepareResearchDraft(researchText), false);
  assert.equal(view.current.activeId, previous); assert.equal(view.streams[0].signal.aborted, false);
});

test('research drafts work for guests and reject a target with an uncertain history write', async t => {
  const guest = harness({ stored: null }); t.after(guest.close); await guest.flush(); guest.setVisible(false); await guest.flush();
  assert.equal(await guest.current.prepareResearchDraft(researchText), true);
  guest.setVisible(true); await guest.flush();
  assert.equal(guest.current.draft, researchText); assert.equal(guest.current.session, null);
  assert.equal(guest.streams.length, 0); assert.equal(guest.historyPosts.length, 0);
  const view = harness({ historyFetch: cloudHistory, historySave: async () => new Response('', { status: 503 }) }); t.after(view.close); await view.flush(); view.grantConsent();
  assert.equal(view.current.send('public fixture'), true); await view.flush();
  const pendingId = view.current.activeId;
  view.current.setDraft('');
  assert.equal(await view.current.prepareResearchDraft(researchText, pendingId), false);
  assert.equal(view.current.activeId, pendingId); assert.equal(view.current.draft, ''); assert.equal(view.streams.length, 0);
});

test('a cold hidden chat does not accept a guest draft before restoring an existing account', async t => {
  const view = harness({ historyFetch: cloudHistory }); t.after(view.close);
  view.setVisible(false); await view.flush();
  assert.equal(view.current.session, null);
  assert.equal(await view.current.prepareResearchDraft(researchText), false);
  assert.equal(view.current.draft, ''); assert.equal(view.historyPosts.length, 0); assert.equal(view.streams.length, 0);
  view.setVisible(true); await view.flush();
  assert.equal(view.current.session.user.id, user.id);
  view.setVisible(false); await view.flush();
  assert.equal(await view.current.prepareResearchDraft(researchText), true);
  view.setVisible(true); await view.flush();
  assert.equal(view.current.draft, researchText);
});

test('research handoff reserves the actual market guidance budget before fetching or changing a conversation', async t => {
  const capacity = 12000 - Array.from(financeIntent.FINANCIAL_AI_GUIDANCE).length - 2;
  assert.ok(capacity > 0 && capacity < 12000);
  const view = harness({ historyFetch: researchHistory, historyDetail: async () => json(researchDetail()) }); t.after(view.close); await view.flush();
  const priorCalls = view.calls.length;
  const tooLong = '💬'.repeat(capacity + 1);
  assert.ok(Array.from(tooLong).length < 12000);
  assert.equal(await view.current.prepareResearchDraft(tooLong, researchId), false);
  assert.equal(view.current.draft, ''); assert.equal(view.current.activeId, null);
  assert.equal(view.calls.length, priorCalls); assert.equal(view.historyPosts.length, 0);
  const atLimit = '💬'.repeat(capacity);
  assert.equal(await view.current.prepareResearchDraft(atLimit), true);
  view.grantConsent(); assert.equal(view.current.send(view.current.draft), true); await view.flush();
  assert.equal(view.streams.length, 1);
  assert.equal(Array.from(view.streams[0].request.messages.at(-1).content).length, 12000);
  assert.equal(view.current.conversation.messages[0].content, atLimit);
});

const appConfigured = () => json({ ...configured, app_tools_version: 1 });
const appInfo = { name: 'app_info', arguments: { module: 'insurance' } };

test('ordinary app-capable chat executes public reads, saves readable results and continues with click-only actions', async t => {
  const view = harness({ statusFetch: appConfigured, historyFetch: cloudHistory }); t.after(view.close);
  await view.flush(); view.grantConsent();
  assert.equal(view.current.send('How can Q help me with insurance?'), true); await view.flush();
  assert.equal(view.streams[0].request.app_tools_version, 1);
  view.finishAppStream(appInfo); await view.flush();
  assert.equal(view.appCalls.length, 1); assert.equal(view.streams.length, 2);
  assert.equal(view.streams[1].request.app_context[0].name, 'app_info');
  assert.ok(view.current.conversation.messages.at(-1).content.includes('保险'));
  const answerId = view.current.conversation.messages.at(-1).id;
  assert.ok(view.current.appActions[answerId].some(action => action.module === 'insurance'));
  const savedPublicResult = view.historyPosts.find(post => post.body.messages.at(-1).content.includes('保险')).body.messages.at(-1);
  assert.equal(savedPublicResult.status, 'incomplete');
  assert.equal(savedPublicResult.errorCode, 'APP_QUERY_INTERRUPTED');
  assert.equal(view.current.conversation.messages.at(-1).status, 'pending');
  assert.equal(view.current.conversation.messages.at(-1).errorCode, undefined);
  assert.ok(view.historyPosts.every(post => post.body.messages.every(message => !('appActions' in message))));
  assert.equal(view.calls.some(call => /plugins|banking|social|video/.test(call.path)), false);
  view.finishStream(1, 'These are coverage directions, not product quotations.'); await view.flush();
  assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
  assert.equal(view.current.conversation.messages.at(-1).content, 'These are coverage directions, not product quotations.');
  assert.equal(view.current.canResumeAppResult(answerId), false);
});

test('company evidence stays out of the visible and saved answer while the actual analysis streams', async t => {
  const action = appCore.createAppNavigationAction('market-data', 'zh');
  const evidence = '> Query: GOOGL\n> sec:0001652044 | Alphabet\n> https://www.wikidata.org/w/api.php?action=wbsearchentities';
  const view = harness({ statusFetch: () => json({ ...configured, app_tools_version: 1, company_research_version: 1 }), historyFetch: cloudHistory,
    appExecute: async () => ({ text: '已找到 Alphabet，尚未读取财报。', modelText: evidence, actions: [action], sources: [{ label: 'Alphabet 年报', url: 'https://www.sec.gov/report.htm' }] }),
  });
  t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('分析一下谷歌的财报'); await view.flush();
  view.finishAppStream({ name: 'company_search', arguments: { query: 'GOOGL' } }); await view.flush();
  const first = view.current.conversation.messages.at(-1);
  assert.equal(first.status, 'pending'); assert.equal(first.errorCode, undefined);
  assert.equal(view.current.appPhase, 'analyzing');
  assert.doesNotMatch(first.content, /sec:|Query:|https:/);
  assert.match(view.streams[1].request.app_context[0].result, /sec:0001652044/);
  view.finishAppStream({ name: 'company_research', arguments: { issuerId: 'sec:0001652044' } }, 1); await view.flush();
  assert.equal(view.current.appActions[first.id].length, 1);
  assert.equal(view.current.appSources[first.id].length, 1);
  view.finishStream(2, 'Alphabet 2025 年营业收入增长，利润率也有所改善。'); await view.flush();
  const answer = view.current.conversation.messages.at(-1);
  assert.equal(answer.status, 'complete'); assert.equal(appPresentation.splitSourceReferences(answer.content).text, 'Alphabet 2025 年营业收入增长，利润率也有所改善。');
  assert.equal(appPresentation.splitSourceReferences(answer.content).sources[0].label, 'Alphabet 年报');
  assert.match(view.historyPosts.at(-1).body.messages.at(-1).content, /https:\/\/www.sec.gov\/report.htm/);
  assert.ok(view.historyPosts.every(post => post.body.messages.every(message => !message.content.includes('sec:0001652044'))));
  assert.equal(view.current.canResumeAppResult(answer.id), false);
});

test('company cash-flow requests reach AI but mixed private savings still never reach a stream or cloud history', async t => {
  const research = harness({ statusFetch: appConfigured, historyFetch: cloudHistory }); t.after(research.close);
  await research.flush(); research.grantConsent();
  research.current.send('请详细分析GOOGL的年度财务表现，按营收、利润和现金流解释'); await research.flush();
  assert.equal(research.streams.length, 1); assert.equal(research.current.conversation.localOnly, undefined);
  for (const question of ['分析GOOGL的年度财务表现，帮我做储蓄目标，我现在有十万，目标二十万', 'Explain IBM annual financial performance and set a savings goal of eight thousand']) {
    const local = harness({ statusFetch: appConfigured, historyFetch: cloudHistory }); t.after(local.close);
    await local.flush(); local.grantConsent(); local.current.send(question); await local.flush();
    assert.equal(local.current.conversation.localOnly, true); assert.equal(local.streams.length, 0); assert.equal(local.historyPosts.length, 0);
  }
});

test('a final stop without any explanation is incomplete even when readable results exist', async t => {
  const view = harness({ statusFetch: appConfigured, appExecute: async () => ({ text: '已取得保障目录。', modelText: 'Coverage evidence', actions: [] }) });
  t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('解释保障差别'); await view.flush();
  view.finishAppStream(appInfo); await view.flush(); view.finishStream(1, ''); await view.flush();
  const answer = view.current.conversation.messages.at(-1);
  assert.notEqual(answer.status, 'complete'); assert.equal(answer.errorCode, 'APP_EXPLANATION_FAILED');
  assert.equal(view.current.canResumeAppResult(answer.id), true);
  view.current.retry(); await view.flush();
  assert.equal(view.appCalls.length, 1); assert.equal(view.streams[2].request.app_final_only, true);
  view.finishStream(2, '这是已有资料的解释。'); await view.flush();
  assert.equal(view.current.conversation.messages.at(-1).content, '这是已有资料的解释。');
});

test('analysis timeout and capacity errors preserve results with an accurate recovery state', async t => {
  for (const [cause, expected] of [['AI_TIMEOUT', 'APP_ANALYSIS_TIMEOUT'], ['AI_BUSY', 'APP_ANALYSIS_BUSY']]) {
    const view = harness({ statusFetch: appConfigured }); t.after(view.close); await view.flush(); view.grantConsent();
    view.current.send('介绍保险'); await view.flush(); view.finishAppStream(appInfo); await view.flush(); view.failStream(1, cause); await view.flush();
    const answer = view.current.conversation.messages.at(-1);
    assert.equal(answer.errorCode, expected); assert.equal(view.current.canResumeAppResult(answer.id), true);
    view.current.resumeAppResult(answer.id); await view.flush();
    assert.equal(view.appCalls.length, 1); assert.equal(view.streams[2].request.app_final_only, true);
  }
});

test('legacy servers and thinking mode omit every app wire field', async t => {
  for (const statusFetch of [async () => json(configured), appConfigured]) {
    const view = harness({ statusFetch }); t.after(view.close); await view.flush(); view.grantConsent();
    if (statusFetch === appConfigured) view.current.setThink(true);
    assert.equal(view.current.send('Q insurance module capabilities'), true); await view.flush();
    assert.equal('app_tools_version' in view.streams[0].request, false);
    assert.equal('app_context' in view.streams[0].request, false);
    assert.equal(view.appCalls.length, 0);
    assert.ok(view.streams[0].request.messages.at(-1).content.includes(appCore.CAPABILITY_GUIDANCE));
  }
});

test('repeated commands do not reread sources and the per-turn cap forces a final explanation', async t => {
  const repeated = harness({ statusFetch: appConfigured }); t.after(repeated.close); await repeated.flush(); repeated.grantConsent();
  repeated.current.send('Tell me about Q insurance'); await repeated.flush(); repeated.finishAppStream(appInfo); await repeated.flush();
  repeated.finishAppStream(appInfo, 1); await repeated.flush();
  assert.equal(repeated.appCalls.length, 1); assert.equal(repeated.streams[2].request.app_final_only, true);
  repeated.finishStream(2); await repeated.flush();
  const capped = harness({ statusFetch: appConfigured }); t.after(capped.close); await capped.flush(); capped.grantConsent(); capped.current.send('Show Q features'); await capped.flush();
  for (let i = 0; i < 3; i++) { capped.finishAppStream({ name: 'app_info', arguments: { module: ['insurance','wallet','video'][i] } }, i); await capped.flush(); }
  assert.equal(capped.appCalls.length, 3); assert.equal(capped.streams.length, 4);
  assert.equal(capped.streams[3].request.app_final_only, true); assert.equal(capped.streams[3].request.app_context.length, 3);
  capped.finishStream(3); await capped.flush();
});

test('explanation retry reuses obtained public data without executing the query again', async t => {
  const view = harness({ statusFetch: appConfigured }); t.after(view.close); await view.flush(); view.grantConsent();
  view.current.send('Help with Q insurance'); await view.flush(); view.finishAppStream(appInfo); await view.flush();
  view.failStream(1, 'AI_UPSTREAM_ERROR'); await view.flush();
  const failed = view.current.conversation.messages.at(-1);
  assert.equal(failed.errorCode, 'APP_EXPLANATION_FAILED'); assert.equal(view.current.canResumeAppResult(failed.id), true);
  view.current.retry(); await view.flush();
  assert.equal(view.appCalls.length, 1); assert.equal(view.streams.length, 3); assert.equal(view.streams[2].request.app_final_only, true);
  assert.equal(view.streams[2].request.app_context.length, 1);
  view.finishStream(2, 'Explanation from saved public data.'); await view.flush();
  assert.equal(view.current.conversation.messages.at(-1).status, 'complete');
});

test('stop, background and account changes cancel an app lookup and suppress its late result', async t => {
  for (const action of ['stop', 'background', 'account']) {
    const pending = deferred();
    const view = harness({ statusFetch: appConfigured, appExecute: () => pending.promise }); t.after(view.close);
    await view.flush(); view.grantConsent(); view.current.send('Get public Q data'); await view.flush(); view.finishAppStream(appInfo); await view.flush();
    if (action === 'stop') view.current.stop();
    if (action === 'background') view.setAppState('background');
    if (action === 'account') { await view.changeToken('q_other_fixture'); await view.flush(); }
    assert.equal(view.appCalls[0].signal.aborted, true);
    pending.resolve({ text: 'LATE_PRIVATE_MARKER', actions: [], data: { success: true } }); await view.flush();
    assert.equal(view.streams.length, 1); assert.equal(JSON.stringify(view.current.items).includes('LATE_PRIVATE_MARKER'), false);
    if (action === 'account') assert.deepEqual(Object.keys(view.current.appActions), []);
  }
});

test('failed result-history save blocks continuation and an explicit retry cannot bypass the pending writer', async t => {
  let saves = 0;
  const view = harness({ statusFetch: appConfigured, historyFetch: cloudHistory, historySave: async (id, body) => ++saves === 1 ? json({ id, ...body, revision: 1, updated_at: user.created_at }) : new Response('', { status: 503 }) }); t.after(view.close);
  await view.flush(); view.grantConsent(); view.current.send('Q insurance overview'); await view.flush(); view.finishAppStream(appInfo); await view.flush();
  assert.equal(view.appCalls.length, 1); assert.equal(view.streams.length, 1);
  const message = view.current.conversation.messages.at(-1);
  assert.equal(message.errorCode, 'HISTORY_SAVE_FAILED'); assert.equal(view.current.resumeAppResult(message.id), false);
  view.current.retry(); await view.flush(); assert.equal(view.appCalls.length, 1); assert.equal(view.streams.length, 1);
});

test('cancelled app history reload never replays a read, while repeated explanation failures retain recovery', async t => {
  const view = harness({ statusFetch: appConfigured }); t.after(view.close); await view.flush(); view.grantConsent();
  view.current.send('Q insurance'); await view.flush(); view.finishAppStream(appInfo); await view.flush(); view.failStream(1, 'AI_UPSTREAM_ERROR'); await view.flush();
  view.current.retry(); await view.flush(); view.failStream(2, 'AI_UPSTREAM_ERROR'); await view.flush();
  const second = view.current.conversation.messages.at(-1);
  assert.equal(second.errorCode, 'APP_EXPLANATION_FAILED'); assert.equal(view.current.canResumeAppResult(second.id), true);
  view.current.retry(); await view.flush(); assert.equal(view.appCalls.length, 1);
  const savedId = '11111111-2222-4333-8444-555555555555';
  const restored = harness({ statusFetch: appConfigured, historyFetch: async () => json({ items: [{ id: savedId, title: 'Past research', revision: 1, updated_at: user.created_at }], next_cursor: null }), historyDetail: async () => json({ id: savedId, title: 'Past research', revision: 1, updated_at: user.created_at, messages: [
    { id: 'u1', role: 'user', status: 'complete', content: 'Read public data' },
    { id: 'a1', role: 'assistant', status: 'error', content: 'Previously obtained public source facts.', errorCode: 'APP_EXPLANATION_FAILED' },
  ] }) }); t.after(restored.close); await restored.flush(); restored.grantConsent(); await restored.current.openConversation(savedId); await restored.flush();
  assert.equal(restored.appCalls.length, 0); assert.equal(restored.streams.length, 0);
  restored.current.retry(); await restored.flush(); assert.equal(restored.current.messageError, '');
  assert.equal(restored.current.draft, 'Read public data'); assert.equal(restored.current.conversation, null);
  assert.equal(restored.appCalls.length, 0); assert.equal(restored.streams.length, 0);
});

test('app mode never enters selected plugins or private finance tasks and uses a shared total deadline', async t => {
  const pluginView = harness({ statusFetch: appConfigured }); t.after(pluginView.close); await pluginView.flush(); pluginView.grantConsent();
  pluginView.current.selectPlugin(bankConnection);
  await pluginView.flush(); pluginView.current.send('Get balance'); await pluginView.flush();
  assert.equal(pluginView.streams[0].request.app_tools_version, undefined);
  const privateView = harness({ statusFetch: appConfigured }); t.after(privateView.close); await privateView.flush(); privateView.grantConsent();
  privateView.current.send('账单 CNY\n收入 工资 10000\n支出 房租 3000'); await privateView.flush();
  assert.equal(privateView.appCalls.length, 0); assert.equal(privateView.streams.length, 0); assert.equal(privateView.current.conversation.localOnly, true);
  const pending = deferred(); const timed = harness({ statusFetch: appConfigured, appExecute: () => pending.promise }); t.after(timed.close); await timed.flush(); timed.grantConsent();
  timed.current.send('Read Q insurance'); await timed.flush(); timed.finishAppStream(appInfo); await timed.flush(); timed.advance(190000); await timed.flush();
  assert.equal(timed.appCalls[0].signal.aborted, true);
  pending.resolve({ text: 'TOO_LATE', actions: [] }); await timed.flush(); assert.equal(timed.streams.length, 1);
  assert.equal(JSON.stringify(timed.current.items).includes('TOO_LATE'), false);
});


test('renewing AI sharing permission preserves final-only app continuation and never replans the lookup', async t => {
  const view = harness({ statusFetch: appConfigured }); t.after(view.close); await view.flush(); view.grantConsent();
  view.current.send('Q insurance overview'); await view.flush(); view.finishAppStream(appInfo); await view.flush();
  view.failStream(1, 'AI_UPSTREAM_ERROR'); await view.flush();
  const id = view.current.conversation.messages.at(-1).id;
  view.revokeConsent(); await view.flush();
  assert.equal(view.current.resumeAppResult(id), false); await view.flush();
  assert.equal(view.current.aiConsentOpen, true); assert.equal(view.streams.length, 2);
  view.current.confirmAiSharing(); await view.flush();
  assert.equal(view.streams.length, 3); assert.equal(view.appCalls.length, 1);
  assert.equal(view.streams[2].request.app_final_only, true);
  assert.equal(view.streams[2].request.app_context[0].name, 'app_info');
  assert.equal(view.streams[2].request.app_context.length, 1);
  view.finishStream(2, 'Explanation without another lookup.'); await view.flush();
  assert.equal(view.appCalls.length, 1);
});


test('repeated failed app explanations migrate recovery state without retaining removed assistant IDs', async t => {
  const view = harness({ statusFetch: appConfigured }); t.after(view.close); await view.flush(); view.grantConsent();
  view.current.send('Q insurance overview'); await view.flush(); view.finishAppStream(appInfo); await view.flush();
  view.failStream(1, 'AI_UPSTREAM_ERROR'); await view.flush();
  const removed = [];
  for (let i = 0; i < 26; i++) {
    const id = view.current.conversation.messages.at(-1).id; removed.push(id);
    assert.equal(view.current.resumeAppResult(id), true); await view.flush();
    view.failStream(i + 2, 'AI_UPSTREAM_ERROR'); await view.flush();
    const current = view.current.conversation.messages.at(-1).id;
    assert.deepEqual([...view.current.appResumeIds], [current]);
    assert.deepEqual(Object.keys(view.current.appActions), [current]);
    assert.equal(removed.some(old => view.current.canResumeAppResult(old)), false);
  }
  assert.equal(view.appCalls.length, 1);
  // A pending consent retry is not admitted and therefore must retain its source.
  const id = view.current.conversation.messages.at(-1).id;
  view.revokeConsent(); await view.flush();
  assert.equal(view.current.resumeAppResult(id), false); await view.flush();
  assert.equal(view.current.canResumeAppResult(id), true);
  assert.equal(Object.hasOwn(view.current.appActions, id), true);
});


test('company search and research use discovered opt-in, preserve evidence and do not request plugin APIs', async t => {
  const command = { name: 'company_search', arguments: { query: 'Toyota' } };
  const old = harness({ statusFetch: appConfigured }); t.after(old.close); await old.flush(); old.grantConsent();
  old.current.send('Research Toyota annual financials'); await old.flush();
  assert.equal(old.streams[0].request.company_research_version, undefined);
  const view = harness({ historyFetch: cloudHistory, statusFetch: () => json({ ...configured, app_tools_version: 1, company_research_version: 1 }), appExecute: async () => ({ text: 'Toyota · sec:0001094517 · public source evidence', actions: [] }) });
  t.after(view.close); await view.flush(); view.grantConsent();
  assert.equal(view.current.send('Research Toyota annual financials'), true); await view.flush();
  assert.equal(view.streams[0].request.company_research_version, 1);
  view.finishAppStream(command); await view.flush();
  assert.equal(view.appCalls.length, 1);
  assert.equal(view.streams[1].request.company_research_version, 1);
  assert.equal(view.streams[1].request.app_context[0].name, 'company_search');
  view.finishAppStream({ name: 'company_research', arguments: { issuerId: 'sec:0001094517' } }, 1); await view.flush();
  assert.equal(view.appCalls.length, 2);
  assert.equal(view.streams[2].request.app_context.length, 2);
  assert.ok(view.historyPosts.some(post => post.body.messages.at(-1).content.includes('Toyota')));
  assert.equal(view.calls.some(call => /plugins|banking|social|video/.test(call.path)), false);
});

test('filing results use independent opt-in and explanation recovery never repeats document reads', async t => {
  const command = { name: 'company_filing', arguments: { issuerId: 'sec:0000320193', accession: '0001140361-26-015711' } };
  const old = harness({ statusFetch: () => json({ ...configured, app_tools_version: 1, company_research_version: 1 }) }); t.after(old.close); await old.flush(); old.grantConsent();
  old.current.send('Read the SEC filing'); await old.flush();
  assert.equal(old.streams[0].request.filing_research_version, undefined);
  const text = 'Apple SEC filing [p000000] https://www.sec.gov/Archives/ SHA-256 abc; only excerpts were read';
  let filingAvailable = true;
  const view = harness({ historyFetch: cloudHistory, statusFetch: () => json({ ...configured, app_tools_version: 1, ...(filingAvailable ? { filing_research_version: 1 } : {}) }), appExecute: async () => ({ text, actions: [] }) });
  t.after(view.close); await view.flush(); view.grantConsent(); view.current.send('Read the SEC filing'); await view.flush();
  assert.equal(view.streams[0].request.filing_research_version, 1);
  assert.equal(view.streams[0].request.company_research_version, undefined);
  view.finishAppStream(command); await view.flush();
  assert.equal(view.appCalls.length, 1);
  assert.equal(view.streams[1].request.app_context[0].name, 'company_filing');
  assert.match(view.streams[1].request.app_context[0].result, /p000000/);
  view.failStream(1, 'AI_UPSTREAM_ERROR'); await view.flush();
  assert.equal(view.current.canResumeAppResult(view.current.conversation.messages.at(-1).id), true);
  view.current.retry(); await view.flush();
  assert.equal(view.appCalls.length, 1);
  assert.equal(view.streams[2].request.app_final_only, true);
  assert.equal(view.streams[2].request.filing_research_version, 1);
  assert.equal(view.calls.some(call => /plugins|banking|social|video/.test(call.path)), false);
  view.failStream(2, 'AI_UPSTREAM_ERROR'); await view.flush();
  filingAvailable = false; view.current.reconnect(); await view.flush();
  view.current.retry(); await view.flush();
  assert.equal(view.current.messageError, '');
  assert.equal(view.current.draft, 'Read the SEC filing');
  assert.equal(view.streams.length, 3); assert.equal(view.appCalls.length, 1);
});
