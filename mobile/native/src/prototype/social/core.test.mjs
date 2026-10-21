import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { canReportEvidence, createDeadline, createOutboxStore, createPrivacyGate, decodePending, isFinalSendRejection, messageReceipt, normalizeHandle, persistedPending, remainingMs, restoreRejectedDraft, samePendingSend, sameStamp, sendPayload, SocialError, validateText } from './core.ts';

// Production uses Metro's extension resolution; keep this local to these direct-TS tests.
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (specifier === './core' && context.parentURL?.includes('/prototype/social/')) return next('./core.ts', context);
  return next(specifier, context);
} });
const { decodeEphemeralState, decodeMessage, decodeMessagePage, decodeSnapshot, socialRequest } = await import('./api.ts');
const web = await import('./outbox-store.web.ts');
resolver.deregister();

const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const conversation = '33333333-3333-4333-8333-333333333333';
const client = '44444444-4444-4444-8444-444444444444';
const message = '55555555-5555-4555-8555-555555555555';
const version = '66666666-6666-4666-8666-666666666666';
const now = '2026-10-19T00:00:00Z', later = '2026-10-19T00:00:30Z';
const user = { id: peer, handle: 'friend', display_name: '小林', avatar: 'leaf' };
const envelope = { id: message, conversation_id: conversation, seq: 1, sender_id: peer, client_message_id: client, kind: 'ephemeral', body: null, ttl_seconds: 30, opened_at: null, expires_at: null, unopened_expires_at: '2026-10-26T00:00:00Z', expired: false, created_at: now };
const intent = { ownerId: owner, conversationId: conversation, clientMessageId: client, text: '你好', ttlSeconds: null };
const stamp = { ownerId: owner, token: 'opaque-token', revision: 7, epoch: 3 };
function memory() {
  const values = new Map();
  return { values, adapter: { get: async key => values.get(key) ?? null, set: async (key, value) => { assert.ok(Buffer.byteLength(value) <= 2048); values.set(key, value); }, remove: async key => { values.delete(key); } } };
}
function snapshot(last = envelope) {
  return { server_time: now, friends: [], requests: [], blocks: [], notifications: [], conversations: [{ id: conversation, user, last_seq: 1, read_seq: 0, peer_read_seq: 0, unread_count: 1, last_message: last, updated_at: now, active: true }] };
}

test('response boundaries reject ephemeral plaintext, invalid lifetimes and unsafe cursors', () => {
  assert.equal(decodeMessage(envelope).body, null);
  assert.throws(() => decodeMessage({ ...envelope, body: 'must never leak' }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeMessage({ ...envelope, ttl_seconds: 60 }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeMessage({ ...envelope, seq: Number.MAX_SAFE_INTEGER + 1 }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeMessage({ ...envelope, created_at: 'yesterday' }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeMessagePage({ items: [envelope, envelope], next_after_seq: 1, has_more: false, server_time: now }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeMessagePage({ items: [envelope], next_after_seq: 2, has_more: false, server_time: now }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => decodeEphemeralState({ items: [{ ...envelope, kind: 'text', body: 'ordinary', ttl_seconds: null }], server_time: now }), { code: 'INVALID_RESPONSE' });
});

test('conversation read positions never claim that a sealed ephemeral message was opened', () => {
  assert.equal(messageReceipt(envelope, 100), 'unopened');
  assert.equal(messageReceipt({ ...envelope, opened_at: now }, 0), 'opened');
  assert.equal(messageReceipt({ ...envelope, expired: true }, 100), 'expired');
  assert.equal(messageReceipt({ ...envelope, kind: 'text', body: 'ordinary', ttl_seconds: null }, 100), 'read');
});

test('content evidence consent is available only for ordinary or currently visible unexpired messages', () => {
  assert.equal(canReportEvidence(envelope, false), false);
  assert.equal(canReportEvidence(envelope, true), true);
  assert.equal(canReportEvidence({ ...envelope, expired: true }, true), false);
  assert.equal(canReportEvidence({ ...envelope, kind: 'text', body: 'ordinary', ttl_seconds: null }, false), true);
});

test('global snapshots retain only short ordinary previews and never full or ephemeral content', () => {
  const normal = { ...envelope, kind: 'text', ttl_seconds: null, body: '😀'.repeat(160) };
  const result = decodeSnapshot(snapshot(normal));
  assert.equal(Array.from(result.conversations[0].last_message.preview).length, 80);
  assert.equal('body' in result.conversations[0].last_message, false);
  assert.equal(decodeSnapshot(snapshot()).conversations[0].last_message.preview, null);
  assert.throws(() => decodeSnapshot({ ...snapshot(), blocks: Array(201).fill(user) }), { code: 'INVALID_RESPONSE' });
});

test('each message has an independent conservative server deadline', () => {
  const a = createDeadline(now, later, 1000, 100000), b = createDeadline(now, '2026-10-19T00:05:00Z', 1000, 100000);
  assert.equal(remainingMs(a, 5000, 104000), 26000);
  assert.equal(remainingMs(a, 31000, 130000), 0);
  assert.equal(remainingMs(b, 31000, 130000), 270000);
  assert.equal(remainingMs(a, 5000, 99000), 0, 'backwards wall clock fails closed');
  assert.equal(remainingMs(a, 5000, 200000), 0, 'forward clock jump cannot extend visibility');
  assert.equal(remainingMs(a, 999, 100000), 0, 'monotonic restart fails closed');
  assert.throws(() => createDeadline(later, now, 1000, 100000));
  assert.throws(() => createDeadline(now, '2026-10-21T00:00:00Z', 1000, 100000));
});

test('late private responses cannot repopulate after background, route leave or same-owner relogin', async () => {
  for (const boundary of ['background', 'leave', 'switch']) {
    const gate = createPrivacyGate(); gate.enter();
    const ticket = gate.capture(); let identity = { ...stamp }, visible = '';
    let resolve; const network = new Promise(done => { resolve = done; });
    const apply = network.then(body => { if (gate.accepts(ticket) && sameStamp(stamp, identity)) visible = body; });
    if (boundary === 'background') gate.invalidate();
    if (boundary === 'leave') { gate.leave(); gate.enter(); }
    if (boundary === 'switch') identity = { ...stamp, revision: 8, token: 'new-token' };
    resolve('private content'); await apply;
    assert.equal(visible, '', boundary);
  }
  for (const field of ['ownerId', 'token', 'revision', 'epoch']) assert.equal(sameStamp(stamp, { ...stamp, [field]: field === 'revision' || field === 'epoch' ? 99 : 'other' }), false);
  assert.equal(sameStamp(stamp, null), false);
});

test('native outbox chunks preserve Unicode and reject replacing an unresolved send', async () => {
  const storage = memory(), store = createOutboxStore(storage.adapter), full = { ...intent, text: '😀'.repeat(2000) };
  await store.write(full, version);
  assert.deepEqual(await createOutboxStore(storage.adapter).read(owner, conversation), full);
  assert.equal(await store.read(peer, conversation), null);
  await store.write(full, message);
  await assert.rejects(store.write({ ...full, clientMessageId: message }, peer), { code: 'PENDING_SEND_EXISTS' });
  await assert.rejects(store.write({ ...full, text: 'changed' }, peer), { code: 'PENDING_SEND_EXISTS' });
  await store.remove(owner, conversation, message);
  assert.deepEqual(await store.read(owner, conversation), full);
  await store.remove(owner, conversation, client);
  assert.equal(storage.values.size, 0);
});

test('ephemeral pending records contain neither body nor injected credentials', async () => {
  const storage = memory(), store = createOutboxStore(storage.adapter);
  const secret = 'temporary secret body';
  await store.write({ ...intent, text: secret, ttlSeconds: 300, token: 'must-not-persist' }, version);
  const serialized = [...storage.values.values()].join('');
  assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes('must-not-persist'));
  const restored = await store.read(owner, conversation);
  assert.equal(restored.text, null); assert.equal(restored.clientMessageId, client);
  assert.throws(() => sendPayload(restored), { code: 'EPHEMERAL_BODY_CLEARED' });
  assert.throws(() => decodePending({ ...intent, ttlSeconds: 30 }), { code: 'STORAGE_ERROR' });
});

test('partial persistence failures never replace a committed pending request', async () => {
  const storage = memory(); let rejectChunk = true;
  const interrupted = createOutboxStore({ ...storage.adapter, set: async (key, value) => {
    if (rejectChunk && key.endsWith('.1')) { rejectChunk = false; throw new Error('storage unavailable'); }
    await storage.adapter.set(key, value);
  } });
  await assert.rejects(interrupted.write({ ...intent, text: '😀'.repeat(2000) }, version));
  assert.equal(await interrupted.read(owner, conversation), null);
  assert.equal(storage.values.size, 0, 'uncommitted chunks are removed when their manifest is known absent');
  let rejectCommit = true;
  const uncertain = createOutboxStore({ ...storage.adapter, set: async (key, value) => {
    await storage.adapter.set(key, value);
    if (rejectCommit && key === `q.social.pending.${owner}.${conversation}`) { rejectCommit = false; throw new Error('response lost after commit'); }
  } });
  await assert.rejects(uncertain.write(intent, version));
  assert.deepEqual(await uncertain.read(owner, conversation), intent, 'a committed-but-rejected manifest remains recoverable');
  await assert.rejects(uncertain.write({ ...intent, clientMessageId: message }, peer), { code: 'PENDING_SEND_EXISTS' });
});

test('Web outbox persists identifiers only and can recover the original result after reload', async () => {
  const storage = memory();
  globalThis.localStorage = { getItem: key => storage.values.get(key) ?? null, setItem: (key, value) => storage.values.set(key, value), removeItem: key => storage.values.delete(key) };
  try {
    await web.outboxStore.write({ ...intent, text: 'ordinary-private-body' }, version);
    assert.ok(![...storage.values.values()].join('').includes('ordinary-private-body'));
    assert.deepEqual(await web.outboxStore.read(owner, conversation), { ...intent, text: null });
  } finally { delete globalThis.localStorage; }
});

test('same pending ID and payload survive uncertainty, while content limits count Unicode characters', () => {
  const retry = persistedPending(intent);
  assert.deepEqual(sendPayload(retry), sendPayload(intent));
  assert.equal(sendPayload(retry).client_message_id, client);
  assert.equal(validateText('😀'.repeat(2000)).length, 4000);
  assert.throws(() => validateText('😀'.repeat(2001)), { code: 'INVALID_MESSAGE' });
  assert.throws(() => validateText('  '), { code: 'INVALID_MESSAGE' });
  assert.equal(normalizeHandle(' Friend_1 '), 'friend_1');
  assert.throws(() => normalizeHandle('friend/name'), { code: 'INVALID_HANDLE' });
});

test('secure transport rejects unsafe destinations before sending a token and disables redirects', async () => {
  let invoked = 0;
  const transport = async (_url, options) => { invoked++; assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); return Response.json(envelope); };
  for (const baseUrl of ['http://example.com', 'https://name:password@example.com', 'https://example.com?secret=key']) await assert.rejects(socialRequest({ baseUrl, path: '/v1/social/test', token: 'secret', decode: decodeMessage, transport }), { code: 'INSECURE_API_URL' });
  assert.equal(invoked, 0);
  assert.equal((await socialRequest({ baseUrl: 'https://example.com', path: '/v1/social/test', token: 'secret', decode: decodeMessage, transport })).id, message);
});

test('transport rejects late cancellation, bounds response bytes, and surfaces only stable error codes', async () => {
  const options = { baseUrl: 'https://example.com', path: '/v1/social/test', token: 'secret', decode: decodeMessage };
  const controller = new AbortController();
  await assert.rejects(socialRequest({ ...options, signal: controller.signal, transport: async () => { controller.abort(); return Response.json(envelope); } }), { code: 'CANCELLED' });
  await assert.rejects(socialRequest({ ...options, transport: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(socialRequest({ ...options, transport: async () => Response.json({ error: { code: 'SOCIAL_MESSAGE_EXPIRED', message: 'private diagnostic' } }, { status: 410 }) }), error => error.code === 'SOCIAL_MESSAGE_EXPIRED' && error.status === 410 && !error.message.includes('private'));
  await assert.rejects(socialRequest({ ...options, timeoutMs: 5, transport: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), { code: 'REQUEST_TIMEOUT' });
});

test('unstructured HTTP errors keep their status and identify missing social endpoints', async () => {
  const options = { baseUrl: 'https://example.com', path: '/v1/social/snapshot', token: 'opaque-test-token', decode: decodeSnapshot };
  const cases = [
    [() => new Response(null, { status: 404 }), 'SOCIAL_UNAVAILABLE', 404],
    [() => new Response('', { status: 404 }), 'SOCIAL_UNAVAILABLE', 404],
    [() => new Response('<html>private upstream diagnostic</html>', { status: 404 }), 'SOCIAL_UNAVAILABLE', 404],
    [() => new Response('<html>private upstream diagnostic</html>', { status: 502 }), 'REQUEST_FAILED', 502],
    [() => new Response(null, { status: 401 }), 'UNAUTHORIZED', 401],
    [() => new Response('private rate-limit diagnostic', { status: 429 }), 'RATE_LIMITED', 429],
    [() => Response.json({ detail: 'private upstream diagnostic' }, { status: 503 }), 'REQUEST_FAILED', 503],
    [() => Response.json(null, { status: 404 }), 'SOCIAL_UNAVAILABLE', 404],
    [() => Response.json({ error: { message: 'private diagnostic' } }, { status: 404 }), 'SOCIAL_UNAVAILABLE', 404],
    [() => Response.json({ error: { code: 'private invalid error code' } }, { status: 401 }), 'UNAUTHORIZED', 401],
  ];
  for (const [response, code, status] of cases) {
    await assert.rejects(socialRequest({ ...options, transport: async () => response() }), error => {
      assert.equal(error.code, code); assert.equal(error.status, status);
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('structured HTTP error codes retain auth, rate-limit and resource-not-found semantics', async () => {
  const options = { baseUrl: 'https://example.com', path: '/v1/social/snapshot', token: 'opaque-test-token', decode: decodeSnapshot };
  for (const [code, status] of [['UNAUTHORIZED', 401], ['RATE_LIMITED', 429], ['SOCIAL_NOT_FOUND', 404], ['USER_NOT_FOUND', 404], ['IDEMPOTENCY_CONFLICT', 409], ['SOCIAL_MESSAGE_EXPIRED', 410]]) {
    await assert.rejects(socialRequest({ ...options, transport: async () => Response.json({ error: { code, message: 'private diagnostic' } }, { status }) }),
      error => error.code === code && error.status === status && !error.message.includes('private'));
  }
});

test('successful responses with missing, malformed or incompatible data still fail decoding', async () => {
  const options = { baseUrl: 'https://example.com', path: '/v1/social/snapshot', token: 'opaque-test-token', decode: decodeSnapshot };
  for (const response of [() => new Response(null), () => new Response(''), () => new Response('<html>not an API response</html>'), () => Response.json({}), () => Response.json({ error: { code: 'SOCIAL_NOT_FOUND' } })]) {
    await assert.rejects(socialRequest({ ...options, transport: async () => response() }), { code: 'INVALID_RESPONSE', status: 0 });
  }
});

test('oversized HTTP error bodies are cancelled without losing the HTTP status', async () => {
  let cancelled = false, decoded = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(socialRequest({ baseUrl: 'https://example.com', path: '/v1/social/snapshot', token: 'opaque-test-token',
    decode: () => { decoded = true; }, transport: async () => new Response(stream, { status: 502 }) }), { code: 'REQUEST_FAILED', status: 502 });
  assert.equal(cancelled, true); assert.equal(decoded, false);
});

test('cancellation and timeout take precedence over a late bodyless HTTP error', async () => {
  const options = { baseUrl: 'https://example.com', path: '/v1/social/snapshot', token: 'opaque-test-token', decode: decodeSnapshot };
  const controller = new AbortController();
  await assert.rejects(socialRequest({ ...options, signal: controller.signal, transport: async () => {
    controller.abort(); return new Response(null, { status: 404 });
  } }), { code: 'CANCELLED', status: 0 });
  await assert.rejects(socialRequest({ ...options, timeoutMs: 1, transport: async () => {
    await new Promise(resolve => setTimeout(resolve, 10)); return new Response(null, { status: 404 });
  } }), { code: 'REQUEST_TIMEOUT', status: 0 });
});

test('owner purge removes journaled orphan chunks, preserves other owners and fences new writes across restart', async () => {
  const storage = memory(), store = createOutboxStore(storage.adapter);
  const second = { ...intent,ownerId:peer,text:'other owner pending text' };
  await store.write(intent,version); await store.write(second,message);
  const remove = storage.adapter.remove;
  storage.adapter.remove = async key => {
    if (key === `q.social.pending.${owner}.${conversation}.${version}.0`) throw Error('chunk removal failed');
    await remove(key);
  };
  await assert.rejects(store.remove(owner,conversation,client));
  assert.equal(storage.values.has(`q.social.pending.${owner}.${conversation}`),false,'manifest was removed before the failed chunk cleanup');
  storage.adapter.remove = remove;
  await store.purgeOwner(owner);
  assert.ok(![...storage.values.values()].join('').includes(intent.text));
  assert.deepEqual(await store.read(peer,conversation),second);
  assert.equal(await store.read(owner,conversation),null);
  await assert.rejects(store.write(intent,version),{ code:'ACCOUNT_DELETED' });
  const restarted = createOutboxStore(storage.adapter);
  assert.equal(await restarted.read(owner,conversation),null);
  await assert.rejects(restarted.write(intent,version),{ code:'ACCOUNT_DELETED' });
});

test('purge waits for an already writing outbox then rejects queued writes without resurrecting owner content', async () => {
  const storage = memory();
  let release, entered;
  const wait = new Promise(resolve=>{release=resolve;}), began = new Promise(resolve=>{entered=resolve;});
  const set = storage.adapter.set;
  storage.adapter.set = async (key,value) => {
    await set(key,value);
    if (key === `q.social.pending.${owner}.${conversation}.${version}.0`) { entered(); await wait; }
  };
  const store = createOutboxStore(storage.adapter);
  const writing = store.write(intent,version);
  await began;
  const purging = store.purgeOwner(owner);
  const queued = assert.rejects(store.write({ ...intent,clientMessageId:message },message),{ code:'ACCOUNT_DELETED' });
  release();
  await writing; await purging; await queued;
  assert.equal(await store.read(owner,conversation),null);
  assert.ok(![...storage.values.values()].join('').includes(intent.text));
});

test('known legacy outboxes are indexed on read but unindexed orphan chunks are not falsely claimed as erased', async () => {
  const storage = memory();
  const base = `q.social.pending.${owner}.${conversation}`;
  storage.values.set(base,JSON.stringify({ version,count:1 }));
  storage.values.set(`${base}.${version}.0`,JSON.stringify(intent));
  const unindexed = `q.social.pending.${owner}.${peer}.${message}.0`;
  storage.values.set(unindexed,'legacy fragment without a manifest or index');
  const store = createOutboxStore(storage.adapter);
  assert.deepEqual(await store.read(owner,conversation),intent);
  await store.purgeOwner(owner);
  assert.equal(storage.values.has(base),false);
  assert.equal(storage.values.has(`${base}.${version}.0`),false);
  assert.equal(storage.values.get(unindexed),'legacy fragment without a manifest or index',
    'SecureStore provides no key enumeration; the documented legacy-fragment limitation is real');
});

test('CONTENT_BLOCKED is final only for its exact status and editable draft restoration cannot clobber newer text or another pending send', async () => {
  assert.equal(isFinalSendRejection(new SocialError('CONTENT_BLOCKED',422)),true);
  for (const failure of [
    new SocialError('CONTENT_BLOCKED',500),new SocialError('NETWORK_ERROR'),
    new SocialError('UNAUTHORIZED',401),new SocialError('RATE_LIMITED',429),
    new SocialError('IDEMPOTENCY_CONFLICT',409),Object.assign(new Error('unstructured'),{ code:'CONTENT_BLOCKED',status:422 }),
  ]) assert.equal(isFinalSendRejection(failure),false);
  assert.equal(restoreRejectedDraft('',intent),intent.text);
  assert.equal(restoreRejectedDraft('new typed message',intent),'new typed message');
  assert.equal(restoreRejectedDraft(' ',intent),' ');
  for (const altered of [null,{ ...intent,ownerId:peer },{ ...intent,conversationId:peer },{ ...intent,clientMessageId:message }]) {
    assert.equal(samePendingSend(altered,intent),false);
  }
  const storage = memory(),store = createOutboxStore(storage.adapter);
  const newer = { ...intent,clientMessageId:message,text:'new unresolved text' };
  await store.write(newer,version);
  await store.remove(intent.ownerId,intent.conversationId,intent.clientMessageId);
  assert.deepEqual(await store.read(owner,conversation),newer);
});
