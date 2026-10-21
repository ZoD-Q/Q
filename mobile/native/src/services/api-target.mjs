// Shared by the app and build configuration; contains no Node or environment access.
export const DEFAULT_API_URL = 'https://q.kaicloudpay.com';

/** @param {string | undefined} configuredUrl */
export function resolveApiUrl(configuredUrl) {
  return (configuredUrl === undefined || configuredUrl === '' ? DEFAULT_API_URL : configuredUrl).replace(/\/$/, '');
}
