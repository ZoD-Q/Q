#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = (process.env.Q_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const runId = `${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
const password = `Qtest_${randomUUID()}!`;
const handles = [`qa_${runId}_a`, `qa_${runId}_b`];
let passed = 0;

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(`${method} ${path} returned non-JSON (${response.status})`); }
  return { status: response.status, data };
}

function expected(result, status, code) {
  assert.equal(result.status, status, `Expected HTTP ${status}, received ${result.status}: ${JSON.stringify(result.data)}`);
  if (code) assert.equal(result.data?.error?.code, code);
  return result.data;
}

async function check(name, action) {
  await action();
  passed++;
  console.log(`PASS ${name}`);
}

async function register(handle, displayName) {
  return expected(await request('/v1/auth/register', { method: 'POST', body: { handle, password, display_name: displayName } }), 201);
}
async function wallet(token) { return expected(await request('/v1/wallet', { token }), 200); }
async function history(token) { return expected(await request('/v1/wallet/transactions', { token }), 200).items; }
async function transfer(token, body) { return request('/v1/wallet/transfers', { method: 'POST', token, body }); }
function payment(recipient, amount, extras = {}) {
  return { recipient_handle: recipient, amount_minor: amount, memo: 'API acceptance · simulated', idempotency_key: randomUUID(), ...extras };
}

async function main() {
  console.log(`Checking demo API at ${base}. Creates two isolated test accounts (${runId}); no real funds.`);
  await check('health reports demo mode and live database', async () => {
    assert.deepEqual(expected(await request('/health'), 200), { status: 'ok', mode: 'demo' });
  });

  let alice, bob;
  await check('register two users with separate simulated welcome credits', async () => {
    alice = await register(handles[0].toUpperCase(), '验收甲');
    bob = await register(handles[1], '验收乙');
    assert.equal(alice.user.handle, handles[0]);
    assert.notEqual(alice.user.id, bob.user.id);
    for (const account of [alice, bob]) {
      assert.ok(account.token.length >= 32);
      const value = await wallet(account.token);
      assert.equal(value.balance_minor, 100000);
      assert.equal(value.currency, 'QDC');
      assert.equal(value.mode, 'demo');
      const items = await history(account.token);
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, 'welcome');
      assert.equal(items[0].direction, 'in');
      assert.equal(items[0].amount_minor, 100000);
    }
    expected(await request('/v1/auth/register', { method: 'POST', body: { handle: handles[0], password, display_name: '重复账号' } }), 409, 'HANDLE_TAKEN');
  });

  await check('invalid credentials are generic and private endpoints require authentication', async () => {
    const wrongPassword = await request('/v1/auth/login', { method: 'POST', body: { handle: handles[0], password: 'WrongPassword123!' } });
    const missingUser = await request('/v1/auth/login', { method: 'POST', body: { handle: `absent_${runId}`.slice(0, 24), password: 'WrongPassword123!' } });
    expected(wrongPassword, 401, 'INVALID_CREDENTIALS');
    expected(missingUser, 401, 'INVALID_CREDENTIALS');
    assert.deepEqual(wrongPassword.data, missingUser.data);
    for (const path of ['/v1/me', '/v1/wallet', '/v1/wallet/transactions', `/v1/users/lookup?handle=${handles[0]}`]) {
      expected(await request(path), 401, 'UNAUTHORIZED');
      expected(await request(path, { token: 'invalid-token' }), 401, 'UNAUTHORIZED');
    }
  });

  await check('profile preferences persist across login and invalid enums are rejected', async () => {
    const patch = { display_name: '验收甲 · Q', avatar: 'leaf', bio: '仅模拟测试', theme: 'dark', locale: 'en' };
    const updated = expected(await request('/v1/me', { method: 'PATCH', token: alice.token, body: patch }), 200);
    for (const [key, value] of Object.entries(patch)) assert.equal(updated[key], value);
    const login = expected(await request('/v1/auth/login', { method: 'POST', body: { handle: handles[0], password } }), 200);
    for (const [key, value] of Object.entries(patch)) assert.equal(login.user[key], value);
    expected(await request('/v1/auth/logout', { method: 'POST', token: login.token }), 204);
    expected(await request('/v1/me', { token: login.token }), 401, 'UNAUTHORIZED');
    expected(await request('/v1/me', { token: alice.token }), 200);
    for (const body of [{ theme: 'purple' }, { locale: 'xx' }, { avatar: 'admin' }]) {
      expected(await request('/v1/me', { method: 'PATCH', token: alice.token, body }), 400, 'VALIDATION_ERROR');
    }
    const protectedPatch = await request('/v1/me', { method: 'PATCH', token: alice.token, body: { id: bob.user.id, handle: 'admin', balance_minor: 99999999, roles: ['admin'] } });
    assert.ok([200, 400].includes(protectedPatch.status), 'Unknown protected fields must be rejected or ignored');
    const me = expected(await request('/v1/me', { token: alice.token }), 200);
    assert.equal(me.id, alice.user.id);
    assert.equal(me.handle, handles[0]);
    assert.equal((await wallet(alice.token)).balance_minor, 100000);
  });

  await check('recipient lookup exposes only public fields', async () => {
    const recipient = expected(await request(`/v1/users/lookup?handle=${handles[1].toUpperCase()}`, { token: alice.token }), 200);
    assert.equal(recipient.id, bob.user.id);
    assert.deepEqual(Object.keys(recipient).sort(), ['avatar', 'display_name', 'handle', 'id']);
  });

  let firstTransfer;
  const firstPayment = payment(handles[1], 12345);
  await check('one transfer records matching debit and credit', async () => {
    firstTransfer = expected(await transfer(alice.token, firstPayment), 200);
    assert.equal(firstTransfer.replayed, false);
    assert.equal((await wallet(alice.token)).balance_minor, 87655);
    assert.equal((await wallet(bob.token)).balance_minor, 112345);
    const out = (await history(alice.token)).filter((item) => item.kind === 'transfer');
    const incoming = (await history(bob.token)).filter((item) => item.kind === 'transfer');
    assert.equal(out.length, 1);
    assert.equal(incoming.length, 1);
    assert.equal(out[0].direction, 'out');
    assert.equal(incoming[0].direction, 'in');
    assert.equal(out[0].counterparty_handle, handles[1]);
    assert.equal(incoming[0].counterparty_handle, handles[0]);
    assert.equal(out[0].amount_minor, incoming[0].amount_minor);
  });

  await check('same idempotency key replays once; changed payload conflicts', async () => {
    const replay = expected(await transfer(alice.token, firstPayment), 200);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transfer_id, firstTransfer.transfer_id);
    expected(await transfer(alice.token, { ...firstPayment, amount_minor: 12346 }), 409, 'IDEMPOTENCY_CONFLICT');
    expected(await transfer(alice.token, { ...firstPayment, memo: 'changed memo' }), 409, 'IDEMPOTENCY_CONFLICT');
    expected(await transfer(alice.token, { ...firstPayment, recipient_handle: `absent_${runId}`.slice(0, 24) }), 409, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await wallet(alice.token)).balance_minor, 87655);
    assert.equal((await history(alice.token)).length, 2);
  });

  await check('wallet and history remain scoped to the authenticated account', async () => {
    const bobWallet = await wallet(bob.token);
    const scopedWallet = expected(await request(`/v1/wallet?user_id=${bob.user.id}&account_id=${bobWallet.account_id}`, { token: alice.token }), 200);
    assert.equal(scopedWallet.balance_minor, 87655);
    assert.notEqual(scopedWallet.account_id, bobWallet.account_id);
    const scopedHistory = expected(await request(`/v1/wallet/transactions?user_id=${bob.user.id}&account_id=${bobWallet.account_id}`, { token: alice.token }), 200).items;
    assert.equal(scopedHistory.filter((item) => item.kind === 'transfer')[0].direction, 'out');
  });

  await check('invalid amounts, self transfer and missing recipient leave both wallets unchanged', async () => {
    for (const amount of [0, -1, 1.1, '100', 100000001, null]) {
      expected(await transfer(alice.token, payment(handles[1], amount)), 400, 'VALIDATION_ERROR');
    }
    expected(await transfer(alice.token, payment(handles[0], 1)), 409, 'SELF_TRANSFER');
    expected(await transfer(alice.token, payment(`no_${runId}`.slice(0, 24), 1)), 404, 'USER_NOT_FOUND');
    expected(await transfer(alice.token, payment(handles[1], 87656)), 409, 'INSUFFICIENT_FUNDS');
    assert.equal((await wallet(alice.token)).balance_minor, 87655);
    assert.equal((await wallet(bob.token)).balance_minor, 112345);
    assert.equal((await history(alice.token)).length, 2);
    assert.equal((await history(bob.token)).length, 2);
  });

  await check('concurrent transfers cannot overspend or leave partial entries', async () => {
    const beforeA = (await wallet(alice.token)).balance_minor;
    const beforeB = (await wallet(bob.token)).balance_minor;
    const amount = Math.ceil(beforeA / 3);
    const responses = await Promise.all(Array.from({ length: 10 }, () => transfer(alice.token, payment(handles[1], amount))));
    const successes = responses.filter((result) => result.status === 200);
    assert.equal(successes.length, Math.floor(beforeA / amount));
    for (const result of responses.filter((result) => result.status !== 200)) expected(result, 409, 'INSUFFICIENT_FUNDS');
    const afterA = (await wallet(alice.token)).balance_minor;
    const afterB = (await wallet(bob.token)).balance_minor;
    assert.equal(afterA, beforeA - successes.length * amount);
    assert.equal(afterB, beforeB + successes.length * amount);
    assert.ok(afterA >= 0);
    assert.equal(afterA + afterB, 200000);
    assert.equal((await history(alice.token)).length, 2 + successes.length);
    assert.equal((await history(bob.token)).length, 2 + successes.length);
  });

  await check('concurrent duplicate submissions create a single transfer', async () => {
    const beforeA = (await wallet(alice.token)).balance_minor;
    const beforeItems = (await history(alice.token)).length;
    const body = payment(handles[1], 1);
    const results = await Promise.all(Array.from({ length: 6 }, () => transfer(alice.token, body)));
    const transfers = results.map((result) => expected(result, 200));
    assert.equal(new Set(transfers.map((value) => value.transfer_id)).size, 1);
    assert.equal(transfers.filter((value) => value.replayed === false).length, 1);
    assert.equal((await wallet(alice.token)).balance_minor, beforeA - 1);
    assert.equal((await history(alice.token)).length, beforeItems + 1);
  });

  await check('opposite-direction concurrent transfers finish without deadlocks', async () => {
    const beforeA = (await wallet(alice.token)).balance_minor;
    const beforeB = (await wallet(bob.token)).balance_minor;
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2 === 0
      ? transfer(alice.token, payment(handles[1], 1))
      : transfer(bob.token, payment(handles[0], 1))));
    for (const result of results) expected(result, 200);
    assert.equal((await wallet(alice.token)).balance_minor, beforeA);
    assert.equal((await wallet(bob.token)).balance_minor, beforeB);
  });

  await check('logout revokes the current token', async () => {
    expected(await request('/v1/auth/logout', { method: 'POST', token: alice.token }), 204);
    expected(await request('/v1/wallet', { token: alice.token }), 401, 'UNAUTHORIZED');
    expected(await request('/v1/auth/logout', { method: 'POST', token: bob.token }), 204);
    expected(await request('/v1/me', { token: bob.token }), 401, 'UNAUTHORIZED');
  });

  if (process.env.Q_VERIFY_DATABASE === 'true') {
    await check('read-only PostgreSQL audit confirms balanced immutable-ledger projections', async () => {
      if (base !== 'http://127.0.0.1:8787' && !process.env.DATABASE_URL) {
        throw new Error('Set DATABASE_URL explicitly when auditing a non-default API.');
      }
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo' });
      try {
        await client.connect();
        await client.query('BEGIN READ ONLY');
        const known = await client.query('SELECT count(*)::int AS count FROM identities WHERE handle = ANY($1::text[])', [handles]);
        assert.equal(known.rows[0].count, 2, 'DATABASE_URL must point at the same database as the tested API');
        const unbalanced = await client.query(`
          SELECT t.id FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
          GROUP BY t.id HAVING count(e.id) <> 2 OR sum(e.delta_minor) <> 0`);
        assert.equal(unbalanced.rowCount, 0, 'Every journal has exactly two balanced entries');
        const invalidBalance = await client.query(`
          SELECT a.id FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          GROUP BY a.id HAVING a.balance_minor <> coalesce(sum(e.delta_minor), 0)
            OR (a.kind = 'user' AND a.balance_minor < 0)`);
        assert.equal(invalidBalance.rowCount, 0, 'Every cached balance equals the sum of its immutable entries');
        const total = await client.query('SELECT coalesce(sum(delta_minor), 0)::text AS net FROM ledger_entries');
        assert.equal(total.rows[0].net, '0');
        const hashes = await client.query("SELECT count(*)::int AS count FROM identities WHERE password_hash NOT LIKE '$argon2id$%'");
        assert.equal(hashes.rows[0].count, 0, 'All stored passwords use Argon2id');
        const tokens = await client.query('SELECT count(*)::int AS count FROM sessions WHERE octet_length(token_hash) <> 32 OR expires_at <= created_at');
        assert.equal(tokens.rows[0].count, 0, 'Sessions contain only hashes and a finite expiry');
        await client.query('COMMIT');
      } finally { await client.end(); }
    });
  }

  console.log(`\n${passed} API acceptance groups passed. Test handles: ${handles.join(', ')}.`);
  console.log('These test accounts are retained for inspection. This script does not delete ledger records.');
}

main().catch((error) => {
  console.error(`FAIL after ${passed} groups: ${error.message}`);
  process.exitCode = 1;
});
