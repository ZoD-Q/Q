import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountController } from './account-core.ts';
import { createSessionStore } from '../../services/session-core.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const user = id => ({ id, handle: id, display_name: id, avatar: 'orbit', bio: '', theme: 'light', locale: 'zh-CN', created_at: '2026-10-19T00:00:00Z' });
function fixture(overrides = {}, initial = null) {
  let token = initial;
  const storage = { get: async () => token, set: async value => { token = value; }, remove: async () => { token = null; } };
  const store = createSessionStore(storage);
  const deps = { store, user: async value => user(value), authenticate: async (_, fields) => ({ token: fields.handle, user: user(fields.handle) }),
    revoke: async () => {}, patch: async (value, fields) => ({ ...user(value), ...fields }), ...overrides };
  const controller = createAccountController(deps);
  controller.start();
  return { controller, store, storage, get token() { return token; } };
}
test('changing the shared session clears the old identity before a new profile request finishes', async () => {
  const late = deferred();
  const f = fixture({ user: async token => token === 'bob' ? late.promise : user(token) }, 'alice');
  await tick();
  assert.equal(f.controller.getSnapshot().session.user.id, 'alice');
  await f.store.writeToken('bob');
  assert.equal(f.controller.getSnapshot().session, null);
  late.resolve(user('bob')); await tick();
  assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  f.controller.stop();
});
test('late profile restoration cannot restore a logged out session', async () => {
  const late = deferred();
  const f = fixture({ user: () => late.promise }, 'alice'); await tick();
  await f.store.removeToken('alice');
  late.resolve(user('alice')); await tick();
  assert.equal(f.controller.getSnapshot().session, null);
  assert.equal(f.token, null); f.controller.stop();
});
test('cancelled sign in cannot write a delayed token', async () => {
  const late = deferred();
  const f = fixture({ authenticate: () => late.promise }); await tick();
  f.controller.requestAuth();
  const result = f.controller.authenticate('login', { handle: 'alice', password: 'private' });
  f.controller.closeAuth();
  late.resolve({ token: 'alice', user: user('alice') });
  assert.equal(await result, false); assert.equal(f.token, null); assert.equal(f.controller.getSnapshot().session, null);
  f.controller.stop();
});
test('sign in does not replace a newer externally installed account', async () => {
  const late = deferred();
  const f = fixture({ authenticate: () => late.promise }); await tick();
  const result = f.controller.authenticate('login', { handle: 'alice', password: 'private' });
  await f.store.writeToken('bob'); await tick();
  late.resolve({ token: 'alice', user: user('alice') });
  assert.equal(await result, false); assert.equal(f.token, 'bob'); assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  f.controller.stop();
});
test('own sign in publishes one real account and closes the form', async () => {
  const f = fixture(); await tick(); f.controller.requestAuth();
  assert.equal(await f.controller.authenticate('login', { handle: 'alice', password: 'private' }), true);
  assert.equal(f.token, 'alice'); assert.equal(f.controller.getSnapshot().session.user.id, 'alice');
  assert.equal(f.controller.getSnapshot().authOpen, false); assert.equal(f.controller.getSnapshot().authBusy, false);
  f.controller.stop();
});
test('logout removes locally and still revokes remotely without cancelling its own request', async () => {
  let revoked = false;
  const f = fixture({ revoke: async (_, signal) => { await tick(); assert.equal(signal.aborted, false); revoked = true; } }, 'alice'); await tick();
  await f.controller.logout();
  assert.equal(f.token, null); assert.equal(revoked, true); assert.equal(f.controller.getSnapshot().session, null);
  assert.equal(f.controller.getSnapshot().authBusy, false); assert.equal(f.controller.getSnapshot().error, ''); f.controller.stop();
});
test('a local logout storage failure does not skip remote revocation or display stale profile', async () => {
  let revoked = false;
  const f = fixture({ revoke: async () => { revoked = true; } }, 'alice'); await tick();
  f.storage.remove = async () => { throw Error('storage'); };
  await f.controller.logout();
  assert.equal(revoked, true); assert.equal(f.controller.getSnapshot().session, null);
  assert.equal(f.controller.getSnapshot().logoutError, 'STORAGE_ERROR'); f.controller.stop();
});
test('late profile edits cannot change a replacement account', async () => {
  const late = deferred();
  const f = fixture({ patch: () => late.promise }, 'alice'); await tick();
  const result = f.controller.updateProfile({ display_name: 'New Alice' });
  await f.store.writeToken('bob'); await tick();
  late.resolve({ ...user('alice'), display_name: 'New Alice' });
  assert.equal(await result, false); assert.equal(f.controller.getSnapshot().session.user.id, 'bob'); f.controller.stop();
});
test('profile writes are serially admitted so a stale response cannot overwrite a newer choice', async () => {
  const late = deferred(); let calls = 0;
  const f = fixture({ patch: () => { calls++; return late.promise; } }, 'alice'); await tick();
  const first = f.controller.updateProfile({ theme: 'warm' });
  assert.equal(await f.controller.updateProfile({ theme: 'dark' }), false); assert.equal(calls, 1);
  late.resolve({ ...user('alice'), theme: 'warm' }); assert.equal(await first, true);
  assert.equal(f.controller.getSnapshot().profileBusy, false); f.controller.stop();
});
test('backgrounding and foreground restoration cannot cancel an explicit logout or revive a failed local removal', async () => {
  const remote = deferred(); let revokeSignal;
  const f = fixture({ revoke: async (_, signal) => { revokeSignal = signal; await remote.promise; } }, 'alice'); await tick();
  const originalRemove = f.storage.remove;
  f.storage.remove = async () => { throw Error('temporary storage failure'); };
  const signingOut = f.controller.logout();
  f.controller.closeAuth(); // AppState background notification.
  await f.controller.refresh(); // Foreground while server revocation is pending.
  assert.equal(revokeSignal.aborted, false);
  assert.equal(f.controller.getSnapshot().session, null);
  remote.resolve(); await signingOut;
  assert.equal(f.controller.getSnapshot().logoutError, 'STORAGE_ERROR');
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().session, null);
  assert.equal(f.controller.getSnapshot().logoutPending, true);
  f.storage.remove = originalRemove;
  await f.controller.logout();
  assert.equal(f.token, null); assert.equal(f.controller.getSnapshot().logoutPending, false);
  f.controller.stop();
});
test('a failed server sign out remains retryable after the local credential has already been removed', async () => {
  let calls = 0;
  const f = fixture({ revoke: async () => { calls++; if (calls === 1) throw { code: 'NETWORK_ERROR' }; } }, 'alice'); await tick();
  await f.controller.logout();
  assert.equal(f.token, null); assert.equal(f.controller.getSnapshot().logoutError, 'LOGOUT_UNCONFIRMED');
  f.controller.closeAuth();
  assert.equal(f.controller.getSnapshot().logoutError, 'LOGOUT_UNCONFIRMED');
  await f.controller.logout();
  assert.equal(calls, 2); assert.equal(f.controller.getSnapshot().logoutPending, false); f.controller.stop();
});
test('failed local sign out invalidates the shared store immediately for AI and all other consumers', async () => {
  const remote = deferred(); const events = [];
  const f = fixture({ revoke: () => remote.promise }, 'alice'); await tick();
  f.store.subscribe(token => events.push(token));
  f.storage.remove = async () => { throw Error('storage failure'); };
  const result = f.controller.logout();
  assert.equal(events.at(-1), null);
  assert.equal(await f.store.readToken(), null);
  assert.equal((await f.store.readSnapshot()).token, null);
  remote.reject({ code: 'NETWORK_ERROR' }); await result;
  assert.equal(f.token, 'alice'); // Physical failure does not mean the logical credential remains usable.
  await f.controller.refresh(); assert.equal(f.controller.getSnapshot().session, null);
  f.controller.stop();
});
test('an external account arriving during revocation is restored after logout finishes', async () => {
  const remote = deferred();
  const f = fixture({ revoke: () => remote.promise }, 'alice'); await tick();
  const result = f.controller.logout(); await tick();
  await f.store.writeToken('bob'); await tick();
  remote.resolve(); await result; await tick();
  assert.equal(f.token, 'bob'); assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  assert.equal(f.controller.getSnapshot().loading, false); assert.equal(f.controller.getSnapshot().logoutPending, false);
  f.controller.stop();
});
test('retrying a failed old revocation preserves a newly signed-in account and targets the old token', async () => {
  const oldRevocation = deferred(), calls = [];
  const f = fixture({ revoke: async token => { calls.push(token); if (calls.length === 1) await oldRevocation.promise; } }, 'alice'); await tick();
  const first = f.controller.logout(); await tick();
  await f.store.writeToken('bob'); await tick();
  assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  oldRevocation.reject({ code: 'NETWORK_ERROR' }); await first;
  assert.equal(f.controller.getSnapshot().logoutError, 'LOGOUT_UNCONFIRMED');
  assert.equal(f.controller.getSnapshot().logoutPending, true);
  await f.controller.retryLogout();
  assert.deepEqual(calls, ['alice', 'alice']);
  assert.equal(f.token, 'bob'); assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  assert.equal(f.controller.getSnapshot().logoutPending, false); assert.equal(f.controller.getSnapshot().logoutError, '');
  f.controller.stop();
});
test('independent pending revocations are not lost when the current account also signs out', async () => {
  const calls = [], counts = new Map();
  const f = fixture({ revoke: async token => { calls.push(token); const count = (counts.get(token) ?? 0) + 1; counts.set(token, count); if (token === 'alice' && count < 3) throw { code: 'NETWORK_ERROR' }; } }, 'alice'); await tick();
  await f.controller.logout();
  await f.store.writeToken('bob'); await tick();
  await f.controller.logout();
  assert.equal(f.controller.getSnapshot().session, null); assert.equal(f.controller.getSnapshot().logoutPending, true);
  await f.controller.retryLogout();
  assert.deepEqual(calls, ['alice', 'alice', 'bob', 'alice']);
  assert.equal(f.token, null); assert.equal(f.controller.getSnapshot().logoutPending, false);
  f.controller.stop();
});
test('a new authenticated login survives a slow physical cleanup of a logically invalidated token', async () => {
  const entered = deferred(), gate = deferred();
  const f = fixture({}, 'alice'); await tick();
  const remove = f.storage.remove;
  f.storage.remove = async () => { entered.resolve(); await gate.promise; await remove(); };
  const oldLogout = f.controller.logout(); await entered.promise;
  const login = f.controller.authenticate('login', { handle: 'bob', password: 'private' });
  await tick(); gate.resolve();
  await oldLogout; assert.equal(await login, true);
  assert.equal(f.token, 'bob'); assert.equal(f.controller.getSnapshot().session.user.id, 'bob');
  f.controller.stop();
});
