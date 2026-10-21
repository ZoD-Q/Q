import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import {
  createDeletionController, createDeletionStore, decodeDeletionIntent, decodeDeletionReceipt, encodeDeletionRecovery,
  DELETION_INDEX_KEY, DELETION_LEGACY_KEY, DELETION_PENDING_LIMIT, deletionOwnerKey,
} from './deletion-core.ts';
import { createSessionStore } from '../../services/session-core.ts';
import { createOutboxStore } from '../social/core.ts';

const resolver = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './core' && context.parentURL?.includes('/prototype/social/')) return next('./core.ts', context);
  return next(specifier, context);
} });
const { createReportStore } = await import('../social/report-core.ts');
resolver.deregister();

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_REQUEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = Buffer.alloc(32, 7).toString('base64url');
const PASSWORD = 'private-password';
const ACTOR_A = { ownerId: OWNER_A, token: 'original-session-A' };
const ACTOR_B = { ownerId: OWNER_B, token: 'replacement-session-B' };
const hash = async value => createHash('sha256').update(value).digest('hex');
const receipt = (request = REQUEST) => ({ request_id: request, status: 'deleted', completed_at: '2026-10-20T06:30:00Z' });
const failure = (code, status = 0) => Object.assign(new Error(code), { code, status });
const missing = () => { throw failure('ACCOUNT_DELETION_NOT_FOUND', 404); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function intent() {
  return { ownerId: OWNER_A, requestId: REQUEST, recoveryToken: SECRET, originalTokenHash: await hash(ACTOR_A.token) };
}
function fixture() {
  const values = new Map();
  let token = ACTOR_A.token;
  const calls = [], events = [];
  const storage = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { assert.ok(Buffer.byteLength(value) < 2048); events.push('persist'); values.set(key, value); },
    remove: async key => { events.push('clear-intent'); values.delete(key); },
  };
  const sessionStorage = {
    get: async () => token,
    set: async value => { token = value; },
    remove: async () => { events.push('remove-token'); token = null; },
  };
  const session = createSessionStore(sessionStorage);
  const deps = {
    pending: createDeletionStore(storage),
    session: {
      ...session,
      invalidateToken: value => { events.push(`invalidate:${value}`); session.invalidateToken(value); },
    },
    createRecovery: async () => { calls.push({ kind: 'generate' }); return { requestId: REQUEST, recoveryToken: SECRET }; },
    hashToken: hash,
    cleanupOwner: async ownerId => { events.push(`purge:${ownerId}`); },
    erase: async (bearer, body, signal) => {
      calls.push({ kind: 'erase', bearer, body, signal }); events.push('erase');
      return receipt();
    },
    lookup: async (body, signal) => { calls.push({ kind: 'lookup', body, signal }); return missing(); },
  };
  const controller = createDeletionController(deps);
  return {
    controller, deps, calls, events, storage, sessionStorage, session, values,
    recreate: () => createDeletionController({ ...deps, pending: createDeletionStore(storage) }),
    get stored() { return values.get(deletionOwnerKey(OWNER_A)) ?? values.get(DELETION_LEGACY_KEY) ?? null; },
    get token() { return token; },
    setStored(value) { values.set(DELETION_LEGACY_KEY, value); },
  };
}
const count = (f, kind) => f.calls.filter(call => call.kind === kind).length;

test('recovery capability encodes exactly 32 bytes as canonical unpadded base64url', () => {
  for (const bytes of [new Uint8Array(32), Uint8Array.from({ length: 32 }, (_, i) => i), new Uint8Array(32).fill(255)]) {
    const encoded = encodeDeletionRecovery(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString('base64url'));
    assert.equal(encoded.length, 43);
  }
  assert.throws(() => encodeDeletionRecovery(new Uint8Array(31)), { code: 'RECOVERY_UNAVAILABLE' });
});

test('pending storage validates IDs, canonical capability, digest and rejects accidental private fields', async () => {
  const value = await intent();
  assert.deepEqual(decodeDeletionIntent(value), value);
  for (const changed of [
    { ownerId: 'not-a-user' }, { requestId: '' }, { recoveryToken: `${'A'.repeat(42)}B` },
    { recoveryToken: SECRET + '=' }, { originalTokenHash: 'bad' }, { password: PASSWORD }, { token: ACTOR_A.token },
  ]) assert.throws(() => decodeDeletionIntent({ ...value, ...changed }), { code: 'STORAGE_ERROR' });
  for (const invalid of [
    null, { ...receipt(), status: 'pending' }, { ...receipt(), request_id: 'bad' },
    { ...receipt(), completed_at: '20' }, { ...receipt(), completed_at: 'not-a-date' },
  ]) assert.throws(() => decodeDeletionReceipt(invalid), { code: 'INVALID_RESPONSE' });
});

test('each owner keeps their own unresolved intent without overwriting another owner or request', async () => {
  const f = fixture(), original = await intent();
  await f.deps.pending.save(original);
  await f.deps.pending.save({ ...original, ownerId: OWNER_B, requestId: OTHER_REQUEST });
  await assert.rejects(f.deps.pending.save({ ...original, requestId: OTHER_REQUEST }), { code: 'DELETION_PENDING' });
  await assert.rejects(f.deps.pending.remove({ ...original, requestId: OTHER_REQUEST }), { code: 'DELETION_PENDING' });
  assert.deepEqual(await f.deps.pending.read(OWNER_A), original);
  assert.equal((await f.deps.pending.read(OWNER_B)).requestId, OTHER_REQUEST);
});

test('delete persists recovery before dispatch, never persists password/bearer, and logically invalidates before cleanup', async () => {
  const f = fixture();
  f.deps.erase = async (bearer, body) => {
    f.events.push('erase');
    assert.equal(bearer, ACTOR_A.token);
    assert.equal(body.password, PASSWORD);
    assert.equal(body.confirmation, 'DELETE');
    const saved = JSON.parse(f.stored);
    assert.equal(saved.requestId, body.request_id);
    assert.equal(saved.recoveryToken, body.recovery_token);
    assert.equal(saved.originalTokenHash, await hash(bearer));
    assert.equal(f.stored.includes(PASSWORD), false);
    assert.equal(f.stored.includes(bearer), false);
    return receipt();
  };
  const published = [];
  f.session.subscribe(value => published.push(value));
  await f.session.readSnapshot();
  assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), true);
  assert.equal(f.token, null);
  assert.equal(f.stored, null);
  assert.deepEqual(published, [null]);
  assert.ok(f.events.indexOf('persist') < f.events.indexOf('erase'));
  assert.ok(f.events.indexOf(`invalidate:${ACTOR_A.token}`) < f.events.indexOf('remove-token'));
  assert.equal(f.controller.getSnapshot().phase, 'deleted');
  assert.equal(f.controller.getSnapshot().pending, null);
});

test('missing password or explicit DELETE confirmation cannot create or send an intent', async () => {
  const f = fixture();
  assert.equal(await f.controller.begin(ACTOR_A, '', 'DELETE'), false);
  assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'delete'), false);
  assert.equal(count(f, 'generate'), 0);
  assert.equal(count(f, 'erase'), 0);
  assert.equal(f.stored, null);
});

test('a failed storage write prevents network dispatch even if the adapter mutated before rejecting', async () => {
  for (const mutationFirst of [false, true]) {
    const f = fixture(), save = f.storage.set;
    f.storage.set = async (key, value) => {
      if (key !== deletionOwnerKey(OWNER_A)) { await save(key, value); return; }
      if (mutationFirst) await save(key, value); throw Error('storage unavailable');
    };
    assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
    assert.equal(count(f, 'erase'), 0);
    assert.equal(count(f, 'lookup'), 0);
    assert.equal(f.controller.getSnapshot().error, 'STORAGE_ERROR');
    assert.equal(!!f.stored, mutationFirst);
    if (mutationFirst) assert.equal(f.controller.getSnapshot().pending.requestId, REQUEST);
  }
});

test('unknown write checks status once and a 404 retains original capability without claiming deletion', async () => {
  const f = fixture();
  f.deps.erase = async (bearer, body) => { f.calls.push({ kind: 'erase', bearer, body }); throw failure('NETWORK_ERROR'); };
  assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
  assert.equal(count(f, 'erase'), 1);
  assert.equal(count(f, 'lookup'), 1);
  assert.deepEqual(f.calls.find(call => call.kind === 'lookup').body, { request_id: REQUEST, recovery_token: SECRET });
  assert.equal(f.controller.getSnapshot().phase, 'not_found');
  assert.equal(f.token, ACTOR_A.token);
  assert.equal(JSON.parse(f.stored).requestId, REQUEST);
  assert.equal(await f.controller.check(ACTOR_A), false);
  assert.equal(count(f, 'erase'), 1);
  assert.equal(f.controller.getSnapshot().phase, 'not_found');
  assert.equal(f.controller.getSnapshot().pending.requestId, REQUEST);
});

test('401 is recovered by the secret status endpoint instead of being treated as deletion proof', async () => {
  for (const completed of [false, true]) {
    const f = fixture();
    f.deps.erase = async () => { throw failure('UNAUTHORIZED', 401); };
    f.deps.lookup = async body => {
      f.calls.push({ kind: 'lookup', body });
      return completed ? receipt() : missing();
    };
    assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), completed);
    assert.equal(count(f, 'lookup'), 1);
    assert.equal(f.stored === null, completed);
    assert.equal(f.token, completed ? null : ACTOR_A.token);
  }
});

test('a busy transaction retains the original intent and retry checks status before repeating that exact request', async () => {
  const f = fixture();
  f.deps.erase = async (bearer, body) => { f.calls.push({ kind: 'erase', bearer, body }); throw failure('ACCOUNT_BUSY', 409); };
  assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
  assert.equal(f.controller.getSnapshot().phase, 'blocked');
  assert.equal(f.controller.getSnapshot().error, 'ACCOUNT_BUSY');
  assert.equal(count(f, 'lookup'), 0);
  const saved = f.stored;
  f.deps.erase = async (bearer, body) => { f.calls.push({ kind: 'erase', bearer, body }); return receipt(); };
  assert.equal(await f.controller.retry(ACTOR_A, 'reentered-password', 'DELETE'), true);
  assert.equal(count(f, 'generate'), 1);
  assert.equal(count(f, 'erase'), 2);
  assert.equal(count(f, 'lookup'), 1);
  const repeated = f.calls.filter(call => call.kind === 'erase')[1].body;
  assert.equal(repeated.request_id, JSON.parse(saved).requestId);
  assert.equal(repeated.recovery_token, JSON.parse(saved).recoveryToken);
  assert.equal(repeated.password, 'reentered-password');
});

test('a retry never resubmits when recovery itself has an unknown outcome', async () => {
  const f = fixture();
  f.setStored(JSON.stringify(await intent()));
  await f.controller.load();
  f.deps.lookup = async () => { throw failure('REQUEST_TIMEOUT'); };
  assert.equal(await f.controller.retry(ACTOR_A, PASSWORD, 'DELETE'), false);
  assert.equal(count(f, 'erase'), 0);
  assert.equal(count(f, 'generate'), 0);
  assert.equal(f.controller.getSnapshot().phase, 'unknown');
  assert.ok(f.stored);
});

test('malformed or wrong-request receipts cannot clear identity or pending recovery', async () => {
  for (const invalid of [receipt(OTHER_REQUEST), { ...receipt(), status: 'pending' }, { ...receipt(), completed_at: 'bad' }]) {
    const f = fixture();
    f.deps.erase = async () => invalid;
    f.deps.lookup = async () => invalid;
    assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
    assert.equal(f.controller.getSnapshot().phase, 'unknown');
    assert.equal(f.token, ACTOR_A.token);
    assert.ok(f.stored);
  }
});

test('a late deletion result invalidates only the original token after another account signs in', async () => {
  const f = fixture(), remote = deferred();
  f.deps.erase = async () => remote.promise;
  await f.session.readSnapshot();
  const deleting = f.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  await tick();
  await f.session.writeToken(ACTOR_B.token);
  const changes = [];
  f.session.subscribe(token => changes.push(token));
  remote.resolve(receipt());
  assert.equal(await deleting, true);
  assert.equal(f.token, ACTOR_B.token);
  assert.deepEqual(changes, []);
  assert.equal(await f.session.writeToken(ACTOR_A.token), false);
  assert.equal(f.token, ACTOR_B.token);
});

test('after restart a receipt clears a matching original token using its digest without a signed-in profile', async () => {
  const f = fixture();
  f.setStored(JSON.stringify(await intent()));
  f.deps.lookup = async () => receipt();
  const restarted = f.recreate();
  await restarted.load();
  assert.equal(await restarted.check(null), true);
  assert.equal(f.token, null);
  assert.equal(f.stored, null);
  assert.equal(count(f, 'generate'), 0);
  assert.equal(count(f, 'erase'), 0);
});

test('after restart a deletion receipt never clears a different account token', async () => {
  const f = fixture();
  f.setStored(JSON.stringify(await intent()));
  await f.session.writeToken(ACTOR_B.token);
  f.deps.lookup = async () => receipt();
  const restarted = f.recreate();
  await restarted.load();
  assert.equal(await restarted.check(ACTOR_B), true);
  assert.equal(f.token, ACTOR_B.token);
  assert.equal(f.stored, null);
  assert.equal(f.events.some(value => value === `invalidate:${ACTOR_B.token}`), false);
});

test('a replacement login during asynchronous digest comparison survives recovery cleanup', async () => {
  const f = fixture(), hashing = deferred();
  f.setStored(JSON.stringify(await intent()));
  f.deps.lookup = async () => receipt();
  f.deps.hashToken = async () => hashing.promise;
  const restarted = f.recreate();
  await restarted.load();
  const checking = restarted.check(null);
  await tick();
  await f.session.writeToken(ACTOR_B.token);
  hashing.resolve(await hash(ACTOR_A.token));
  assert.equal(await checking, true);
  assert.equal(f.token, ACTOR_B.token);
  assert.equal(f.stored, null);
});

test('an orphaned A request cannot be retried by B and does not prevent B completing its own deletion', async () => {
  const f = fixture();
  f.setStored(JSON.stringify(await intent()));
  await f.session.writeToken(ACTOR_B.token);
  await f.controller.load();
  assert.equal(await f.controller.retry(ACTOR_B, PASSWORD, 'DELETE'), false);
  assert.equal(f.controller.getSnapshot().error, 'DELETION_ACCOUNT_CHANGED');
  f.deps.createRecovery = async () => ({ requestId: OTHER_REQUEST, recoveryToken: Buffer.alloc(32,9).toString('base64url') });
  f.deps.erase = async (_token, body) => { f.calls.push({ kind: 'erase', body }); return receipt(body.request_id); };
  assert.equal(await f.controller.begin(ACTOR_B, PASSWORD, 'DELETE'), true);
  assert.equal(count(f, 'erase'), 1);
  assert.equal(count(f, 'lookup'), 0);
  assert.equal(count(f, 'generate'), 0);
  assert.equal(JSON.parse(f.stored).ownerId, OWNER_A);
  assert.deepEqual(f.controller.getSnapshot().pendingItems, [{ ownerId: OWNER_A, requestId: REQUEST }]);
  assert.equal(f.token,null);
  assert.equal(f.events.includes(`purge:${OWNER_A}`),false);
  assert.equal(f.events.includes(`purge:${OWNER_B}`),true);
});

test('switching accounts while recovery is being saved prevents subsequent dispatch', async () => {
  const f = fixture(), persisted = deferred(), save = f.storage.set;
  f.storage.set = async (key, value) => {
    await save(key, value);
    if (key === deletionOwnerKey(OWNER_A)) await persisted.promise;
  };
  const deleting = f.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  await tick();
  await f.session.writeToken(ACTOR_B.token);
  persisted.resolve();
  assert.equal(await deleting, false);
  assert.equal(count(f, 'erase'), 0);
  assert.equal(f.controller.getSnapshot().error, 'DELETION_ACCOUNT_CHANGED');
  assert.equal(JSON.parse(f.stored).ownerId, OWNER_A);
  assert.equal(f.token, ACTOR_B.token);
});

test('secure token cleanup failure cannot revive deleted identity and keeps recovery for an explicit cleanup retry', async () => {
  const f = fixture(), remove = f.sessionStorage.remove;
  await f.session.readSnapshot();
  f.sessionStorage.remove = async () => { throw Error('secure storage unavailable'); };
  assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
  assert.equal(f.controller.getSnapshot().phase, 'deleted');
  assert.equal(f.controller.getSnapshot().error, 'DELETION_CLEANUP_PENDING');
  assert.equal(await f.session.readToken(), null);
  assert.equal(f.token, ACTOR_A.token);
  assert.ok(f.stored);
  f.sessionStorage.remove = remove;
  assert.equal(await f.controller.check(null), true);
  assert.equal(f.token, null);
  assert.equal(f.stored, null);
  assert.equal(count(f, 'erase'), 1);
});

test('recovery cleanup failure preserves verified deletion and retry does not issue another deletion', async () => {
  for (const mutationFirst of [false, true]) {
    const f = fixture(), remove = f.storage.remove;
    f.storage.remove = async key => { if (mutationFirst) await remove(key); throw Error('remove failed'); };
    assert.equal(await f.controller.begin(ACTOR_A, PASSWORD, 'DELETE'), false);
    assert.equal(f.controller.getSnapshot().phase, 'deleted');
    assert.equal(f.controller.getSnapshot().error, 'DELETION_CLEANUP_PENDING');
    assert.equal(f.token, null);
    f.storage.remove = remove;
    assert.equal(await f.controller.check(null), true);
    assert.equal(f.stored, null);
    assert.equal(count(f, 'erase'), 1);
  }
});

test('cancellation before saving sends no deletion and cancellation after dispatch still checks the original receipt', async () => {
  const early = fixture(), random = deferred();
  early.deps.createRecovery = async () => random.promise;
  const first = early.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  await tick(); early.controller.cancel();
  random.resolve({ requestId: REQUEST, recoveryToken: SECRET });
  assert.equal(await first, false);
  assert.equal(early.stored, null);
  assert.equal(count(early, 'erase'), 0);

  const late = fixture();
  late.deps.erase = async (_token, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(failure('CANCELLED')), { once: true });
  });
  late.deps.lookup = async () => receipt();
  const second = late.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  await tick(); late.controller.cancel();
  assert.equal(await second, true);
  assert.equal(late.token, null);
  assert.equal(late.stored, null);
});

test('concurrent taps admit only one write and snapshots expose no recovery secret or token digest', async () => {
  const f = fixture(), remote = deferred();
  f.deps.erase = async () => remote.promise;
  const first = f.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  const second = f.controller.begin(ACTOR_A, PASSWORD, 'DELETE');
  assert.equal(await second, false);
  await tick();
  const exposed = JSON.stringify(f.controller.getSnapshot());
  assert.equal(exposed.includes(SECRET), false);
  assert.equal(exposed.includes(ACTOR_A.token), false);
  assert.equal(exposed.includes(await hash(ACTOR_A.token)), false);
  assert.equal(count(f, 'generate'), 1);
  remote.resolve(receipt());
  assert.equal(await first, true);
});

test('legacy recovery migrates without changing its ID or secret, including copy acknowledgements lost after commit', async () => {
  const f = fixture(), original = await intent(), set = f.storage.set;
  f.setStored(JSON.stringify(original));
  let rejectCopy = true;
  f.storage.set = async (key, value) => {
    await set(key, value);
    if (rejectCopy && key === deletionOwnerKey(OWNER_A)) { rejectCopy = false; throw Error('copy acknowledgement lost'); }
  };
  await assert.rejects(f.deps.pending.list(), { code: 'STORAGE_ERROR' });
  assert.equal(f.values.get(DELETION_LEGACY_KEY),JSON.stringify(original));
  assert.equal(f.values.get(deletionOwnerKey(OWNER_A)),JSON.stringify(original));
  assert.deepEqual(await f.deps.pending.list(),[original]);
  assert.equal(f.values.has(DELETION_LEGACY_KEY),false);
  const index = f.values.get(DELETION_INDEX_KEY);
  assert.ok(!index.includes(SECRET));
  assert.ok(!index.includes(original.originalTokenHash));
});

test('an index-only failed reservation does not block another owner and capacity never evicts unresolved records', async () => {
  const f = fixture();
  f.values.set(DELETION_INDEX_KEY,JSON.stringify({ version:2,owners:[OWNER_A] }));
  assert.deepEqual(await f.deps.pending.list(),[]);
  const original = await intent();
  const owners = Array.from({ length: DELETION_PENDING_LIMIT }, (_, i) => `${(i+100).toString(16).padStart(8,'0')}-1111-4111-8111-111111111111`);
  for (const ownerId of owners) await f.deps.pending.save({ ...original,ownerId });
  assert.equal((await f.deps.pending.list()).length,DELETION_PENDING_LIMIT);
  await assert.rejects(f.deps.pending.save({ ...original,ownerId:OWNER_B }),{ code:'DELETION_PENDING_LIMIT' });
  assert.equal((await f.deps.pending.list()).length,DELETION_PENDING_LIMIT);
  assert.equal(await f.deps.pending.read(OWNER_B),null);
  await f.deps.pending.remove({ ...original,ownerId:owners[0] });
  await f.deps.pending.save({ ...original,ownerId:OWNER_B });
  assert.equal((await f.deps.pending.read(OWNER_B)).recoveryToken,SECRET);
});

test('A stays queryable without signing in after B completes; a late B receipt cannot clear A recovery or a new login', async () => {
  const f = fixture(), original = await intent(), remote = deferred();
  await f.deps.pending.save(original);
  await f.session.writeToken(ACTOR_B.token);
  f.deps.createRecovery = async () => ({ requestId:OTHER_REQUEST,recoveryToken:Buffer.alloc(32,11).toString('base64url') });
  f.deps.erase = async () => remote.promise;
  const deletingB = f.controller.begin(ACTOR_B,PASSWORD,'DELETE');
  await tick();
  await f.session.writeToken(ACTOR_A.token);
  remote.resolve(receipt(OTHER_REQUEST));
  assert.equal(await deletingB,true);
  assert.equal(f.token,ACTOR_A.token);
  assert.deepEqual(await f.deps.pending.read(OWNER_A),original);
  assert.equal(await f.deps.pending.read(OWNER_B),null);
  assert.equal(f.events.includes(`purge:${OWNER_A}`),false);
  assert.equal(await f.controller.check(null,OWNER_A),false);
  assert.equal(f.controller.getSnapshot().phase,'not_found');
  assert.deepEqual(f.controller.getSnapshot().pendingItems,[{ ownerId:OWNER_A,requestId:REQUEST }]);
  assert.deepEqual(f.calls.filter(call=>call.kind==='lookup').map(call=>call.body),
    [{ request_id:REQUEST,recovery_token:SECRET }]);
});

test('a missing or mismatched deletion receipt never purges local social recovery', async () => {
  for (const lookup of [missing, async()=>receipt(OTHER_REQUEST)]) {
    const f = fixture();
    await f.deps.pending.save(await intent());
    f.deps.lookup = lookup;
    await f.controller.load();
    assert.equal(await f.controller.check(null,OWNER_A),false);
    assert.equal(f.events.some(event=>event.startsWith('purge:')),false);
    assert.ok(await f.deps.pending.read(OWNER_A));
  }
});

test('verified deletion purges only owner social data; failure retains recovery and cannot resurrect bodies or delete ledger recovery', async () => {
  const f = fixture(), outbox = createOutboxStore(f.storage), reports = createReportStore(f.storage,hash,true);
  const conversation = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const original = { ownerId:OWNER_A,conversationId:conversation,clientMessageId:REQUEST,text:'private pending A',ttlSeconds:null };
  const peer = { ...original,ownerId:OWNER_B,clientMessageId:OTHER_REQUEST,text:'private pending B' };
  await outbox.write(original,REQUEST); await outbox.write(peer,OTHER_REQUEST);
  await reports.save(OWNER_A,{ client_report_id:REQUEST,user_id:OWNER_B,message_id:null,reason:'private report A',include_evidence:false });
  await reports.save(OWNER_B,{ client_report_id:OTHER_REQUEST,user_id:OWNER_A,message_id:null,reason:'private report B',include_evidence:false });
  const ledgerKey = 'q.pending-transfer.unresolved';
  f.values.set(ledgerKey,'must retain original transfer ID and payload');
  const remove = f.storage.remove;
  let failRemoval = true;
  f.storage.remove = async key => {
    if (failRemoval && key === `q.social.pending.${OWNER_A}.${conversation}.${REQUEST}.0`) throw Error('owner chunk cleanup unavailable');
    await remove(key);
  };
  f.deps.cleanupOwner = async ownerId => {
    const outcomes = await Promise.allSettled([outbox.purgeOwner(ownerId),reports.purgeOwner(ownerId)]);
    if (outcomes.some(result=>result.status==='rejected')) throw Error('cleanup pending');
  };
  assert.equal(await f.controller.begin(ACTOR_A,PASSWORD,'DELETE'),false);
  assert.equal(f.controller.getSnapshot().phase,'deleted');
  assert.equal(f.controller.getSnapshot().error,'DELETION_CLEANUP_PENDING');
  assert.ok(await f.deps.pending.read(OWNER_A));
  assert.equal(await outbox.read(OWNER_A,conversation),null);
  await assert.rejects(outbox.write(original,REQUEST),{ code:'ACCOUNT_DELETED' });
  await assert.rejects(reports.save(OWNER_A,{ client_report_id:REQUEST,user_id:OWNER_B,message_id:null,reason:'late secret',include_evidence:false }),{ code:'ACCOUNT_DELETED' });
  assert.deepEqual(await outbox.read(OWNER_B,conversation),peer);
  assert.equal((await reports.read(OWNER_B)).reason,'private report B');
  assert.equal(f.values.get(ledgerKey),'must retain original transfer ID and payload');
  failRemoval = false;
  assert.equal(await f.controller.check(null,OWNER_A),true);
  assert.equal(await f.deps.pending.read(OWNER_A),null);
  assert.ok(![...f.values.values()].join('').includes('private pending A'));
  assert.ok(![...f.values.values()].join('').includes('private report A'));
  assert.equal((await reports.read(OWNER_B)).reason,'private report B');
  assert.equal(f.values.get(ledgerKey),'must retain original transfer ID and payload');
  assert.equal(count(f,'erase'),1);
});
