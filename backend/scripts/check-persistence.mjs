#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.local/restart-check.json');
const mode = process.argv[2];
if (!['snapshot', 'verify'].includes(mode)) {
  console.error('Usage: node scripts/check-persistence.mjs snapshot|verify');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo' });
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const profiles = (await client.query(`SELECT i.id,i.handle,p.display_name,p.avatar,p.bio,p.theme,p.locale
    FROM identities i JOIN profiles p ON p.user_id=i.id ORDER BY i.id`)).rows;
  const accounts = (await client.query('SELECT id,user_id,kind,currency,balance_minor FROM ledger_accounts ORDER BY id')).rows;
  const journals = (await client.query('SELECT * FROM ledger_transactions ORDER BY id')).rows;
  const entries = (await client.query('SELECT * FROM ledger_entries ORDER BY id')).rows;
  const seeds = (await client.query(`SELECT i.handle,count(t.id)::int AS welcome_count
    FROM identities i JOIN ledger_accounts a ON a.user_id=i.id
    LEFT JOIN ledger_transactions t ON t.recipient_account_id=a.id AND t.kind='welcome'
    WHERE i.handle IN ('kai','lin') GROUP BY i.handle ORDER BY i.handle`)).rows;
  await client.query('COMMIT');
  assert.equal(seeds.length, 2, 'Both local demo accounts must exist');
  assert.ok(seeds.every((row) => row.welcome_count === 1), 'Each demo account must receive exactly one welcome credit');
  const snapshot = { profiles, accounts, journals, entries, seeds };
  // JSON normalization makes PostgreSQL timestamp values comparable across separate Node processes.
  const normalized = JSON.parse(JSON.stringify(snapshot));
  if (mode === 'snapshot') {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(normalized, null, 2), { mode: 0o600 });
    console.log(`Snapshot saved: ${profiles.length} profiles, ${journals.length} journals. Contains no passwords or session tokens.`);
  } else {
    const before = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(normalized, before, 'Profiles, balances and journal entries must survive restart without a second welcome grant');
    console.log(`PASS restart persistence: ${profiles.length} profiles and ${journals.length} journals unchanged; kai/lin each still has one welcome credit.`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { await client.end(); }
