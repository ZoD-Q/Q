import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStoreApiConfig, isPublicHttpsApiUrl, resolveBuildVariant } from './store-config.mjs';
import { DEFAULT_API_URL, resolveApiUrl } from '../src/services/api-target.mjs';

const identity = { iosBundleIdentifier: 'com.kaicloud.xiaoq', androidPackage: 'com.kaicloud.xiaoq' };
const iosApplication = { PRODUCT_TYPE: 'com.apple.product-type.application' };
const require = createRequire(import.meta.url);
const { ensureNativeApiGuard, PHASE_NAME, SHELL_SCRIPT } = require('./with-native-api-guard.cjs');

test('ordinary development and web exports do not require a store API', () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { EAS_BUILD_PROFILE: 'development' }, { Q_STORE_BUILD: '0' }]) {
    assert.doesNotThrow(() => assertStoreApiConfig(env));
  }
});

test('each store build selector uses the stable default and rejects unsafe overrides', () => {
  for (const selector of [{ Q_STORE_BUILD: '1' }, { EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'testflight', Q_STORE_BUILD: '0' }]) {
    for (const value of [' ', 'https://localhost', 'http://api.example.com']) {
      assert.throws(() => assertStoreApiConfig({ ...selector, EXPO_PUBLIC_API_URL: value }), /require EXPO_PUBLIC_API_URL/);
    }
    for (const EXPO_PUBLIC_API_URL of [undefined, '']) {
      assert.doesNotThrow(() => assertStoreApiConfig({ ...selector, EXPO_PUBLIC_API_URL }));
      assert.equal(resolveBuildVariant({ ...selector, EXPO_PUBLIC_API_URL }, identity).configuredApiOrigin, DEFAULT_API_URL);
    }
    assert.doesNotThrow(() => assertStoreApiConfig({ ...selector, EXPO_PUBLIC_API_URL: 'https://api.example.com/q' }));
  }
});

test('valid public HTTPS hosts retain API paths and ports', () => {
  for (const value of ['https://api.example.com', 'HTTPS://API.EXAMPLE.COM/q/', 'https://api.example.com:8443/v1', 'https://api.example.com./q', 'https://8.8.8.8', 'https://[2606:4700::1111]/q']) {
    assert.equal(isPublicHttpsApiUrl(value), true, value);
  }
});

test('rejects malformed URLs, credentials, query parameters and fragments', () => {
  for (const value of [null, 1, 'api.example.com', 'https:///api.example.com', 'http://api.example.com', 'file:///tmp/api', ' https://api.example.com', 'https://api.\nexample.com', 'https://api.example.com\\q', 'https://user:secret@api.example.com', 'https://@api.example.com', 'https://api.example.com?', 'https://api.example.com#', 'https://api.example.com?q=secret', 'https://api.example.com#secret', 'https://-api.example.com', 'https://api..example.com']) {
    assert.equal(isPublicHttpsApiUrl(value), false, String(value));
  }
});

test('rejects local and reserved DNS names including trailing-dot variants', () => {
  for (const host of ['localhost', 'localhost.', 'api.localhost', 'server', 'server.local', 'api.internal', 'api.lan', 'api.home', 'api.home.arpa', 'api.localdomain', 'api.test', 'api.invalid', 'api.example', 'api.onion']) {
    assert.equal(isPublicHttpsApiUrl(`https://${host}`), false, host);
  }
});

test('rejects non-public IPv4 ranges and alternative loopback encodings', () => {
  for (const host of ['0.0.0.0', '10.0.2.2', '100.64.0.1', '100.127.255.255', '127.1', '2130706433', '0x7f000001', '0177.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPublicHttpsApiUrl(`https://${host}`), false, host);
  }
  for (const host of ['100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0']) {
    assert.equal(isPublicHttpsApiUrl(`https://${host}`), true, host);
  }
});

test('rejects private, special-use and IPv4-mapped IPv6 addresses', () => {
  for (const host of ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) {
    assert.equal(isPublicHttpsApiUrl(`https://[${host}]`), false, host);
  }
});

test('configuration failures never echo the supplied URL or credentials', () => {
  assert.throws(() => assertStoreApiConfig({ Q_STORE_BUILD: '1', EXPO_PUBLIC_API_URL: 'https://private-user:DO_NOT_ECHO@api.example.com?q=DO_NOT_ECHO' }), error => {
    assert.equal(error.message.includes('DO_NOT_ECHO'), false);
    assert.equal(error.message.includes('private-user'), false);
    return true;
  });
});

test('native Release requires a public API even without a store flag', () => {
  for (const PLATFORM_NAME of ['iphoneos', 'iphonesimulator']) {
    for (const CONFIGURATION of ['Release', 'release', 'Profile']) {
      for (const EXPO_PUBLIC_API_URL of [' ', 'http://127.0.0.1:57637', 'https://api.internal']) {
        assert.throws(() => assertStoreApiConfig({ PLATFORM_NAME, CONFIGURATION, Q_STORE_BUILD: '0', EXPO_PUBLIC_API_URL }), /public HTTPS/);
      }
      for (const EXPO_PUBLIC_API_URL of [undefined, '']) assert.doesNotThrow(() => assertStoreApiConfig({ PLATFORM_NAME, CONFIGURATION, EXPO_PUBLIC_API_URL }));
      assert.doesNotThrow(() => assertStoreApiConfig({ PLATFORM_NAME, CONFIGURATION, EXPO_PUBLIC_API_URL: 'https://api.example.com' }));
    }
    assert.throws(() => assertStoreApiConfig({ PLATFORM_NAME, CONFIGURATION: 'Debug', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' }), /isolated local API test variant/);
  }
  assert.doesNotThrow(() => assertStoreApiConfig({ NODE_ENV: 'production' }));
});

test('local fixture builds have separate identities and require a matching simulator project', () => {
  const fixture = { Q_LOCAL_API_TEST: '1', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' };
  const variant = resolveBuildVariant(fixture, identity);
  assert.equal(variant.iosBundleIdentifier, 'com.kaicloud.xiaoq.localtest');
  assert.equal(variant.androidPackage, 'com.kaicloud.xiaoq.localtest');
  assert.equal(variant.apiEnvironment, 'local-test');
  assert.equal(variant.configuredApiOrigin, 'http://127.0.0.1:57637');
  for (const PRODUCT_BUNDLE_IDENTIFIER of [undefined, 'com.kaicloud.xiaoq', 'com.kaicloud.unrelated']) {
    assert.throws(() => resolveBuildVariant({ ...fixture, ...iosApplication, PLATFORM_NAME: 'iphonesimulator', CONFIGURATION: 'Release', PRODUCT_BUNDLE_IDENTIFIER }, identity), /identifier/);
  }
  assert.doesNotThrow(() => resolveBuildVariant({ ...fixture, ...iosApplication, PLATFORM_NAME: 'iphonesimulator', CONFIGURATION: 'Release', PRODUCT_BUNDLE_IDENTIFIER: variant.iosBundleIdentifier }, identity));
  assert.throws(() => resolveBuildVariant({ ...fixture, PLATFORM_NAME: 'iphoneos', CONFIGURATION: 'Debug', PRODUCT_BUNDLE_IDENTIFIER: variant.iosBundleIdentifier }, identity), /simulator/);
  assert.throws(() => resolveBuildVariant(fixture, {}), /identifiers/);
  for (const EXPO_PUBLIC_API_URL of [undefined, '', ' ']) {
    assert.throws(() => resolveBuildVariant({ Q_LOCAL_API_TEST: '1', EXPO_PUBLIC_API_URL }, identity), /explicit EXPO_PUBLIC_API_URL/);
  }
});

test('Debug application builds cannot embed a local service under the public app identity', () => {
  const debug = { ...iosApplication, PLATFORM_NAME: 'iphonesimulator', CONFIGURATION: 'Debug', PRODUCT_BUNDLE_IDENTIFIER: identity.iosBundleIdentifier };
  assert.throws(() => resolveBuildVariant({ ...debug, EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' }, identity), /isolated local API test variant/);
  assert.doesNotThrow(() => resolveBuildVariant({ ...debug, EXPO_PUBLIC_API_URL: 'https://api.example.com' }, identity));
  assert.doesNotThrow(() => resolveBuildVariant(debug, identity));
  const fixture = { ...debug, Q_LOCAL_API_TEST: '1', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637', PRODUCT_BUNDLE_IDENTIFIER: `${identity.iosBundleIdentifier}.localtest` };
  assert.doesNotThrow(() => resolveBuildVariant(fixture, identity));
  assert.throws(() => resolveBuildVariant({ ...fixture, PRODUCT_BUNDLE_IDENTIFIER: identity.iosBundleIdentifier }, identity), /identifier/);
  assert.doesNotThrow(() => assertStoreApiConfig({ NODE_ENV: 'production', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' }));
});

test('fixture mode cannot weaken store validation or silently reuse the fixture native project', () => {
  for (const selector of [{ Q_STORE_BUILD: '1' }, { EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'testflight' }]) {
    assert.throws(() => resolveBuildVariant({ ...selector, Q_LOCAL_API_TEST: '1', EXPO_PUBLIC_API_URL: 'https://api.example.com' }, identity), /cannot use a store/);
  }
  assert.throws(() => resolveBuildVariant({ ...iosApplication, PLATFORM_NAME: 'iphonesimulator', CONFIGURATION: 'Release', PRODUCT_BUNDLE_IDENTIFIER: 'com.kaicloud.xiaoq.localtest', EXPO_PUBLIC_API_URL: 'https://api.example.com' }, identity), /identifier/);
  assert.throws(() => resolveBuildVariant({ Q_LOCAL_API_TEST: 'true' }, identity), /must be 0 or 1/);
});

test('CocoaPods config evaluation does not compare its resource bundle ID with the app ID', () => {
  const pod = { PLATFORM_NAME: 'iphonesimulator', CONFIGURATION: 'Release', PRODUCT_TYPE: 'com.apple.product-type.bundle',
    WRAPPER_EXTENSION: 'bundle', PRODUCT_BUNDLE_IDENTIFIER: 'org.cocoapods.EXConstants', EXPO_PUBLIC_API_URL: 'https://api.example.com' };
  assert.doesNotThrow(() => resolveBuildVariant(pod, identity));
  assert.throws(() => resolveBuildVariant({ ...pod, CONFIGURATION: 'Debug', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' }, identity), /isolated local API test variant/);
  assert.doesNotThrow(() => resolveBuildVariant({ ...pod, Q_LOCAL_API_TEST: '1', EXPO_PUBLIC_API_URL: 'http://127.0.0.1:57637' }, identity));
  assert.throws(() => resolveBuildVariant({ ...pod, PRODUCT_TYPE: undefined, WRAPPER_EXTENSION: 'app' }, identity), /identifier/);
  assert.throws(() => resolveBuildVariant({ ...pod, ...iosApplication, PRODUCT_BUNDLE_IDENTIFIER: undefined }, identity), /identifier/);
});

test('public identity is preserved and metadata excludes secrets and API paths', () => {
  const variant = resolveBuildVariant({ EXPO_PUBLIC_API_URL: 'https://api.example.com/q/v1' }, identity);
  assert.equal(variant.localTest, false);
  assert.equal(variant.iosBundleIdentifier, identity.iosBundleIdentifier);
  assert.equal(variant.androidPackage, identity.androidPackage);
  assert.equal(variant.apiEnvironment, 'public');
  assert.equal(variant.configuredApiOrigin, 'https://api.example.com');
  for (const EXPO_PUBLIC_API_URL of ['https://user:SECRET@api.example.com', 'https://api.example.com?key=SECRET', 'https://api.example.com#SECRET']) {
    assert.equal(resolveBuildVariant({ EXPO_PUBLIC_API_URL }, identity).configuredApiOrigin, null);
  }
});

test('runtime and build metadata share one stable default without replacing explicit targets', () => {
  assert.equal(DEFAULT_API_URL, 'https://q.kaicloudpay.com');
  for (const value of [undefined, '']) {
    assert.equal(resolveApiUrl(value), DEFAULT_API_URL);
    assert.equal(resolveBuildVariant({ EXPO_PUBLIC_API_URL: value }, identity).configuredApiOrigin, DEFAULT_API_URL);
  }
  assert.equal(resolveApiUrl('http://127.0.0.1:57637/'), 'http://127.0.0.1:57637');
  assert.equal(resolveApiUrl('https://api.example.com/q/'), 'https://api.example.com/q');
  for (const value of [' ', 'invalid-target', 'http://localhost']) assert.equal(resolveApiUrl(value), value);
});

test('Expo config applies the fixture name and identity without changing the public app', () => {
  for (const localTest of [false, true]) {
    const result = spawnSync(process.execPath, ['../node_modules/expo/bin/cli', 'config', '--type', 'public', '--json'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      env: { ...process.env, EXPO_NO_DOTENV: '1', Q_STORE_BUILD: '0', EAS_BUILD_PROFILE: 'development',
        CONFIGURATION: '', PLATFORM_NAME: '', PRODUCT_BUNDLE_IDENTIFIER: '', Q_LOCAL_API_TEST: localTest ? '1' : '0',
        EXPO_PUBLIC_API_URL: localTest ? 'http://127.0.0.1:57637' : '' },
    });
    assert.equal(result.status, 0, 'Expo should accept this explicit build variant');
    const config = JSON.parse(result.stdout);
    assert.equal(config.name, localTest ? '小Q 本地测试' : '小Q');
    assert.equal(config.ios.bundleIdentifier, identity.iosBundleIdentifier + (localTest ? '.localtest' : ''));
    assert.equal(config.android.package, identity.androidPackage + (localTest ? '.localtest' : ''));
    assert.equal(config.scheme, localTest ? 'xiaoq-localtest' : 'xiaoq');
    assert.equal(config.extra.apiEnvironment, localTest ? 'local-test' : 'public');
    assert.equal(config.extra.configuredApiOrigin, localTest ? 'http://127.0.0.1:57637' : DEFAULT_API_URL);
  }
});

test('native guard is idempotent, first, and always runs independently of bundling', () => {
  const project = require('xcode').project('guard-test.pbxproj');
  project.hash = { project: { objects: {
    PBXNativeTarget: { APP: { productType: '"com.apple.product-type.application"', buildPhases: [{ value: 'BUNDLE', comment: 'Bundle React Native code and images' }] } },
    PBXShellScriptBuildPhase: { BUNDLE: { isa: 'PBXShellScriptBuildPhase', shellScript: '"exit 0"' } },
    PBXFileReference: {}, PBXBuildFile: {},
  } } };
  ensureNativeApiGuard(project);
  ensureNativeApiGuard(project);
  const phases = project.pbxNativeTargetSection().APP.buildPhases;
  assert.equal(phases.length, 2);
  assert.equal(phases[0].comment, PHASE_NAME);
  assert.equal(phases[1].value, 'BUNDLE');
  const guard = project.hash.project.objects.PBXShellScriptBuildPhase[phases[0].value];
  assert.equal(guard.alwaysOutOfDate, 1);
  assert.equal(guard.runOnlyForDeploymentPostprocessing, 0);
  assert.equal(guard.showEnvVarsInLog, 0);
  assert.equal(JSON.parse(guard.shellScript), SHELL_SCRIPT);
});

test('actual native validation phase rejects stale Debug fixture identity even when bundling is skipped', () => {
  const envDirectory = mkdtempSync(join(tmpdir(), 'q-native-api-guard-'));
  const nativeRoot = fileURLToPath(new URL('../', import.meta.url));
  // Git Bash accepts forward-slash Windows paths; keep the actual native guard under test.
  const shellPath = value => value.replaceAll('\\', '/');
  const base = { ...process.env, ...iosApplication, SRCROOT: shellPath(envDirectory), PROJECT_DIR: shellPath(join(nativeRoot, 'ios')),
    NODE_BINARY: shellPath(process.execPath), EXPO_NO_DOTENV: '1', Q_STORE_BUILD: '0', EAS_BUILD_PROFILE: 'development',
    CONFIGURATION: 'Debug', PLATFORM_NAME: 'iphonesimulator', WRAPPER_EXTENSION: 'app', SKIP_BUNDLING: '1',
    Q_LOCAL_API_TEST: '0', EXPO_PUBLIC_API_URL: '', PRODUCT_BUNDLE_IDENTIFIER: identity.iosBundleIdentifier };
  const bash = process.env.Q_TEST_BASH || (process.platform === 'win32' ? 'bash' : '/bin/bash');
  const run = (overrides = {}) => spawnSync(bash, ['-c', SHELL_SCRIPT], { env: { ...base, ...overrides }, encoding: 'utf8' });
  try {
    assert.equal(run().status, 0);
    writeFileSync(join(envDirectory, '.xcode.env.local'), 'export EXPO_PUBLIC_API_URL=http://127.0.0.1:57637\n');
    const publicLocal = run();
    assert.notEqual(publicLocal.status, 0);
    assert.match(publicLocal.stderr, /isolated local API test variant/);
    writeFileSync(join(envDirectory, '.xcode.env.local'), 'export Q_LOCAL_API_TEST=1\nexport EXPO_PUBLIC_API_URL=http://127.0.0.1:57637\n');
    const staleFixture = run();
    assert.notEqual(staleFixture.status, 0);
    assert.match(staleFixture.stderr, /identifier/);
    assert.equal(run({ PRODUCT_BUNDLE_IDENTIFIER: `${identity.iosBundleIdentifier}.localtest` }).status, 0);
  } finally { rmSync(envDirectory, { recursive: true, force: true }); }
});
