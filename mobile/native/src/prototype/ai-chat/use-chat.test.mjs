import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as core from '../api-workbench/core.ts';
import * as stream from './stream.ts';
import * as stateModel from './state-model.ts';
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
function harness({ stored = token, statusFetch = async () => json(configured), meFetch = async () => json(user) } = {}) {
  const slots = [], calls = [], timers = new Map(), streams = [];
  let cursor = 0, dirty = true, visible = true, mounted = true, pendingEffects = [], result, now = 0;
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
      throw new Error('Unexpected network action');
    } },
    'expo-crypto': { randomUUID: () => `fixture-${calls.length}-${streams.length}` },
    '../../services/api': { API_URL: 'https://review.invalid' },
    '../../services/session-store': { ...session, readSessionSnapshot: session.readSnapshot, getSessionRevision: session.getRevision, subscribeSession: session.subscribe },
    '../api-workbench/core': core,
    './stream': { ...stream, streamChat: options => {
      streams.push(options);
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new stream.ChatError('CANCELLED')), { once: true }));
    } },
    './state-model': stateModel,
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
    calls, streams,
    token: () => stored,
    grantConsent: () => consent.grant(token),
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
