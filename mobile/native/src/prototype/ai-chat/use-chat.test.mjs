import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from '../api-workbench/core.ts';
import * as stream from './stream.ts';
import * as stateModel from './state-model.ts';
import * as history from './history.ts';
import { createAiStatusMonitor } from './status-monitor.ts';
import { createAiConsentGate, createAiPermission } from './consent.ts';
import { createSessionStore } from '../../services/session-core.ts';

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
  historyFetch = async () => new Response('', { status: 404 }), historySave,
} = {}) {
  const slots = [], calls = [], timers = new Map(), streams = [], streamCompletions = [], historyPosts = [], ordering = [];
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
  const imports = {
    react,
    'expo/fetch': { fetch: async (url, options) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: options.method, signal: options.signal });
      if (path === '/v1/ai/status') return statusFetch(options);
      if (path === '/v1/me') return meFetch(options);
      if (path === '/v1/ai/conversations') return historyFetch(options);
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
    './stream': { ...stream, streamChat: options => {
      streams.push(options); ordering.push('chat:POST');
      return new Promise((resolve, reject) => {
        streamCompletions.push(resolve);
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
  }, AbortController });
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
    finishStream(index = 0) {
      streams[index].onEvent({ type: 'delta', text: 'fixture answer' });
      streams[index].onEvent({ type: 'done', model: 'deepseek-flash', finish_reason: 'stop' });
      streamCompletions[index]();
    },
    async flush() { for (let i = 0; i < 80; i++) { await Promise.resolve(); if (dirty && mounted) render(); } },
    setVisible(value) { visible = value; if (mounted) render(); },
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
