import { BANKS } from './catalog';
import { parseAmount, type Owner } from './core';

export type BankIntent =
  | { kind: 'transfer'; fromBankId?: string; toBankId?: string; recipient?: Owner; amountMinor?: number; memo?: string }
  | { kind: 'balances' }
  | { kind: 'history' }
  | { kind: 'help' }
  | { kind: 'unsupported'; reason: string };

type Mention = { id: string; start: number; end: number };
const unsupported = (reason: string): BankIntent => ({ kind: 'unsupported', reason });
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(text: string): Mention[] {
  const all: Mention[] = [];
  for (const bank of BANKS) {
    for (const alias of [bank.zh, bank.en, ...bank.aliases]) {
      const pattern = new RegExp(/[a-z]/i.test(alias) ? `(?<![a-z])${escape(alias.toLowerCase())}(?![a-z])` : escape(alias), 'g');
      for (const match of text.matchAll(pattern)) all.push({ id: bank.id, start: match.index, end: match.index + match[0].length });
    }
  }
  return all.sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .filter((item, index, sorted) => !sorted.slice(0, index).some(other => item.start < other.end && item.end > other.start))
    .sort((a, b) => a.start - b.start);
}

function readOnlyIntent(command: string): 'balances' | 'history' | undefined {
  const zhPrefix = '(?:(?:请|請|帮我|幫我|看看|看一下|查看|查询|查詢|显示|顯示|我的|银行|銀行|全部|所有|最近|模拟|模擬|的)\\s*)*';
  const end = '[\\s。.!！?？]*$';
  if (new RegExp(`^${zhPrefix}(?:(?:转账|轉賬|交易)\\s*)?(?:记录|紀錄|历史|歷史|回执|回執)${end}`).test(command)
    || new RegExp(`^(?:(?:please|show|view|check|my|the|all|recent|demo|bank|transfer|transaction)\\s+)*(?:history|receipts?|records?)${end}`).test(command)) return 'history';
  if (new RegExp(`^${zhPrefix}(?:余额|餘額|结余|結餘)${end}`).test(command)
    || new RegExp(`^(?:(?:please|show|view|check|my|the|all|demo|bank|account)\\s+)*balances?${end}`).test(command)) return 'balances';
  return undefined;
}

/** Every non-data word must belong to the supported command grammar. */
function fullyConsumed(command: string, banks: Mention[]): boolean {
  let remaining = command;
  for (const bank of [...banks].reverse()) remaining = remaining.slice(0, bank.start) + ' '.repeat(bank.end - bank.start) + remaining.slice(bank.end);
  remaining = remaining
    .replace(/\bdemo-0001\b/g, ' ')
    .replace(/\d[\d,.]*(?:[eE][+-]?\d+)?/g, ' ')
    .replace(/陈小明|陳小明|\bchen(?:\s+xiaoming)?\b|我自己|自己|我的|本人|\bmy(?:self|\s+own)?\b|\bme\b/g, ' ')
    .replace(/转账|轉賬|转给|轉給|转入|轉入|转出|轉出|转|轉|汇款|匯款|从|從|到|给|給|请|請|帮我|幫我|麻烦|麻煩|的|银行|銀行|账户|帳戶|賬戶|户口|戶口|港币|港幣|港元|\b(?:transfer|send|from|to|please|bank|account|at|in|hkd|hk)\b|['’]s|[$\s，。！？!?]/g, '');
  return remaining === '';
}

/** Conservative local command parser. It creates proposals only, never executes a transfer. */
export function parseBankIntent(raw: string): BankIntent {
  const input = raw.trim();
  if (!input || input.length > 1000) return unsupported('EMPTY_OR_TOO_LONG');
  // Memo contents are display data; never interpret their words as transfer instructions.
  const memoMatch = /(?:备注|備註|附言|\bmemo\b)\s*[:：]?\s*([\s\S]*)$/i.exec(input);
  const text = (memoMatch ? input.slice(0, memoMatch.index).trim() : input).toLowerCase();
  if (!text) return unsupported('EMPTY_OR_TOO_LONG');
  const readOnly = readOnlyIntent(text);
  if (readOnly) return { kind: readOnly };
  if (/不要|别转|別轉|不转|不轉|取消|撤销|撤銷|\b(?:don['’]?t|do not|not|cancel|reverse)\b/.test(text)) return unsupported('NEGATED_OR_CANCELLED');
  const action = /转账|轉賬|转给|轉給|转入|轉入|转出|轉出|转|轉|汇款|匯款|\btransfer\b|\bsend\b/;
  if (!action.test(text)) {
    return { kind: 'help' };
  }
  if (/美元|美金|人民币|人民幣|欧元|歐元|日元|英镑|英鎊|澳元|澳币|澳幣|新币|新幣|\b(?:usd|cny|rmb|eur|jpy|gbp|aud|sgd|btc|usdt|dollars?|cents?)\b|us\s*\$|[¥￥€£₿]/.test(text)) return unsupported('CURRENCY_NOT_HKD');
  if (/明天|后天|後天|下周|下週|下月|定时|定時|预约|預約|每天|每周|每週|每月|\b(?:tomorrow|later|schedule|scheduled|daily|weekly|monthly|next)\b|\d{1,2}[:：]\d{2}|\d{1,2}[月日号號]/.test(text)) return unsupported('SCHEDULED_TRANSFER');
  if (/负|負|减去|減去|[−-]\s*\d|\bnegative\b/.test(text.replace(/demo-0001/g, ''))) return unsupported('INVALID_AMOUNT');
  if (/手机|手機|电话|電話|账号|賬號|帐号|戶口號|账户号|帳戶號|\b(?:phone|mobile|iban|account\s*(?:no|number))\b/.test(text) || /(?:\+\d[\d\s-]{7,}|\b\d{8,}\b)/.test(text)) return unsupported('REAL_ACCOUNT_UNSUPPORTED');
  if (/分别|分別|各转|各轉|再转|再轉|以及|和.*(?:转|轉)|\b(?:then|each|also)\b/.test(text) || (text.match(new RegExp(action.source, 'g')) ?? []).length > 1) return unsupported('MULTIPLE_TRANSFERS');
  const command = text;
  const found = mentions(command);
  if (found.length > 2) return unsupported('AMBIGUOUS_BANK');
  const fromMarker = /(?:从|從|\bfrom\b)/.exec(command);
  const toMarker = /(?:到|给|給|\bto\b)/.exec(command);
  const actionStart = action.exec(command)?.index ?? command.length;
  const prefix = command.slice(0, Math.min(fromMarker?.index ?? command.length, actionStart));
  if (!/^(?:(?:请|請|帮我|幫我|麻烦|麻煩|please)\s*)*$/.test(prefix)) return unsupported('UNSUPPORTED_COMMAND');
  const source = fromMarker ? found.filter(bank => bank.start >= fromMarker.index + fromMarker[0].length && (!toMarker || bank.start < toMarker.index)) : [];
  const destination = toMarker ? found.filter(bank => bank.start >= toMarker.index + toMarker[0].length) : [];
  if (source.length > 1 || destination.length > 1) return unsupported('AMBIGUOUS_BANK');
  if (found.some(bank => !source.includes(bank) && !destination.includes(bank))) return unsupported('AMBIGUOUS_BANK');
  if (fromMarker) {
    const sourceEnd = toMarker?.index ?? command.length;
    const sourceText = source[0]
      ? command.slice(fromMarker.index + fromMarker[0].length, source[0].start) + command.slice(source[0].end, sourceEnd)
      : command.slice(fromMarker.index + fromMarker[0].length, sourceEnd);
    const unrecognizedSource = sourceText.replace(/我的|我自己|自己|本人|\bmy(?:\s+own)?\b|(?:的|账户|帳戶|賬戶|户口|戶口|银行|銀行|港币|港幣|港元|转账|轉賬|转给|轉給|转|轉|汇款|匯款)|\b(?:bank|account|transfer|send|hkd|hk)\b|['’]s|[\d.,$\s]/g, '');
    if (unrecognizedSource) return unsupported('SOURCE_OWNER_UNSUPPORTED');
  }
  const recipientText = toMarker ? command.slice(toMarker.index + toMarker[0].length) : '';
  const chen = /陈小明|陳小明|\bchen(?:\s+xiaoming)?\b|\bdemo-0001\b/.test(recipientText);
  const me = /我自己|自己|我的|本人|\bmy(?:self|\s+own)?\b|\bme\b/.test(recipientText);
  if (chen && me) return unsupported('AMBIGUOUS_RECIPIENT');
  let remainder = recipientText;
  for (const bank of mentions(remainder).reverse()) remainder = remainder.slice(0, bank.start) + remainder.slice(bank.end);
  remainder = remainder.replace(/陈小明|陳小明|\bchen(?:\s+xiaoming)?\b|\bdemo-0001\b|我自己|自己|我的|本人|\bmy(?:self|\s+own)?\b|\bme\b|(?:的|银行|銀行|账户|帳戶|賬戶|户口|戶口|港币|港幣|港元)|\b(?:bank|account|hkd|hk|at|in)\b|['’]s|[\d.,$\s，。！？!?]/g, '');
  if (remainder) return unsupported('UNKNOWN_RECIPIENT');
  const amountText = command.replace(/demo-0001/g, '').match(/\d[\d,.]*(?:[eE][+-]?\d+)?/g) ?? [];
  if (/(?:^|[^\d])[.,+]\s*\d/.test(command)) return unsupported('INVALID_AMOUNT');
  if (/\d\s*(?:[km](?![a-z])|分|%|％|percent\b)/i.test(command)) return unsupported('INVALID_AMOUNT');
  if (amountText.length > 1) return unsupported('MULTIPLE_AMOUNTS');
  let amountMinor: number | undefined;
  try { if (amountText[0]) amountMinor = parseAmount(amountText[0]); } catch { return unsupported('INVALID_AMOUNT'); }
  if (/[零一二三四五六七八九十百千万萬亿億两兩]/.test(command.replace(/陈小明|陳小明/g, '').replace(/银行|銀行/g, ''))) return unsupported('USE_NUMERIC_AMOUNT');
  if (!fullyConsumed(command, found)) return unsupported('UNSUPPORTED_COMMAND');
  return { kind: 'transfer', ...(source[0] ? { fromBankId: source[0].id } : {}), ...(destination[0] ? { toBankId: destination[0].id } : {}), ...(chen ? { recipient: 'chen' as const } : me ? { recipient: 'me' as const } : {}), ...(amountMinor === undefined ? {} : { amountMinor }), ...(memoMatch ? { memo: memoMatch[1] } : {}) };
}
