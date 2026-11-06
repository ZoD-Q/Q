import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
export default defineConfig({
  base: '/q-admin/',
  // The separately deployed /privacy source is not part of the operator workspace.
  publicDir: false,
  plugins: [react()],
  define: { __BUILD_SHA__: JSON.stringify(sha.slice(0, 8)) },
  build: { sourcemap: false, assetsInlineLimit: 0 },
});
