import { BlockList, isIP } from 'node:net';
import { resolveApiUrl } from '../src/services/api-target.mjs';

const nonPublicIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) nonPublicIpv4.addSubnet(address, prefix);

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const nonPublicIpv6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) nonPublicIpv6.addSubnet(address, prefix, 'ipv6');

const localSuffixes = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'localdomain', 'test', 'invalid', 'example', 'onion'];

/**
 * Checks configuration syntax only; DNS, certificate and service readiness need separate release verification.
 * @param {unknown} value
 */
export function isPublicHttpsApiUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\?#]/u.test(value)) return false;
  const authority = value.slice(8).split('/')[0];
  if (!authority || authority.includes('@')) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const family = isIP(hostname);
  if (family === 4) return !nonPublicIpv4.check(hostname);
  if (family === 6) return globalIpv6.check(hostname, 'ipv6') && !nonPublicIpv6.check(hostname, 'ipv6');
  if (hostname.length > 253 || localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))) return false;
  const labels = hostname.split('.');
  return labels.length > 1 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/** @param {Record<string, string | undefined>} env */
export function assertStoreApiConfig(env) {
  if (env.Q_LOCAL_API_TEST !== undefined && !['0', '1'].includes(env.Q_LOCAL_API_TEST)) {
    throw new Error('Q_LOCAL_API_TEST must be 0 or 1.');
  }
  const localTest = env.Q_LOCAL_API_TEST === '1';
  const storeBuild = env.Q_STORE_BUILD === '1' || ['production', 'testflight'].includes(env.EAS_BUILD_PROFILE ?? '');
  const platform = (env.PLATFORM_NAME ?? '').toLowerCase();
  const nativeAppleBuild = ['iphoneos', 'iphonesimulator'].includes(platform);
  if (localTest && storeBuild) {
    throw new Error('Local API test builds cannot use a store build flag or production/TestFlight profile.');
  }
  if (localTest && !env.EXPO_PUBLIC_API_URL?.trim()) {
    throw new Error('Local API test builds require an explicit EXPO_PUBLIC_API_URL; the public default is not a test endpoint.');
  }
  if (localTest && nativeAppleBuild && platform !== 'iphonesimulator') {
    throw new Error('Local API test native builds are restricted to the iOS simulator.');
  }
  if (!localTest && (storeBuild || nativeAppleBuild) && !isPublicHttpsApiUrl(resolveApiUrl(env.EXPO_PUBLIC_API_URL))) {
    throw new Error('Native application and store builds require EXPO_PUBLIC_API_URL to be a public HTTPS API address without credentials, query parameters, or a fragment. Use the isolated local API test variant for local native testing.');
  }
}

/**
 * The variant is build configuration, never a runtime fallback to another server.
 * @param {Record<string, string | undefined>} env
 * @param {{iosBundleIdentifier?: string, androidPackage?: string}} identity
 * @returns {{localTest: boolean, apiEnvironment: 'public' | 'local-test', configuredApiOrigin: string | null, iosBundleIdentifier: string | undefined, androidPackage: string | undefined}}
 */
export function resolveBuildVariant(env, identity) {
  assertStoreApiConfig(env);
  const localTest = env.Q_LOCAL_API_TEST === '1';
  if (localTest && (!identity.iosBundleIdentifier || !identity.androidPackage)) {
    throw new Error('Local API test builds require base iOS and Android application identifiers.');
  }
  const iosBundleIdentifier = localTest ? `${identity.iosBundleIdentifier}.localtest` : identity.iosBundleIdentifier;
  const androidPackage = localTest ? `${identity.androidPackage}.localtest` : identity.androidPackage;
  const nativeAppleBuild = ['iphoneos', 'iphonesimulator'].includes((env.PLATFORM_NAME ?? '').toLowerCase());
  // Expo also evaluates app.config from the EXConstants pod target. Its bundle
  // identifier belongs to a resource bundle, not to the app being produced.
  const applicationTarget = env.PRODUCT_TYPE === 'com.apple.product-type.application' || env.WRAPPER_EXTENSION === 'app';
  if (nativeAppleBuild && applicationTarget && env.PRODUCT_BUNDLE_IDENTIFIER !== iosBundleIdentifier) {
    throw new Error('The native application identifier does not match the selected build variant. Regenerate the native project for that variant before building.');
  }
  let configuredApiOrigin = null;
  try {
    const url = new URL(resolveApiUrl(env.EXPO_PUBLIC_API_URL));
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
      configuredApiOrigin = url.origin;
    }
  } catch { /* Invalid explicit development URLs never fall back to a different server. */ }
  return { localTest, apiEnvironment: localTest ? 'local-test' : 'public', configuredApiOrigin, iosBundleIdentifier, androidPackage };
}
