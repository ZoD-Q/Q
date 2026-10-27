import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { respondToFinanceText } = await import('./intent.ts');
const { appendLocalFinanceTurn, financialAiTitle, isFinancialAiConversation } = await import('./conversation.ts');
test.after(() => hooks.deregister());

test('retired installment and savings commands stay local without creating new calculations', () => {
  for (const prompt of [
    '分期 CNY 8000 12 240', '帮我算8000元分12期，手续费240元',
    '分期 HKD 8000.001 12 240', '分期 CNY 8000 12.5 240',
    '储蓄 CNY 50000 10000 2000', '帮我设一个储蓄目标', '整理账单',
    '分期 CNY 8000 12 240，实际年利率是多少？',
    '借款8000元，共12期，总费用240元', '还款计划：本金8000，总费用240，每月还款',
    '本金8000，总手续费240，帮我看一下',
  ]) {
    const turn = respondToFinanceText(prompt, 'zh');
    assert.equal(turn.prompt, prompt);
    assert.equal(turn.result, undefined);
    assert.match(turn.answer, /当前不再处理/);
    assert.match(turn.answer, /没有上传/);
    assert.doesNotMatch(turn.answer, /打开“财务工具”/);
  }
  const saving = respondToFinanceText('savings CNY 50000 10000 2000', 'en');
  assert.equal(saving.result, undefined);
  assert.match(saving.answer, /no longer processed/);
  assert.match(saving.answer, /Nothing was uploaded/);
});
test('bill records and mixed knowledge requests cannot fall through to cloud routing', () => {
  for (const prompt of [
    '收入 工资 12000\n支出 房租 3000',
    '账单 HKD\n收入 工资 12000\n支出 房租 3000',
    '账单 HKD\n收入 工资 12000\n支出 房租 USD3000',
    'income PRIVATE_SALARY 12000\nexpense Rent 3000\nWhat is APR?',
    '账单 CNY\n支出 餐饮 30\n解释一下复利',
  ]) {
    const turn = respondToFinanceText(prompt, 'zh');
    assert.ok(turn, prompt);
    assert.equal(turn.result, undefined);
    assert.match(turn.answer, /没有上传/);
  }
});
test('knowledge still has actual sources while market research is available to its own handler', () => {
  for (const prompt of ['什么是实际年利率 APR？', '什么是复利？', '储蓄知识是什么？', 'What is a savings goal?', '提前还款是什么？']) {
    const knowledge = respondToFinanceText(prompt, 'zh');
    assert.equal(knowledge.result.kind, 'knowledge');
    assert.ok(knowledge.result.entry.sources[0].url.startsWith('https://'));
  }
  assert.equal(respondToFinanceText('hello', 'en'), null);
  assert.equal(respondToFinanceText('查询美股最新市场新闻', 'zh'), null);
  assert.equal(respondToFinanceText('Show public cryptocurrency market data', 'en'), null);
});
test('oversized financial input fails closed even when the marker appears at the end', () => {
  for (const prompt of ['账单 CNY\n' + '💸'.repeat(13000), 'x'.repeat(24001) + ' expenses PRIVATE_VALUE 10', 'x'.repeat(24001) + ' 金融市场', '本金8000 ' + 'x'.repeat(24001)]) {
    const turn = respondToFinanceText(prompt, 'zh');
    assert.ok(turn);
    assert.equal(turn.result, undefined);
    assert.match(turn.answer, /没有上传/);
  }
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
test('market research titles retain guidance after reopening and preserve legacy title compatibility', () => {
  for (const title of [financialAiTitle('市场问题', 'zh'), financialAiTitle('Market question', 'en'), '财务问答 · 旧问题', 'Finance Q&A · Old question']) {
    const conversation = { id: 'cloud', title, messages: [] };
    assert.equal(isFinancialAiConversation(conversation), true);
    assert.equal(isFinancialAiConversation({ ...conversation, localOnly: true }), false);
    assert.equal(isFinancialAiConversation({ ...conversation, plugin: { id: 'plugin' } }), false);
  }
});

test('public market and company income questions remain research requests, while private rows stay local', () => {
  assert.equal(respondToFinanceText('苹果公司最新收入和现金流如何？', 'zh'), null);
  assert.equal(respondToFinanceText('What is NVDA net income?', 'en'), null);
  assert.equal(respondToFinanceText('最新加密货币新闻', 'zh'), null);
  assert.ok(respondToFinanceText('账单 CNY\n收入 工资 12000\n新闻说比特币上涨', 'zh'));
});
