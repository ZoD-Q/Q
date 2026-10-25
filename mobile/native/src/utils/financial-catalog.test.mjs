import test from 'node:test';
import assert from 'node:assert/strict';
import { listings, findListings, trustedSource, reviewedOn } from '../prototype/financial-catalog/catalog.ts';

test('public catalog has unique entries, traceable sources and two providers per category', () => {
  assert.equal(new Set(listings.map(item => item.id)).size, listings.length);
  for (const category of ['installments', 'insurance', 'finance']) {
    assert.equal(new Set(findListings(category, '').map(item => item.company[0])).size, 2);
  }
  assert.match(reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
  for (const item of listings) {
    assert.ok(trustedSource(item.url));
    assert.ok(item.risk[0] && item.costs[0] && item.sourceTitle && item.preparation.length);
  }
});
test('official links reject credentials, lookalike domains, modified paths and non-HTTPS schemes', () => {
  const url = listings[0].url;
  for (const unsafe of [url.replace('https:', 'http:'), url.replace('https://', 'https://user:pass@'), url + '?redirect=https://example.com', 'javascript:alert(1)', 'https://creditcard.ccb.com.example.com/']) {
    assert.equal(trustedSource(unsafe), false);
  }
});
test('search supports provider, fund code and English while keeping category boundaries', () => {
  assert.equal(findListings('finance', '000009')[0].id, 'efund-000009');
  assert.equal(findListings('installments', ' 招商 ').length, 1);
  assert.equal(findListings('insurance', 'ping an')[0].id, 'pingan-insurance');
  assert.equal(findListings('insurance', '000009').length, 0);
  assert.equal(findListings('finance', '不存在的机构').length, 0);
});
