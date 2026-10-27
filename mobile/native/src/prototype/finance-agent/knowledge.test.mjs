import assert from 'node:assert/strict';
import test from 'node:test';
import { FINANCE_KNOWLEDGE, getFinanceKnowledge, searchFinanceKnowledge } from './knowledge.ts';

test('eight bilingual knowledge topics have stable identities, official sources and a checked date', () => {
  assert.equal(FINANCE_KNOWLEDGE.length, 8);
  assert.equal(new Set(FINANCE_KNOWLEDGE.map((entry) => entry.id)).size, 8);
  for (const entry of FINANCE_KNOWLEDGE) {
    for (const field of ['title', 'summary', 'detail']) {
      assert.ok(entry[field].zh.trim());
      assert.ok(entry[field].en.trim());
    }
    assert.equal(entry.checkedAt, '2026-10-27');
    assert.ok(entry.sources.length > 0);
    for (const source of entry.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(['www.hkma.gov.hk', 'www.ifec.org.hk', 'www.ia.org.hk', 'www.consumer.org.hk'].includes(url.hostname));
      assert.ok(source.title.zh && source.title.en);
      assert.equal(url.username, '');
      assert.equal(url.password, '');
    }
  }
});

test('knowledge lookup and search work across both languages without live data', () => {
  assert.equal(getFinanceKnowledge('apr')?.id, 'apr');
  assert.equal(getFinanceKnowledge('missing'), undefined);
  assert.equal(searchFinanceKnowledge('复利')[0].id, 'compound-interest');
  assert.equal(searchFinanceKnowledge('  DEDUCTIBLE  ')[0].id, 'deductibles');
  assert.ok(searchFinanceKnowledge('monthly contribution').some((entry) => entry.id === 'savings-goals'));
  assert.deepEqual(searchFinanceKnowledge('an-unrelated-product-name'), []);
  assert.equal(searchFinanceKnowledge(' ').length, 8);
  assert.notEqual(searchFinanceKnowledge(' '), FINANCE_KNOWLEDGE);
});

test('educational result is serializable and distinguishes estimates from quotes and balances', () => {
  const result = { kind: 'knowledge', entry: getFinanceKnowledge('apr') };
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.match(getFinanceKnowledge('apr').detail.en, /not a lender quote/);
  assert.match(getFinanceKnowledge('savings-goals').detail.en, /predicts no returns/);
  assert.match(getFinanceKnowledge('cash-flow').summary.en, /not an account balance/);
  assert.match(getFinanceKnowledge('early-repayment').detail.en, /does not calculate/);
});
