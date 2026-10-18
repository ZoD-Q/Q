import assert from 'node:assert/strict';
import test from 'node:test';
import { AD_DISCOUNT_PERCENT, MAX_ADS, quoteVideo } from './pricing.ts';
import { brands, popularBrandIds } from './data/brands.ts';

test('catalog contains exactly 1000 uniquely named brands with traceable sources', () => {
  assert.equal(brands.length, 1000);
  assert.equal(new Set(brands.map(brand => brand.id)).size, 1000);
  assert.equal(new Set(brands.map(brand => brand.name.toLocaleLowerCase('en'))).size, 1000);
  assert.ok(brands.every(brand => brand.id && brand.name && /^https:\/\//.test(brand.source)));
  assert.equal(brands.filter(brand => brand.aliases?.some(alias => /[\u3400-\u9fff]/.test(alias))).length, 20);
  const initials = new Set(brands.map(brand => brand.name[0].toUpperCase()));
  assert.ok(['A', 'G', 'M', 'S', 'Z'].every(letter => initials.has(letter)));
});

test('popular choices are real catalog IDs and familiar brands come first', () => {
  const ids = new Set(brands.map(brand => brand.id));
  assert.equal(new Set(popularBrandIds).size, popularBrandIds.length);
  assert.ok(popularBrandIds.every(id => ids.has(id)));
  assert.deepEqual(brands.slice(0, 9).map(brand => brand.name), [
    'Apple', 'Nike', 'Adidas', 'Sony', 'Samsung', 'Spotify', 'Xiaomi', 'Huawei', 'Tesla',
  ]);
  for (const name of ['HTML5', 'JavaScript', 'JSON', 'PWA', 'Contactless Payment', 'UKCA', 'OnlyFans']) {
    assert.ok(!brands.some(brand => brand.name === name));
  }
});

test('zero brands leave the base price unchanged', () => {
  assert.equal(MAX_ADS, 10);
  assert.equal(AD_DISCOUNT_PERCENT, 5);
  assert.deepEqual(quoteVideo(2000, []), {
    baseMinor: 2000, selectedCount: 0, discountPercent: 0, savingsMinor: 0, totalMinor: 2000,
  });
});

test('one brand gives exactly 5 percent off', () => {
  assert.deepEqual(quoteVideo(2000, ['apple']), {
    baseMinor: 2000, selectedCount: 1, discountPercent: 5, savingsMinor: 100, totalMinor: 1900,
  });
});

test('ten brands reach the 50 percent cap', () => {
  const ids = Array.from({ length: 10 }, (_, index) => `test-${index}`);
  assert.deepEqual(quoteVideo(2000, ids), {
    baseMinor: 2000, selectedCount: 10, discountPercent: 50, savingsMinor: 1000, totalMinor: 1000,
  });
});

test('an eleventh distinct brand is rejected rather than silently capped', () => {
  assert.throws(() => quoteVideo(2000, Array.from({ length: 11 }, (_, index) => `test-${index}`)), RangeError);
});

test('duplicate IDs count only once, including more than ten array entries', () => {
  assert.deepEqual(quoteVideo(2000, ['apple', 'apple']), quoteVideo(2000, ['apple']));
  assert.equal(quoteVideo(2000, Array(20).fill('apple')).selectedCount, 1);
});

test('negative, fractional, infinite and unsafe base amounts are rejected', () => {
  for (const amount of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '2000', null]) {
    assert.throws(() => quoteVideo(amount, []), RangeError);
  }
  assert.equal(quoteVideo(0, ['apple']).totalMinor, 0);
});

test('savings round down to minor units without floating-point overflow', () => {
  assert.equal(quoteVideo(1999, ['apple']).savingsMinor, 99);
  const quote = quoteVideo(Number.MAX_SAFE_INTEGER, ['apple']);
  assert.equal(quote.savingsMinor, Number(BigInt(Number.MAX_SAFE_INTEGER) * 5n / 100n));
  assert.equal(quote.totalMinor + quote.savingsMinor, quote.baseMinor);
});

test('malformed brand IDs are rejected and the input array is not modified', () => {
  for (const ids of [null, 'apple', [''], ['   '], [42], [null]]) {
    assert.throws(() => quoteVideo(2000, ids), TypeError);
  }
  const ids = ['apple', 'apple', 'nike'];
  quoteVideo(2000, ids);
  assert.deepEqual(ids, ['apple', 'apple', 'nike']);
});
