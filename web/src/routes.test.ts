import assert from 'node:assert/strict';
import test from 'node:test';
import { adminPageForPath, adminPages } from './routes';
test('only connected payment modules are navigable; historical prototype routes do not resolve to data', () => {
  for (const page of adminPages) assert.equal(adminPageForPath(page.path), page.id);
  for (const root of ['/', '/wallet-payments', '/wallet-payments/']) assert.equal(adminPageForPath(root), 'orders');
  for (const legacy of ['/accounts', '/sessions', '/refunds', '/roles', '/ai-calls', '/bank-demo-ledger', '/capabilities', '/wallet-payments/unknown']) assert.equal(adminPageForPath(legacy), null);
});
