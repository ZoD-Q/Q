import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiStatusMonitor } from './status-monitor.ts';

const configured = { configured: true, models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }] };
const unavailable = { configured: false, models: [] };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function clock() {
  let now = 0;
  const timers = new Map();
  return {
    schedule(callback, delay) {
      const entry = { at: now + delay, callback };
      timers.set(entry, entry);
      return () => timers.delete(entry);
    },
    advance(duration) {
      now += duration;
      for (const timer of [...timers.values()].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.delete(timer)) timer.callback();
      }
    },
    count: () => timers.size,
  };
}

test('a delayed initial check stays checking until a valid configuration response arrives', async () => {
  const pending = deferred();
  const updates = [];
  const monitor = createAiStatusMonitor({ load: () => pending.promise, onChange: value => updates.push(value) });
  monitor.refresh();
  await flush();
  assert.deepEqual(monitor.getSnapshot(), { phase: 'checking', status: null, error: '' });
  pending.resolve(configured);
  await flush();
  assert.deepEqual(monitor.getSnapshot(), { phase: 'ready', status: configured, error: '' });
  assert.equal(updates.some(value => value.phase === 'unconfigured' || value.phase === 'error'), false);
  monitor.pause();
});

test('safe GET failures use exactly two bounded backoffs before recovery', async () => {
  const time = clock();
  let calls = 0;
  const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: async () => {
    calls++;
    if (calls === 1) throw { code: 'NETWORK_ERROR', status: 0 };
    if (calls === 2) throw { code: 'REQUEST_FAILED', status: 503 };
    return configured;
  } });
  monitor.refresh(); await flush();
  assert.equal(calls, 1);
  assert.equal(monitor.getSnapshot().phase, 'checking');
  time.advance(999); await flush(); assert.equal(calls, 1);
  time.advance(1); await flush(); assert.equal(calls, 2);
  time.advance(2999); await flush(); assert.equal(calls, 2);
  time.advance(1); await flush(); assert.equal(calls, 3);
  assert.equal(monitor.getSnapshot().phase, 'ready');
  assert.equal(time.count(), 0);
  monitor.pause();
});

test('exhausted retries preserve last known configuration with an explicit error', async () => {
  const time = clock();
  let fail = false, calls = 0;
  const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: async () => {
    calls++;
    if (fail) throw { code: 'REQUEST_TIMEOUT' };
    return configured;
  } });
  monitor.refresh(); await flush(); fail = true;
  monitor.refresh(); await flush();
  time.advance(1000); await flush(); time.advance(3000); await flush();
  assert.deepEqual(monitor.getSnapshot(), { phase: 'error', status: configured, error: 'REQUEST_TIMEOUT' });
  time.advance(60000); await flush();
  assert.equal(calls, 4);
  assert.equal(time.count(), 0);
  monitor.pause();
});

test('configuration, malformed responses, cancellation and client errors never retry', async () => {
  for (const failure of [
    { code: 'INSECURE_API_URL' }, { code: 'INVALID_RESPONSE' }, { code: 'CANCELLED' },
    { code: 'UNAUTHORIZED', status: 401 }, { code: 'REQUEST_FAILED', status: 404 },
    { code: 'RATE_LIMITED', status: 429 }, { code: 'INSECURE_API_URL', status: 503 },
  ]) {
    const time = clock(); let calls = 0;
    const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: async () => { calls++; throw failure; } });
    monitor.refresh(); await flush(); time.advance(60000); await flush();
    assert.equal(calls, 1, failure.code);
    assert.equal(monitor.getSnapshot().phase, 'error');
    assert.equal(time.count(), 0);
    monitor.pause();
  }
});

test('hidden views cancel queued retry and foreground refresh starts a fresh cycle', async () => {
  const time = clock(); let calls = 0;
  const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: async () => {
    if (++calls === 1) throw { code: 'NETWORK_ERROR' };
    return configured;
  } });
  monitor.refresh(); await flush(); monitor.pause();
  time.advance(60000); await flush(); assert.equal(calls, 1);
  monitor.refresh(); await flush(); assert.equal(calls, 2);
  assert.equal(monitor.getSnapshot().phase, 'ready');
  monitor.pause();
});

test('late responses cannot overwrite a newer configuration check', async () => {
  const old = deferred(), latest = deferred();
  const signals = [], updates = [];
  const monitor = createAiStatusMonitor({ onChange: value => updates.push(value), load: signal => {
    signals.push(signal);
    return signals.length === 1 ? old.promise : latest.promise;
  } });
  monitor.refresh(); monitor.refresh();
  assert.equal(signals[0].aborted, true);
  latest.resolve(configured); await flush();
  old.resolve(unavailable); await flush();
  assert.equal(monitor.getSnapshot().phase, 'ready');
  const count = updates.length;
  monitor.refresh(); monitor.pause();
  await flush();
  assert.equal(updates.length, count + 1);
});

test('a late failure from a cancelled check cannot schedule retries or replace a healthy result', async () => {
  const time = clock(), old = deferred(); let calls = 0;
  const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: () => ++calls === 1 ? old.promise : Promise.resolve(configured) });
  monitor.refresh(); monitor.refresh(); await flush();
  old.reject({ code: 'NETWORK_ERROR' }); await flush(); time.advance(60000); await flush();
  assert.equal(monitor.getSnapshot().phase, 'ready');
  assert.equal(calls, 2);
  assert.equal(time.count(), 0);
  monitor.pause();
});

test('only a successful configured false response declares the service unconfigured', async () => {
  const time = clock(); let calls = 0;
  const monitor = createAiStatusMonitor({ schedule: time.schedule, onChange: () => {}, load: async () => { calls++; return unavailable; } });
  monitor.refresh(); await flush(); time.advance(60000); await flush();
  assert.deepEqual(monitor.getSnapshot(), { phase: 'unconfigured', status: unavailable, error: '' });
  assert.equal(calls, 1);
  monitor.pause();
});
