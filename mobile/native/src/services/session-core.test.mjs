import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "./session-core.ts";

test('logical invalidation notifies all consumers and survives a failed physical removal', async () => {
  const db = memory('alice', { remove: async () => { throw Error('storage'); } });
  const store = createSessionStore(db.storage), events = [];
  await store.readSnapshot(); store.subscribe(token => events.push(token));
  const before = store.getRevision(); store.invalidateToken('alice');
  assert.equal(store.getRevision(), before + 1); assert.deepEqual(events, [null]);
  await assert.rejects(store.removeToken('alice'));
  assert.equal(await store.readToken(), null); assert.equal((await store.readSnapshot()).token, null);
  assert.equal(await store.writeToken('alice'), false);
  assert.equal(await store.writeToken('bob'), true); assert.equal(await store.readToken(), 'bob');
  const revision = store.getRevision(); store.invalidateToken('alice');
  assert.equal(store.getRevision(), revision); assert.equal(await store.readToken(), 'bob');
  assert.deepEqual(events, [null, 'bob']);
});

test('a token invalidated during an unguarded delayed write cannot be published afterward', async () => {
  const entered = deferred(), gate = deferred();
  const db = memory(null, { set: async value => { if (value === 'alice') { entered.resolve(); await gate.promise; } } });
  const store = createSessionStore(db.storage), events = []; store.subscribe(token => events.push(token));
  const writing = store.writeToken('alice'); await entered.promise;
  store.invalidateToken('alice'); gate.resolve();
  assert.equal(await writing, false); assert.equal(await store.readToken(), null);
  assert.equal(events.includes('alice'), false);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function memory(initial = null, hooks = {}) {
  const state = { value: initial, operations: [] };
  return {
    state,
    storage: {
      async get() { state.operations.push(["get"]); await hooks.get?.(); return state.value; },
      async set(token) { state.operations.push(["set", token]); await hooks.set?.(token); state.value = token; await hooks.afterSet?.(token); },
      async remove() { state.operations.push(["remove"]); await hooks.remove?.(); state.value = null; },
    },
  };
}

test("a delayed new login and old conditional logout serialize without deleting the new session", async () => {
  const entered = deferred(), gate = deferred();
  const db = memory("old", { set: async token => { if (token === "new") { entered.resolve(); await gate.promise; } } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  const write = store.writeToken("new");
  await entered.promise;
  const clearOld = store.removeToken("old");
  const read = store.readToken();
  gate.resolve();
  assert.equal(await write, true);
  assert.equal(await clearOld, false);
  assert.equal(await read, "new");
  assert.equal(db.state.value, "new");
  assert.deepEqual(events, ["new"]);
  assert.equal(db.state.operations.some(([operation]) => operation === "remove"), false);
});

test("guard invalidation during set rolls back before a queued new login can run", async () => {
  const entered = deferred(), gate = deferred();
  let current = true;
  const db = memory("previous", { set: async token => { if (token === "stale") { entered.resolve(); await gate.promise; } } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  const stale = store.writeToken("stale", () => current);
  await entered.promise;
  const next = store.writeToken("latest");
  current = false; gate.resolve();
  assert.equal(await stale, false);
  assert.equal(await next, true);
  assert.equal(await store.readToken(), "latest");
  assert.deepEqual(events, ["latest"]);
  assert.deepEqual(db.state.operations.filter(([operation]) => operation === "set"), [["set", "stale"], ["set", "previous"], ["set", "latest"]]);
});

test("a stale write restores an originally empty store with remove, not a fake token", async () => {
  const entered = deferred(), gate = deferred();
  let current = true;
  const db = memory(null, { set: async () => { entered.resolve(); await gate.promise; } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  const pending = store.writeToken("cancelled", () => current);
  await entered.promise; current = false; gate.resolve();
  assert.equal(await pending, false);
  assert.equal(await store.readToken(), null);
  assert.deepEqual(db.state.operations, [["get"], ["set", "cancelled"], ["remove"], ["get"]]);
  assert.deepEqual(events, []);
});

test("guard is rechecked after reading the previous token and fails closed if it throws", async () => {
  const entered = deferred(), gate = deferred();
  let current = true;
  const db = memory("previous", { get: async () => { entered.resolve(); await gate.promise; } });
  const store = createSessionStore(db.storage);
  const pending = store.writeToken("stale", () => current);
  await entered.promise; current = false; gate.resolve();
  assert.equal(await pending, false);
  assert.equal(db.state.value, "previous");
  assert.deepEqual(db.state.operations, [["get"]]);
  assert.equal(await store.writeToken("never", () => { throw new Error("guard failure"); }), false);
  assert.deepEqual(db.state.operations, [["get"]]);
});

test("reads share the write queue and do not broadcast restore notifications", async () => {
  const entered = deferred(), gate = deferred();
  let first = true;
  const db = memory("A", { get: async () => { if (first) { first = false; entered.resolve(); await gate.promise; } } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  const readA = store.readToken();
  await entered.promise;
  const writeB = store.writeToken("B");
  const readB = store.readToken();
  gate.resolve();
  assert.equal(await readA, "A");
  assert.equal(await writeB, true);
  assert.equal(await readB, "B");
  assert.deepEqual(events, ["B"]);
});

test("same-value writes and no-op removals do not notify, and unsubscription is respected", async () => {
  const db = memory("A");
  const store = createSessionStore(db.storage);
  const events = [];
  const unsubscribe = store.subscribe(token => events.push(token));
  assert.equal(await store.writeToken("A"), true);
  assert.equal(await store.removeToken("stale"), false);
  assert.deepEqual(events, []);
  assert.equal(await store.writeToken("B"), true);
  assert.equal(await store.removeToken("B"), true);
  assert.equal(await store.removeToken(), false);
  assert.deepEqual(events, ["B", null]);
  unsubscribe(); unsubscribe();
  await store.writeToken("C");
  assert.deepEqual(events, ["B", null]);
});

test("throwing and rejecting subscribers cannot break other subscribers or operations", async () => {
  const db = memory();
  const store = createSessionStore(db.storage);
  const events = [];
  store.subscribe(() => { throw new Error("listener failure"); });
  store.subscribe(async () => { throw new Error("async listener failure"); });
  store.subscribe(token => events.push(token));
  assert.equal(await store.writeToken("A"), true);
  assert.equal(await store.removeToken(), true);
  await Promise.resolve();
  assert.deepEqual(events, ["A", null]);
  assert.equal(await store.readToken(), null);
});

test("a subscriber may enqueue a read without deadlocking the write broadcast", async () => {
  const db = memory();
  const store = createSessionStore(db.storage);
  let nextRead;
  store.subscribe(() => { nextRead = store.readToken(); });
  await store.writeToken("A");
  assert.equal(await nextRead, "A");
});

test("storage failures reject one operation without poisoning later queued work", async () => {
  let getFails = true, removeFails = true;
  const db = memory("A", {
    get: async () => { if (getFails) { getFails = false; throw new Error("read failed"); } },
    remove: async () => { if (removeFails) { removeFails = false; throw new Error("remove failed"); } },
  });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  const failedRead = store.readToken();
  const goodWrite = store.writeToken("B");
  await assert.rejects(failedRead, /read failed/);
  assert.equal(await goodWrite, true);
  await assert.rejects(store.removeToken("B"), /remove failed/);
  assert.equal(await store.removeToken("B"), true);
  assert.deepEqual(events, ["B", null]);
});

test("a set failure after mutation rolls back silently and still allows later login", async () => {
  const db = memory("previous", { afterSet: async token => { if (token === "broken") throw new Error("set failed after mutation"); } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  await assert.rejects(store.writeToken("broken"), /set failed after mutation/);
  assert.equal(db.state.value, "previous");
  assert.deepEqual(events, []);
  assert.equal(await store.writeToken("latest"), true);
  assert.equal(await store.readToken(), "latest");
  assert.deepEqual(events, ["latest"]);
});

test("failed rollback is reported, never broadcast as success, and does not freeze the queue", async () => {
  let guard = true, failRollback = true;
  const db = memory("previous", { afterSet: async token => { if (token === "stale") guard = false; }, set: async token => { if (token === "previous" && failRollback) { failRollback = false; throw new Error("rollback failed"); } } });
  const store = createSessionStore(db.storage);
  const events = []; store.subscribe(token => events.push(token));
  await assert.rejects(store.writeToken("stale", () => guard), /rollback failed/);
  assert.deepEqual(events, []);
  assert.equal(await store.writeToken("new"), true);
  assert.equal(await store.readToken(), "new");
  assert.deepEqual(events, ["new"]);
});

test("a delayed snapshot pairs its token with the revision before a queued write", async () => {
  const entered = deferred(), gate = deferred();
  let delay = true;
  const db = memory("original", { get: async () => { if (delay) { delay = false; entered.resolve(); await gate.promise; } } });
  const store = createSessionStore(db.storage);
  const snapshot = store.readSnapshot();
  await entered.promise;
  const write = store.writeToken("new");
  assert.equal(store.getRevision(), 0);
  gate.resolve();
  assert.deepEqual(await snapshot, { token: "original", revision: 0 });
  assert.equal(await write, true);
  assert.deepEqual(await store.readSnapshot(), { token: "new", revision: 1 });
  assert.equal(store.getRevision(), 1);
});

test("snapshot queued behind a delayed write sees both the new token and new revision", async () => {
  const entered = deferred(), gate = deferred();
  const db = memory(null, { set: async () => { entered.resolve(); await gate.promise; } });
  const store = createSessionStore(db.storage);
  const write = store.writeToken("new");
  await entered.promise;
  const snapshot = store.readSnapshot();
  assert.equal(store.getRevision(), 0);
  gate.resolve();
  await write;
  assert.deepEqual(await snapshot, { token: "new", revision: 1 });
});

test("revision increments exactly once before each committed mutation is broadcast", async () => {
  const db = memory();
  const store = createSessionStore(db.storage);
  const events = [];
  store.subscribe(token => events.push({ token, revision: store.getRevision() }));
  await store.readToken();
  await store.readSnapshot();
  assert.equal(store.getRevision(), 0);
  await store.writeToken("A");
  assert.equal(store.getRevision(), 1);
  await store.writeToken("A");
  await store.removeToken("not-A");
  assert.equal(store.getRevision(), 1);
  await store.writeToken("B");
  await store.removeToken("B");
  await store.removeToken();
  assert.equal(store.getRevision(), 3);
  assert.deepEqual(events, [{ token: "A", revision: 1 }, { token: "B", revision: 2 }, { token: null, revision: 3 }]);
});

test("failed writes and guard rollbacks leave revision unchanged", async () => {
  let guard = true;
  const db = memory("previous", { afterSet: async token => {
    if (token === "stale") guard = false;
    if (token === "broken") throw new Error("write failure");
  } });
  const store = createSessionStore(db.storage);
  assert.equal(await store.writeToken("stale", () => guard), false);
  assert.deepEqual(await store.readSnapshot(), { token: "previous", revision: 0 });
  await assert.rejects(store.writeToken("broken"), /write failure/);
  assert.equal(store.getRevision(), 0);
  assert.deepEqual(await store.readSnapshot(), { token: "previous", revision: 0 });
  await store.writeToken("valid");
  assert.equal(store.getRevision(), 1);
});

test("an external logout invalidates a prior restore snapshot even when both UI states look empty", async () => {
  const db = memory("stored-session");
  const store = createSessionStore(db.storage);
  const oldRestore = await store.readSnapshot();
  assert.equal(await store.removeToken("stored-session"), true);
  assert.notEqual(store.getRevision(), oldRestore.revision);
  assert.deepEqual(await store.readSnapshot(), { token: null, revision: 1 });
});
