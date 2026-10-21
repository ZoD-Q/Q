import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveBuildVariant } from './store-config.mjs';

// Xcode invokes this independently of React Native bundling, including Debug.
// Read the same project environment files as Expo after .xcode.env(.local).
const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
require('@expo/env').loadProjectEnv(projectRoot, {
  mode: /debug/i.test(process.env.CONFIGURATION ?? '') ? 'development' : 'production',
});
const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
try {
  if (!['iphoneos', 'iphonesimulator'].includes(process.env.PLATFORM_NAME ?? '')
    || !(process.env.PRODUCT_TYPE === 'com.apple.product-type.application' || process.env.WRAPPER_EXTENSION === 'app')) {
    throw new Error('The Q API target validation phase must run on the native application target.');
  }
  resolveBuildVariant(process.env, { iosBundleIdentifier: app.ios?.bundleIdentifier, androidPackage: app.android?.package });
} catch (error) {
  // Configuration errors never include raw URLs, credentials, or environment dumps.
  console.error(`error: ${error instanceof Error ? error.message : 'Q API target validation failed.'}`);
  process.exitCode = 1;
}
