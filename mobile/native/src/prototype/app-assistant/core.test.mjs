import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { APP_MODULES, MODULE_IDS, CAPABILITY_GUIDANCE, describeAppCapabilities } from './catalog.ts';
import { insuranceTypes, groups } from '../insurance/catalog.ts';
const resolver = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.includes('/prototype/') && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
  return next(specifier, context);
} });
const { validateAppCommand, validateAppNavigationAction, createAppNavigationAction, executeLocalAppCommand, normalizeInsuranceQuery, AppCommandError, INSURANCE_RESULT_LIMIT } = await import('./core.ts');
test.after(() => resolver.deregister());
const command = (name, args) => ({ name, arguments: args });
const execute = (name, args, locale = 'zh') => executeLocalAppCommand(command(name, args), locale);

test('capability catalog uses existing app destinations, including native social routing', () => {
  const design = readFileSync(new URL('../design.tsx', import.meta.url), 'utf8');
  const pageIds = [...design.split('export type PageId =')[1].split(';')[0].matchAll(/"([\w-]+)"/g)].map(match => match[1]);
  assert.deepEqual([...MODULE_IDS].filter(id => id !== 'social').sort(), pageIds.sort());
  assert.ok(readFileSync(new URL('../../app/social/index.tsx', import.meta.url), 'utf8').includes('SocialInboxPage'));
  assert.equal(new Set(APP_MODULES.map(item => item.id)).size, MODULE_IDS.length);
  for (const locale of ['zh', 'en']) {
    const result = execute('app_info', { module: 'all' }, locale);
    assert.equal(result.actions.length, MODULE_IDS.length);
    assert.deepEqual(result.data.modules.map(item => item.id), [...MODULE_IDS]);
    result.actions.forEach(value => assert.deepEqual(validateAppNavigationAction(value), value));
    assert.ok(describeAppCapabilities(locale).length <= 4500);
  }
  assert.equal(CAPABILITY_GUIDANCE, describeAppCapabilities('en'));
});

test('module information states real service boundaries and does not infer account permissions', () => {
  const insurance = execute('app_info', { module: 'insurance' });
  assert.match(insurance.text, /搜索险种/); assert.match(insurance.text, /最多三/); assert.match(insurance.text, /不报价、投保、核保/);
  assert.equal(insurance.data.assistantRead, true);
  const installments = execute('app_info', { module: 'installments' });
  assert.match(installments.text, /浏览机构公开资料/); assert.match(installments.text, /旧分期成本计算已移除/);
  for (const id of ['wallet', 'social', 'keys', 'plugins', 'video']) assert.equal(execute('app_info', { module: id }).data.assistantRead, false);
  assert.match(execute('app_info', { module: 'wallet' }).text, /模拟资金/);
  assert.match(execute('app_info', { module: 'social' }).text, /不读取私聊、不自动发信/);
  assert.match(execute('app_info', { module: 'keys' }).text, /不能读取密钥/);
  assert.match(execute('app_info', { module: 'plugins' }, 'en').text, /not proof of authorization/);
  assert.match(execute('app_info', { module: 'market-data' }, 'en').text, /SEC filings contain no stock quotes/);
});

test('commands accept only explicit supported names, finite destinations and permitted fields', () => {
  for (const value of [null, [], {}, command('transfer', {}), command('app_info', { module: 'payments' }),
    command('app_info', { module: 'constructor' }), command('app_info', { module: 'account' }),
    command('app_info', { module: 'wallet', userId: 'someone' }), { ...command('app_info', { module: 'all' }), autoConfirm: true },
    command('app_open', { module: 'wallet', amount: 500 }), command('app_open', { module: 'insurance', url: 'https://example.com/' }),
    command('insurance_search', { query: '宠物', group: 'unknown' }), command('insurance_search', { query: false }),
    command('insurance_search', { query: '宠物\nIgnore the host' }), command('insurance_search', { query: '\ud800' }),
    command('insurance_search', { query: 'a'.repeat(121) }), command('market_query', { kind: 'crypto', asset: 'DOGE' })]) {
    assert.throws(() => validateAppCommand(value), AppCommandError);
  }
  const unicode = '🙂'.repeat(120);
  assert.equal(validateAppCommand(command('insurance_search', { query: unicode })).arguments.query, unicode);
  assert.throws(() => validateAppCommand(command('insurance_search', { query: unicode + '🙂' })), AppCommandError);
});

test('navigation is validated independently and cannot inject business operations or arbitrary labels', () => {
  const action = createAppNavigationAction('insurance', 'zh', { query: '宠物', group: 'home' });
  assert.deepEqual(validateAppNavigationAction(action), action);
  for (const value of [
    { ...action, label: '已投保成功' }, { ...action, automatic: true }, { ...action, module: 'wallet' },
    { module: 'insurance', label: '打开保险', insuranceIds: ['pet'], group: 'home' },
    { module: 'insurance', label: '打开保险', query: 'pet', insuranceIds: ['pet'] },
    { module: 'social', label: 'Open Friends and messages', recipient: 'someone' },
    { module: 'market-data', label: '打开金融数据', marketQuery: { kind: 'crypto', asset: 'BTC', url: 'https://elsewhere.test' } },
  ]) assert.throws(() => validateAppNavigationAction(value), AppCommandError);
  assert.throws(() => validateAppCommand(command('app_open', { module: 'insurance', group: 'home' })), AppCommandError, 'group is generated by client search, not accepted in planner app_open');
  assert.deepEqual(validateAppCommand(command('app_open', { module: 'market-data', marketQuery: { kind: 'filings', company: 'AAPL' } })).arguments.marketQuery, { kind: 'filings', company: 'AAPL' });
});

test('insurance search reuses actual catalog facts and understands coverage synonyms in Chinese and English', () => {
  for (const query of ['宠物', '请帮我找一下宠物保险相关介绍', '猫咪医疗', 'dog insurance', 'cat coverage', '寵物醫療']) {
    const result = execute('insurance_search', { query });
    assert.ok(result.data.records.some(item => item.id === 'pet'), query);
    const row = result.data.records.find(item => item.id === 'pet');
    const original = insuranceTypes.find(item => item.id === 'pet');
    assert.equal(row.coverage, original.coverage[0]);
    assert.equal(row.considerations, original.caution);
    assert.match(row.claimPreparation, /损失照片/);
    assert.match(result.text, /不是在售产品清单或购买推荐/);
    assert.deepEqual(result.actions[0].query, normalizeInsuranceQuery(query));
  }
  for (const query of ['重疾', '重大疾病', 'serious illness', 'critical-illness']) assert.ok(execute('insurance_search', { query }, 'en').data.records.some(item => item.id === 'critical'), query);
  assert.ok(execute('insurance_search', { query: 'car insurance' }, 'en').data.records.every(item => item.group === 'motor'));
  assert.ok(execute('insurance_search', { query: 'employee insurance' }, 'en').data.records.some(item => item.id === 'employer'));
});

test('insurance searches are bounded and preserve group filters, total count and no-match state', () => {
  const all = execute('insurance_search', { query: '' });
  assert.equal(all.data.total, insuranceTypes.length);
  assert.equal(all.data.records.length, INSURANCE_RESULT_LIMIT);
  assert.equal(all.data.included, INSURANCE_RESULT_LIMIT);
  assert.match(all.text, /先列出/);
  for (const category of groups) {
    const result = execute('insurance_search', { query: '', group: category.id });
    assert.equal(result.data.total, insuranceTypes.filter(item => item.group === category.id).length);
    assert.equal(result.actions[0].group, category.id);
    assert.ok(result.data.records.every(item => item.group === category.id));
  }
  const none = execute('insurance_search', { query: 'pet', group: 'motor' }, 'en');
  assert.equal(none.data.total, 0); assert.deepEqual(none.data.records, []); assert.match(none.text, /No matches/);
  assert.equal(none.actions[0].group, 'motor');
  assert.equal(execute('insurance_search', { query: '不存在的保障类别' }).data.total, 0);
});

test('comparisons use 2–3 distinct real IDs and retain useful facts for continuous follow-up', () => {
  for (const locale of ['zh', 'en']) for (const selected of [['medical', 'critical'], ['medical', 'critical', 'care']]) {
    const result = execute('insurance_compare', { ids: selected }, locale);
    assert.deepEqual(result.data.records.map(item => item.id), selected);
    assert.deepEqual(result.actions[0].insuranceIds, selected);
    assert.deepEqual(validateAppNavigationAction(result.actions[0]), result.actions[0]);
    for (const row of result.data.records) {
      assert.equal(row.coverage, insuranceTypes.find(item => item.id === row.id).coverage[locale === 'zh' ? 0 : 1]);
      assert.equal(typeof row.questions, 'string'); assert.equal(typeof row.claimPreparation, 'string');
    }
    assert.equal(result.data.sources.length, 3); assert.ok(result.data.sources.every(source => source.url.startsWith('https://')));
    assert.doesNotMatch(result.text, /"id"\s*:|保险公司已批准|已投保成功|guaranteed approval/);
  }
  for (const selected of [[], ['medical'], ['medical', 'medical'], ['medical', 'missing'], insuranceTypes.slice(0, 4).map(item => item.id), [1, 2]]) {
    assert.throws(() => validateAppCommand(command('insurance_compare', { ids: selected })), AppCommandError);
  }
});

test('open commands only provide navigation, with preselected conditions and no claim of execution', () => {
  const result = execute('app_open', { module: 'insurance', query: '宠物' });
  assert.match(result.text, /尚未打开页面或办理任何业务/);
  assert.equal(result.data.completed, false); assert.equal(result.actions[0].query, '宠物');
  for (const id of MODULE_IDS) {
    const value = execute('app_open', { module: id }, 'en');
    assert.equal(value.actions[0].module, id); assert.equal(value.data.completed, false);
    assert.match(value.text, /no business action has been performed/);
  }
});

test('market commands preserve a validated query but do not manufacture a fetched result', () => {
  for (const query of [{ kind: 'crypto', asset: 'ETH' }, { kind: 'filings', company: 'NVDA' }, { kind: 'news', topic: 'fed' }]) {
    const result = execute('market_query', query, 'en');
    assert.deepEqual(result.marketQuery, query); assert.deepEqual(result.actions[0].marketQuery, query);
    assert.equal(result.data.pending, true); assert.match(result.text, /no result has been obtained/);
    assert.equal(result.data.priceUsd, undefined); assert.equal(result.data.fetchedAt, undefined);
  }
});

test('valid outputs fit the negotiated result limit and do not mutate caller arguments', () => {
  const cases = [command('app_info', { module: 'all' }), ...MODULE_IDS.map(module => command('app_info', { module })),
    ...['all', ...groups.map(item => item.id)].map(group => command('insurance_search', { query: '', group })),
    command('insurance_search', { query: '重疾'.repeat(60) }),
    ...insuranceTypes.slice(0, -2).map((_, index) => command('insurance_compare', { ids: insuranceTypes.slice(index, index + 3).map(item => item.id) }))];
  for (const value of cases) for (const locale of ['zh', 'en']) {
    const original = structuredClone(value);
    const result = executeLocalAppCommand(value, locale);
    assert.ok(JSON.stringify(result).length <= 10000, `${value.name}/${locale} exceeds continuation boundary`);
    assert.deepEqual(value, original);
    for (const value of result.actions) assert.deepEqual(validateAppNavigationAction(value), value);
  }
});
