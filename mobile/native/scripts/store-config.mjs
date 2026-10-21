import { BlockList, isIP } from 'node:net';

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
  const storeBuild = env.Q_STORE_BUILD === '1' || ['production', 'testflight'].includes(env.EAS_BUILD_PROFILE ?? '');
  if (storeBuild && !isPublicHttpsApiUrl(env.EXPO_PUBLIC_API_URL)) {
    throw new Error('Store builds require EXPO_PUBLIC_API_URL to be a public HTTPS API address without credentials, query parameters, or a fragment. Configure the verified backend before building.');
  }
}
