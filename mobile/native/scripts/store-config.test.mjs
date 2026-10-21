import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStoreApiConfig, isPublicHttpsApiUrl } from './store-config.mjs';

test('ordinary development and web exports do not require a store API', () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { EAS_BUILD_PROFILE: 'development' }, { Q_STORE_BUILD: '0' }]) {
    assert.doesNotThrow(() => assertStoreApiConfig(env));
  }
});

test('each store build selector requires explicit API configuration', () => {
  for (const selector of [{ Q_STORE_BUILD: '1' }, { EAS_BUILD_PROFILE: 'production' }, { EAS_BUILD_PROFILE: 'testflight', Q_STORE_BUILD: '0' }]) {
    for (const value of [undefined, '', 'https://localhost', 'http://api.example.com']) {
      assert.throws(() => assertStoreApiConfig({ ...selector, EXPO_PUBLIC_API_URL: value }), /Store builds require EXPO_PUBLIC_API_URL/);
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
