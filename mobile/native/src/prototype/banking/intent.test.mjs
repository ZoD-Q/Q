import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const resolver = registerHooks({resolve(specifier,context,next) { if(context.parentURL?.includes('/prototype/banking/') && specifier.startsWith('./') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`,context); return next(specifier,context); }});
const {BANKS} = await import('./catalog.ts');
const {parseBankIntent} = await import('./intent.ts');
test('Chinese, traditional Chinese and English proposals identify source, target, amount and owner', () => {
  const expected = { kind: 'transfer', fromBankId: 'hsbc', toBankId: 'bochk', recipient: 'chen', amountMinor: 50_000 };
  for (const text of ['从汇丰转500港币到陈小明的中银账户', '從滙豐轉500港幣到陳小明的中銀帳戶', "Transfer HKD 500 from HSBC to Chen's BOCHK account", 'Send HK$500 from HSBC to Chen at Bank of China (Hong Kong)', '从汇丰转500到DEMO-0001的中银账户']) assert.deepEqual(parseBankIntent(text), expected, text);
  assert.deepEqual(parseBankIntent('从众安转200到我自己的恒生账户'), { kind: 'transfer', fromBankId: 'za', toBankId: 'hangseng', recipient: 'me', amountMinor: 20_000 });
  assert.deepEqual(parseBankIntent('Transfer 30.29 from Mox to my own livi account'), { kind: 'transfer', fromBankId: 'mox', toBankId: 'livi', recipient: 'me', amountMinor: 3029 });
  assert.equal(parseBankIntent('从汇丰转1,000.20到陈小明的中银账户').amountMinor, 100020);
});

test('all catalog banks can be explicitly addressed without merging similarly named banks', () => {
  for (const bank of BANKS) {
    const intent = parseBankIntent(`Transfer HKD 1 from ${bank.en} to Chen at HSBC Hong Kong`);
    assert.equal(intent.kind, 'transfer', bank.en);
    assert.equal(intent.fromBankId, bank.id, bank.en);
    assert.equal(intent.toBankId, 'hsbc', bank.en);
  }
  assert.equal(parseBankIntent('Transfer 1 from Citi to Chen at CITIC').toBankId, 'citic');
});

test('missing fields stay missing for explicit user clarification', () => {
  assert.deepEqual(parseBankIntent('转账'), { kind: 'transfer' });
  assert.deepEqual(parseBankIntent('从汇丰转500'), { kind: 'transfer', fromBankId: 'hsbc', amountMinor: 50_000 });
  assert.deepEqual(parseBankIntent('从汇丰转500到中银账户'), { kind: 'transfer', fromBankId: 'hsbc', toBankId: 'bochk', amountMinor: 50_000 });
  assert.deepEqual(parseBankIntent('转500到陈小明的中银账户'), { kind: 'transfer', toBankId: 'bochk', recipient: 'chen', amountMinor: 50_000 });
});

test('unsafe, ambiguous and unsupported requests never become partially parsed transfers', () => {
  const requests = [
    '从汇丰转500美元到陈小明的中银账户', '从汇丰转500人民币到陈小明的中银账户',
    '明天从汇丰转500到陈小明的中银账户', 'Transfer 1 from HSBC to Chen at BOCHK next week',
    '从汇丰转-500到陈小明的中银账户', '从汇丰转0到陈小明的中银账户', '从汇丰转.5到陈小明的中银账户',
    '从汇丰转1.001到陈小明的中银账户', '从汇丰转1e3到陈小明的中银账户', '从汇丰转12,34到陈小明的中银账户',
    '从汇丰转5k到陈小明的中银账户', 'Transfer US$500 from HSBC to Chen at BOCHK', '从汇丰转50%到陈小明的中银账户',
    '从汇丰转1万到陈小明的中银账户', '从汇丰转五百到陈小明的中银账户',
    '从陈小明的汇丰转500到我的中银账户', '从汇丰的陈小明账户转500到我的中银账户', "Transfer 500 from Chen's HSBC to my BOCHK account",
    '从汇丰转500到王小明的中银账户', '从汇丰转500到陈小明和我自己的中银账户',
    '从汇丰和恒生转500到陈小明的中银账户', '从汇丰转500到陈小明的中银或渣打账户',
    '从汇丰转500到陈小明的中银账户再转200到恒生', 'Transfer 500 and 200 from HSBC to Chen at BOCHK',
    '从汇丰转500到手机号91234567', '从汇丰转500到账户号12345678',
    '从汇丰转500到Alice and Chen的中银账户', '不要从汇丰转500到陈小明的中银账户',
  ];
  for (const request of requests) assert.equal(parseBankIntent(request).kind, 'unsupported', request);
});

test('memo stays display text and simple balance/history/help commands do not propose transfers', () => {
  assert.equal(parseBankIntent('从汇丰转500到陈小明的中银账户 备注：Team lunch').memo, 'Team lunch');
  assert.deepEqual(parseBankIntent('看看我的银行余额'), { kind: 'balances' });
  assert.deepEqual(parseBankIntent('show receipts'), { kind: 'history' });
  assert.deepEqual(parseBankIntent('how does this work?'), { kind: 'help' });
});

test('unconsumed currencies, negations and scheduling prefixes fail closed', () => {
  const transfer = '从汇丰转500港币到陈小明的中银账户';
  for (const prefix of ['今晚', '定期', '下个月', '每年', '别', '暂时不', '禁止', '如果余额够就', '以后', '请先不要']) assert.equal(parseBankIntent(prefix + transfer).kind, 'unsupported', prefix);
  for (const currency of ['CAD', 'CHF', 'NZD', 'THB', 'KRW', 'XXX']) {
    assert.equal(parseBankIntent(`Transfer ${currency} 500 from HSBC to Chen at BOCHK`).kind, 'unsupported', currency);
    assert.equal(parseBankIntent(`${currency} 500 transfer from HSBC to Chen at BOCHK`).kind, 'unsupported', currency);
  }
  for (const request of [
    'tonight transfer 500 from HSBC to Chen at BOCHK',
    'Transfer annually 500 from HSBC to Chen at BOCHK',
    'Transfer 500 conditionally from HSBC to Chen at BOCHK',
    'Transfer 500 from HSBC to Chen at BOCHK every year',
    '从汇丰转500港币到陈小明的中银账户，今晚',
    '从汇丰定期转500港币到陈小明的中银账户',
  ]) assert.equal(parseBankIntent(request).kind, 'unsupported', request);
  assert.equal(parseBankIntent('请' + transfer).kind, 'transfer');
  assert.equal(parseBankIntent('帮我' + transfer).kind, 'transfer');
  assert.equal(parseBankIntent('Please transfer HKD 500 from HSBC to Chen at BOCHK').kind, 'transfer');
});

test('transfer history queries are read-only and mixed query/action text cannot propose a transfer', () => {
  for (const request of ['看看转账记录', '查看我的转账历史', '請查看轉賬紀錄', 'Show transfer history', 'Please show my transfer receipts', 'transfer history']) assert.deepEqual(parseBankIntent(request), { kind: 'history' }, request);
  for (const request of ['看看转账记录然后从汇丰转500到陈小明的中银账户', 'Show transfer history and transfer 500 from HSBC to Chen at BOCHK']) assert.equal(parseBankIntent(request).kind, 'unsupported', request);
});

test('memo is split before interpreting negations, currencies, action counts or amounts', () => {
  const base = '从汇丰转500港币到陈小明的中银账户';
  const expected = parseBankIntent(base);
  for (const memo of ['第二次转账', '不要迟到', 'CAD 500', '明天上午10:00见', '再转200是备注文字', '禁止修改此备注']) assert.deepEqual(parseBankIntent(`${base} 备注：${memo}`), { ...expected, memo });
  assert.deepEqual(parseBankIntent('Transfer HKD 500 from HSBC to Chen at BOCHK memo: Do not be late. Transfer #2 tomorrow.'), { ...expected, memo: 'Do not be late. Transfer #2 tomorrow.' });
  assert.equal(parseBankIntent(`今晚${base} 备注：现在执行`).kind, 'unsupported');
});


test.after(() => resolver.deregister());

test('an explicit third-party source is never replaced by the selected own-bank default',()=>{
 for(const text of ['从陈小明转500到我自己的中银账户',"Transfer 500 from Chen's account to my BOCHK account",'从DEMO-0001转500到我自己的中银账户'])assert.equal(parseBankIntent(text).kind,'unsupported',text);
 assert.deepEqual(parseBankIntent('从我的账户转500到陈小明的中银账户'),{kind:'transfer',toBankId:'bochk',recipient:'chen',amountMinor:50000});
});
