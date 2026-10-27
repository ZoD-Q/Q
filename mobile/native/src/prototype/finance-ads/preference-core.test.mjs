import { test } from "node:test";
import assert from "node:assert/strict";
import { AD_PREFERENCE_KEY, createAdPreferenceStore, decodeAdPreferences, displayPreferences } from "./preference-core.ts";

const initial = { enabled: true, hiddenCampaignIds: [] };
const encoded = value => JSON.stringify(value);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memory(value = null, hooks = {}) {
  const state = { value, operations: [] };
  return {
    state,
    storage: {
      async get(key) { state.operations.push(["get", key]); const captured = state.value; await hooks.get?.(); return captured; },
      async set(key, value) { state.operations.push(["set", key, value]); await hooks.set?.(value); state.value = value; },
    },
  };
}

test("preference hydration gates display; an empty store permits demos only after loading", async () => {
  const gate = deferred();
  const db = memory(null, { get: () => gate.promise });
  const store = createAdPreferenceStore(db.storage);
  assert.equal(displayPreferences(store.getSnapshot()), null);
  const first = store.hydrate();
  assert.equal(store.hydrate(), first, "React effect replay shares the read");
  assert.equal(await store.setEnabled(false), false, "controls cannot replace unread preferences");
  assert.equal(displayPreferences(store.getSnapshot()), null);
  gate.resolve();
  assert.equal(await first, true);
  assert.deepEqual(displayPreferences(store.getSnapshot()), initial);
  assert.deepEqual(db.state.operations, [["get", AD_PREFERENCE_KEY]]);
});

test("saved opt-out and campaign refusals survive a new store and global re-enable", async () => {
  const db = memory(encoded({ enabled: false, hiddenCampaignIds: ["demo-insurance-overview"] }));
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  assert.equal(store.getSnapshot().preferences.enabled, false);
  await store.setEnabled(true);
  assert.deepEqual(store.getSnapshot().preferences.hiddenCampaignIds, ["demo-insurance-overview"]);
  const restarted = createAdPreferenceStore(db.storage);
  await restarted.hydrate();
  assert.deepEqual(restarted.getSnapshot().preferences, store.getSnapshot().preferences);
});

test("corrupt, unknown and excessive data are rejected, never treated as permission", async () => {
  for (const raw of ["", "null", "[]", "{", encoded({ enabled: 1, hiddenCampaignIds: [] }), encoded({ ...initial, accountId: "private" }), encoded({ enabled: true, hiddenCampaignIds: [42] }), encoded({ enabled: true, hiddenCampaignIds: Array.from({ length: 25 }, (_, i) => `demo-${i}`) }), "x".repeat(2049)]) {
    assert.throws(() => decodeAdPreferences(raw));
    const db = memory(raw);
    const store = createAdPreferenceStore(db.storage);
    assert.equal(await store.hydrate(), false);
    assert.equal(store.getSnapshot().error, "read");
    assert.equal(displayPreferences(store.getSnapshot()), null);
    await store.hydrate();
    assert.equal(db.state.operations.length, 1, "a remount does not silently reset unreadable settings");
  }
});

test("a failed read stays hidden until an explicit successful retry", async () => {
  let fail = true;
  const db = memory(encoded({ enabled: false, hiddenCampaignIds: [] }), { get() { if (fail) throw Error("storage"); } });
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  assert.equal(displayPreferences(store.getSnapshot()), null);
  fail = false;
  assert.equal(await store.retry(), true);
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().preferences.enabled, false);
});

test("superseded delayed reads cannot publish a stale display decision", async () => {
  const entered = deferred(), gate = deferred();
  let first = true;
  const db = memory(null, { async get() { if (first) { first = false; entered.resolve(); await gate.promise; } } });
  const store = createAdPreferenceStore(db.storage);
  const loading = store.hydrate();
  await entered.promise;
  db.state.value = encoded({ enabled: false, hiddenCampaignIds: [] });
  const retry = store.retry();
  const observed = [];
  store.subscribe(() => observed.push(displayPreferences(store.getSnapshot())));
  gate.resolve();
  assert.equal(await loading, false);
  assert.equal(await retry, true);
  assert.equal(observed.some(value => value?.enabled), false);
  assert.equal(store.getSnapshot().preferences.enabled, false);
});

test("writes serialize; a delayed enable cannot publish over a later refusal", async () => {
  const entered = deferred(), gate = deferred();
  const db = memory(encoded({ enabled: false, hiddenCampaignIds: [] }), { async set(value) { if (JSON.parse(value).enabled) { entered.resolve(); await gate.promise; } } });
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  const enabling = store.setEnabled(true);
  await entered.promise;
  const disabling = store.setEnabled(false);
  assert.equal(store.getSnapshot().preferences.enabled, false);
  assert.equal(displayPreferences(store.getSnapshot()), null);
  gate.resolve();
  assert.equal(await enabling, false);
  assert.equal(await disabling, true);
  assert.equal(store.getSnapshot().preferences.enabled, false);
  assert.equal(JSON.parse(db.state.value).enabled, false);
  assert.deepEqual(db.state.operations.map(([operation]) => operation), ["get", "set", "set"]);
});

test("rapid operations coalesce while preserving hidden campaigns and the latest toggle", async () => {
  const db = memory();
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  const close = store.hideCampaign("demo-finance-overview");
  const disable = store.setEnabled(false);
  const enable = store.setEnabled(true);
  await Promise.all([close, disable, enable]);
  const saved = JSON.parse(db.state.value);
  assert.deepEqual(saved, { enabled: true, hiddenCampaignIds: ["demo-finance-overview"] });
  assert.equal(db.state.operations.filter(([operation]) => operation === "set").length, 1);
  assert.deepEqual(Object.keys(saved).sort(), ["enabled", "hiddenCampaignIds"], "no account, interaction or financial data is persisted");
});

test("failed refusal stays applied; hydrate does not restore old preferences and retry saves current intent", async () => {
  let fail = true;
  const db = memory(encoded(initial), { set() { if (fail) throw Error("storage full"); } });
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  const saving = store.hideCampaign("demo-finance-overview");
  assert.deepEqual(store.getSnapshot().preferences.hiddenCampaignIds, ["demo-finance-overview"]);
  assert.equal(displayPreferences(store.getSnapshot()), null);
  assert.equal(await saving, false);
  assert.equal(store.getSnapshot().error, "write");
  assert.equal(displayPreferences(store.getSnapshot()), null);
  await store.hydrate();
  assert.deepEqual(store.getSnapshot().preferences.hiddenCampaignIds, ["demo-finance-overview"]);
  assert.equal(db.state.operations.filter(([operation]) => operation === "get").length, 1);
  fail = false;
  await store.retry();
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(JSON.parse(db.state.value).hiddenCampaignIds, ["demo-finance-overview"]);
});

test("an older failed write does not poison a newer successful opt-out", async () => {
  const entered = deferred(), gate = deferred();
  let first = true;
  const db = memory(null, { async set() { if (first) { first = false; entered.resolve(); await gate.promise; throw Error("old failure"); } } });
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  const close = store.hideCampaign("demo-insurance-overview");
  await entered.promise;
  const disable = store.setEnabled(false);
  gate.resolve();
  await Promise.all([close, disable]);
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(JSON.parse(db.state.value), { enabled: false, hiddenCampaignIds: ["demo-insurance-overview"] });
});

test("a failed global opt-out remains disabled immediately and after an explicit retry", async () => {
  let fail = true;
  const db = memory(null, { set() { if (fail) throw Error("storage"); } });
  const store = createAdPreferenceStore(db.storage);
  await store.hydrate();
  const disabling = store.setEnabled(false);
  assert.equal(store.getSnapshot().preferences.enabled, false);
  await disabling;
  assert.equal(displayPreferences(store.getSnapshot()), null);
  fail = false;
  await store.retry();
  assert.equal(store.getSnapshot().preferences.enabled, false);
  assert.equal(JSON.parse(db.state.value).enabled, false);
});
