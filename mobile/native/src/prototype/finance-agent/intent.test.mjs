import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { respondToFinanceText } = await import('./intent.ts');
const { appendLocalFinanceTurn } = await import('./conversation.ts');
test.after(() => hooks.deregister());

test('explicit chat calculations use the same money engine and reject decimal truncation', () => {
  const answer = respondToFinanceText('分期 CNY 8000 12 240', 'zh');
  assert.equal(answer.result.kind, 'installments');
  assert.equal(answer.result.totalRepaymentMinor, 824000);
  assert.equal(answer.result.payments.reduce((sum, row) => sum + row.amountMinor, 0), 824000);
  assert.equal(respondToFinanceText('帮我算8000元分12期，手续费240元', 'zh').result.totalRepaymentMinor, 824000);
  assert.equal(respondToFinanceText('分期 HKD 8000.001 12 240', 'zh').result, undefined);
  assert.equal(respondToFinanceText('分期 CNY 8000 12.5 240', 'zh').result, undefined);
});
test('bill chat requires explicit currency and never silently combines invalid rows', () => {
  assert.equal(respondToFinanceText('收入 工资 12000\n支出 房租 3000', 'zh').result, undefined);
  const valid = respondToFinanceText('账单 HKD\n收入 工资 12000\n支出 房租 3000', 'zh');
  assert.equal(valid.result.netMinor, 900000);
  assert.equal(valid.result.currency, 'HKD');
  assert.equal(respondToFinanceText('账单 HKD\n收入 工资 12000\n支出 房租 USD3000', 'zh').result, undefined);
});
test('savings is no-return arithmetic and knowledge has an actual source', () => {
  const saving = respondToFinanceText('savings CNY 50000 10000 2000', 'en');
  assert.equal(saving.result.monthsToTarget, 20);
  const knowledge = respondToFinanceText('什么是实际年利率 APR？', 'zh');
  assert.equal(knowledge.result.kind, 'knowledge');
  assert.ok(knowledge.result.entry.sources[0].url.startsWith('https://'));
  assert.equal(respondToFinanceText('hello', 'en'), null);
});
test('local financial turns cannot reuse cloud IDs and remain explicitly private', () => {
  let id = 0; const next = () => `local-${++id}`;
  const turn = { prompt: '账单', answer: '本地结果' };
  const conversation = appendLocalFinanceTurn(null, turn, next);
  assert.equal(conversation.localOnly, true);
  assert.ok(conversation.messages.every(message => message.localFinance));
  const continued = appendLocalFinanceTurn(conversation, turn, next);
  assert.equal(continued.id, conversation.id);
  assert.equal(continued.messages.length, 4);
  assert.throws(() => appendLocalFinanceTurn({ id: 'cloud', title: 'Cloud', messages: [] }, turn, next), /LOCAL_FINANCE_PRIVATE/);
});
