import { bankIdForPlugin, record, type JsonObject, type PluginInvocation } from './core';
import { decodeBankEntry } from '../banking/data';
import { formatHKD } from '../banking/core';
import { getBank } from '../banking/catalog';

type Translate = (zh: string, en: string) => string;
/** Exclude transport-shaped payloads from the conversational result surface. */
export function isConversationalText(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^```(?:json)?\s*[\[{]/i.test(trimmed) || /^(?:https?:\/\/|urn:|ui:\/\/|\{\s*"jsonrpc")/i.test(trimmed)) return false;
  try { const parsed: unknown = JSON.parse(trimmed); return !Array.isArray(parsed) && !record(parsed); } catch { return true; }
}
export const visibleValue = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const label = (key: string, schema: unknown, text: Translate): string => record(schema) && typeof schema.title === 'string' && schema.title.trim()
  ? visibleValue(schema.title) : visibleValue(key).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2') || text('内容', 'Content');
/** Display the full saved arguments as nested labelled values, never editable JSON. */
export function argumentRows(args: JsonObject, schema: JsonObject | null | undefined, text: Translate): { label: string; value: string }[] {
  const properties = schema && record(schema.properties) ? schema.properties : {};
  const describe = (value: unknown, field: unknown, depth = 0): string => {
    if (value === null) return text('空值', 'Null');
    if (value === '') return text('空文本', 'Empty text');
    if (typeof value === 'boolean') return value ? text('是', 'Yes') : text('否', 'No');
    if (Array.isArray(value)) return value.length ? value.map((item, index) => `${index + 1}. ${describe(item, record(field) ? field.items : undefined, depth + 1)}`).join('\n') : text('无', 'None');
    if (record(value)) {
      const nested = record(field) && record(field.properties) ? field.properties : {};
      return Object.entries(value).map(([key, item]) => `${'  '.repeat(depth)}${label(key, nested[key], text)}: ${describe(item, nested[key], depth + 1)}`).join('\n') || text('无', 'None');
    }
    return visibleValue(String(value));
  };
  return Object.entries(args).map(([key, value]) => ({ label: label(key, properties[key], text), value: describe(value, properties[key]) }));
}

export function invocationActionTitle(invocation: PluginInvocation, text: Translate) {
  return (invocation.tool_title?.trim() ? visibleValue(invocation.tool_title) : '') || text('确认这项操作', 'Confirm this action');
}
export function resolvedInvocation(invocation: PluginInvocation) {
  return ['succeeded', 'tool_error'].includes(invocation.status) && invocation.result != null;
}
export function bankReadPresentation(invocation: PluginInvocation, text: Translate): { title: string; lines: string[] } | null {
  const bankId = bankIdForPlugin(invocation);
  if (!bankId || invocation.status !== 'succeeded' || !record(invocation.result) || invocation.result.isError === true || !record(invocation.result.structuredContent)) return null;
  const result = invocation.result.structuredContent;
  if (result.mode !== 'demo' || result.currency !== 'HKD' || result.bank_id !== bankId) return null;
  const bank = getBank(bankId), bankName = text(bank.zh, bank.en);
  if (invocation.tool_name === 'bank_balance' && result.kind === 'bank_balance' && Number.isSafeInteger(result.balance_minor) && Number(result.balance_minor) >= 0) {
    return { title: text(`${bankName}余额`, `${bankName} balance`), lines: [formatHKD(Number(result.balance_minor))] };
  }
  if (invocation.tool_name === 'bank_transactions' && result.kind === 'bank_transactions' && Array.isArray(result.items) && result.items.length <= 100) {
    try {
      const items = result.items.map(decodeBankEntry);
      if (items.some(item => item.bank_id !== bankId)) return null;
      return { title: text(`${bankName}交易记录`, `${bankName} transactions`), lines: items.length ? items.map(item => `${item.created_at.slice(0, 10)}  ${item.direction === 'in' ? '+' : '−'}${formatHKD(item.amount_minor)}${item.memo ? ` · ${item.memo}` : ''}`) : [text('暂无交易记录', 'No transactions yet')] };
    } catch { return null; }
  }
  return null;
}
