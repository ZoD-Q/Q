import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { loadEnvFile(resolve(root, '.env')); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const localUrl = 'postgresql://xiaoq:xiaoq_demo_local@127.0.0.1:55432/xiaoq_demo';
process.env.DATABASE_URL ??= localUrl;
process.env.Q_BIND ??= '127.0.0.1:8787';
// Public demo credentials are automatically seeded only for this exact local development database.
process.env.Q_SEED_DEMO ??= process.env.DATABASE_URL === localUrl ? 'true' : 'false';

const child = spawn(process.argv[2], ['run', '--', ...process.argv.slice(3)], {
  cwd: root, env: process.env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
