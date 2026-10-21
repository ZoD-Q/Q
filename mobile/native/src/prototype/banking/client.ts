import { pluginRequest } from '../plugin-host/client';
import { WorkbenchError } from '../api-workbench/core';
import { decodeBankWallet, decodeBankReceipt, decodeBankPage, decodeBankEntry } from './data';
export { decodeBankWallet, decodeBankReceipt } from './data';
export type { BankAccount, BankWallet, BankReceipt, BankEntry, BankPage } from './data';

export const fetchBankWallet = (token: string, signal?: AbortSignal) => pluginRequest(token, '/v1/banking/wallet', decodeBankWallet, { signal });
export const connectBanks = (token: string, bankIds: string[], signal?: AbortSignal) => pluginRequest(token, '/v1/banking/connect', decodeBankWallet, { method: 'POST', body: { bank_ids: bankIds }, signal });
export function fetchBankTransactions(token: string, options: { bankId?: string; cursor?: string | null; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ limit: '20' }); if (options.bankId) params.set('bank_id', options.bankId); if (options.cursor) params.set('cursor', options.cursor);
  return pluginRequest(token, `/v1/banking/transactions?${params}`, decodeBankPage(decodeBankReceipt), { signal: options.signal });
}
export function fetchBankEntries(token: string, options: { bankId?: string; cursor?: string | null; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ limit: '30' }); if (options.bankId) params.set('bank_id', options.bankId); if (options.cursor) params.set('cursor', options.cursor);
  return pluginRequest(token, `/v1/banking/entries?${params}`, decodeBankPage(decodeBankEntry), { signal: options.signal });
}
export function bankingError(error: unknown, text: (zh: string, en: string) => string): string {
  const code = error instanceof WorkbenchError ? error.code : 'UNKNOWN';
  const messages: Record<string, [string, string]> = {
    UNAUTHORIZED: ['请重新登录 Q 后查看钱包。', 'Sign in to Q again to view your wallet.'],
    BANK_NOT_CONNECTED: ['请先添加付款银行插件。', 'Add the source bank plugin first.'],
    INSUFFICIENT_FUNDS: ['模拟余额不足，请修改金额或付款银行。', 'Insufficient demo balance. Change the amount or source bank.'],
    BANK_ACCOUNT_UNAVAILABLE: ['请先添加收款银行插件。', 'Add the destination bank plugin first.'],
    INVALID_RESPONSE: ['钱包响应无法校验，请刷新重试。', 'The wallet response could not be verified. Please refresh.'],
  };
  return text(...(messages[code] ?? ['暂时无法读取钱包。请检查网络及当前后端是否已更新，再刷新重试。', 'The wallet is unavailable. Check your connection and backend version, then refresh.']));
}
