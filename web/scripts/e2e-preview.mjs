// Dedicated local-test output. Never overwrites the production dist artifact.
import { spawnSync, spawn } from 'node:child_process';
const vite = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname;
const cwd = new URL('../', import.meta.url).pathname;
const env = { ...process.env, VITE_Q_LOCAL_API_TEST: '1', VITE_Q_API_URL: 'http://127.0.0.1:18789' };
const build = spawnSync(process.execPath, [vite, 'build', '--outDir', '.local/payment-e2e-dist'], { cwd, env, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const preview = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort', '--outDir', '.local/payment-e2e-dist'], { cwd, env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => preview.kill(signal));
preview.on('exit', code => process.exit(code ?? 0));
