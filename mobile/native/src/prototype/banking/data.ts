import { WorkbenchError } from '../api-workbench/core';
import { BANKS } from './catalog';
import type { BankAccount as ApiBankAccount, BankWallet as ApiBankWallet, BankTransferReceipt, BankEntry as ApiBankEntry } from '@xiaoq/shared';
export type BankAccount = ApiBankAccount;
export type BankWallet = ApiBankWallet;
export type BankReceipt = BankTransferReceipt;
export type BankEntry = ApiBankEntry;
export type BankPage<T> = { items: T[]; next_cursor: string | null };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const minor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const short = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max;
const bank = (value: unknown): value is string => typeof value === 'string' && BANKS.some(b => b.id === value);
const date = (value: unknown): value is string => short(value, 64) && Number.isFinite(Date.parse(value));
const fail = (): never => { throw new WorkbenchError('INVALID_RESPONSE'); };
export function decodeBankWallet(value: unknown): BankWallet {
  if (!record(value) || value.mode !== 'demo' || value.currency !== 'HKD' || !Array.isArray(value.accounts) || value.accounts.length > 20 || !minor(value.total_balance_minor) || !Array.isArray(value.recipients) || value.recipients.length > 1) return fail();
  const accounts = value.accounts.map(a => {
    if (!record(a) || !uuid(a.id) || !bank(a.bank_id) || !short(a.bank_name) || !short(a.bank_name_en) || !minor(a.balance_minor) || !short(a.masked_number, 64) || !a.masked_number.startsWith('DEMO') || !(a.connection_id === null || uuid(a.connection_id))) return fail();
    return a as BankAccount;
  });
  if (new Set(accounts.map(a => a.bank_id)).size !== accounts.length || new Set(accounts.map(a => a.id)).size !== accounts.length || accounts.reduce((sum, a) => sum + a.balance_minor, 0) !== value.total_balance_minor) return fail();
  const recipients = value.recipients.map(r => {
    if (!record(r) || r.id !== 'demo_chen' || !short(r.display_name) || r.demo !== true) return fail();
    return r as BankWallet['recipients'][number];
  });
  return { mode: 'demo', currency: 'HKD', accounts, total_balance_minor: value.total_balance_minor, recipients };
}
export function decodeBankReceipt(value: unknown): BankReceipt {
  if (!record(value) || !uuid(value.id) || !bank(value.source_bank_id) || !bank(value.destination_bank_id) || !['self', 'demo_chen'].includes(String(value.recipient)) || !minor(value.amount_minor) || value.amount_minor <= 0 || value.currency !== 'HKD' || value.mode !== 'demo' || !minor(value.source_balance_minor) || !(value.destination_balance_minor === null || minor(value.destination_balance_minor)) || (value.recipient === 'demo_chen' && value.destination_balance_minor !== null) || (value.recipient === 'self' && !minor(value.destination_balance_minor)) || !short(value.memo, 480) || !date(value.created_at)) return fail();
  return value as BankReceipt;
}
export function decodeBankEntry(value: unknown): BankEntry {
  if (!record(value) || !uuid(value.id) || !uuid(value.transaction_id) || !bank(value.bank_id) || !['initial', 'transfer'].includes(String(value.kind)) || !['in', 'out'].includes(String(value.direction)) || !minor(value.amount_minor) || !value.amount_minor || !minor(value.balance_after_minor) || value.currency !== 'HKD' || value.mode !== 'demo' || !short(value.memo, 480) || !date(value.created_at) || !(value.source_bank_id === null || bank(value.source_bank_id)) || !(value.destination_bank_id === null || bank(value.destination_bank_id)) || !(value.recipient === null || ['self', 'demo_chen'].includes(String(value.recipient)))) return fail();
  return value as BankEntry;
}
export function decodeBankPage<T>(decoder: (value: unknown) => T) {
  return (value: unknown): BankPage<T> => {
    if (!record(value) || !Array.isArray(value.items) || value.items.length > 100 || !(value.next_cursor === null || short(value.next_cursor, 512))) return fail();
    return { items: value.items.map(decoder), next_cursor: value.next_cursor };
  };
}
