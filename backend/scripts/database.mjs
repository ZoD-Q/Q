#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, '.local/postgres');
const logFile = resolve(root, '.local/postgres.log');
const lockFile = resolve(root, '.local/postgres-command.lock');
const user = 'xiaoq';
const password = 'xiaoq_demo_local';
const database = 'xiaoq_demo';
const port = 55432;
const command = process.argv[2] ?? 'status';

if (!['start', 'stop', 'status'].includes(command)) {
  console.error('Usage: node scripts/database.mjs start|stop|status');
  process.exit(2);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function getBinaries() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const supported = { darwin: ['arm64', 'x64'], linux: ['arm', 'arm64', 'ia32', 'ppc64', 'x64'], windows: ['x64'] };
  if (!supported[platform]?.includes(process.arch)) {
    throw new Error(`No bundled PostgreSQL for ${platform}/${process.arch}. Use an external PostgreSQL DATABASE_URL.`);
  }
  const binaries = await import(`@embedded-postgres/${platform}-${process.arch}`);
  for (const path of [binaries.pg_ctl, binaries.initdb, binaries.postgres]) {
    try { await access(path, constants.X_OK); } catch { await chmod(path, 0o755); }
  }
  return binaries;
}

async function running(binaries) {
  if (!await exists(resolve(dataDir, 'PG_VERSION'))) return false;
  try {
    await run(binaries.pg_ctl, ['-D', dataDir, 'status']);
    return true;
  } catch (error) {
    if (error.code === 3 || error.code === 4) return false;
    throw error;
  }
}

async function initialise(binaries) {
  if (await exists(resolve(dataDir, 'PG_VERSION'))) return;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const passwordFile = resolve(root, `.local/pg-init-password-${process.pid}`);
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await run(binaries.initdb, [
      '-D', dataDir, '--username', user, '--pwfile', passwordFile,
      '--auth-host=scram-sha-256', '--auth-local=scram-sha-256',
      '--encoding=UTF8', '--locale=C',
    ], { maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  } finally {
    await unlink(passwordFile).catch(() => {});
  }
}

async function ensureDatabase() {
  const client = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres', connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (result.rowCount === 0) await client.query('CREATE DATABASE xiaoq_demo');
  } finally {
    await client.end();
  }
}

async function takeLock() {
  await mkdir(resolve(root, '.local'), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await writeFile(lockFile, String(process.pid), { mode: 0o600, flag: 'wx' });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lockFile, 'utf8').catch(() => ''));
      if (Number.isInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); } catch (probeError) {
          if (probeError.code === 'ESRCH') { await unlink(lockFile).catch(() => {}); continue; }
        }
      }
      await delay(250);
    }
  }
  throw new Error(`Another database command is still active. Check ${lockFile}.`);
}

async function main() {
  if (process.getuid?.() === 0) throw new Error('Run this local PostgreSQL helper as your normal user, not root.');
  const binaries = await getBinaries();
  await takeLock();
  try {
    if (command === 'status') {
      const active = await running(binaries);
      console.log(active ? `Local PostgreSQL is running at 127.0.0.1:${port}/${database}.` : 'Local PostgreSQL is stopped.');
      return;
    }
    if (command === 'stop') {
      if (await running(binaries)) {
        await run(binaries.pg_ctl, ['-D', dataDir, '-m', 'fast', '-w', '-t', '30', 'stop']);
        console.log('Local PostgreSQL stopped. All data has been kept.');
      } else console.log('Local PostgreSQL is already stopped.');
      return;
    }
    await initialise(binaries);
    if (!await running(binaries)) {
      // pg_ctl detaches the server. Empty unix_socket_directories keeps access on loopback TCP only.
      await run(binaries.pg_ctl, [
        '-D', dataDir, '-l', logFile, '-w', '-t', '30',
        '-o', `-p ${port} -h 127.0.0.1 -c unix_socket_directories=''`, 'start',
      ]);
    }
    await ensureDatabase();
    console.log(`Local PostgreSQL is ready at 127.0.0.1:${port}/${database}. Data: ${dataDir}`);
  } finally {
    await unlink(lockFile).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.stderr) console.error(error.stderr.trim());
  console.error('The helper never deletes the database. Check .local/postgres.log if startup failed.');
  process.exitCode = 1;
});
