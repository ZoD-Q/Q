import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from '../api-workbench/core.ts';
import * as stream from './stream.ts';
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
const history = await import('./history.ts');
const pluginCore = await import('../plugin-host/core.ts');
const bankIntent = await import('../banking/intent.ts');
const bankCatalog = await import('../banking/catalog.ts');
const bankData = await import('../banking/data.ts');
const financeConversation = await import('../finance-agent/conversation.ts');
const financeIntent = await import('../finance-agent/intent.ts');
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
  historyFetch = async () => new Response('', { status: 404 }), historySave, historyDetail, bankFetch,
} = {}) {
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
  }, AbortController, Error });
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
    calls, streams, historyPosts, ordering,
    token: () => stored,
    grantConsent: () => consent.grant(stored),
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
