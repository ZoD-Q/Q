import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
if (process.env.CI_COMMIT_SHA && process.env.CI_COMMIT_SHA !== sha) {
  throw new Error('Build checkout does not match CI_COMMIT_SHA');
}
writeFileSync(new URL('../dist/version.json', import.meta.url), JSON.stringify({
  sha,
  mode: 'demo',
  sourceDirty: git('status', '--porcelain').length > 0,
  builtAt: new Date().toISOString(),
  pipelineId: process.env.CI_PIPELINE_ID ?? null,
}, null, 2) + '\n');
