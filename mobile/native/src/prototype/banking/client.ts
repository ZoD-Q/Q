import { pluginRequest } from '../plugin-host/client';
import { WorkbenchError } from '../api-workbench/core';
import { decodeBankWallet, decodeBankReceipt, decodeBankPage, decodeBankEntry } from './data';
export { decodeBankWallet, decodeBankReceipt } from './data';
export type { BankAccount, BankWallet, BankReceipt, BankEntry, BankPage } from './data';

async function bankRequest<T>(token: string, path: string, decode: (value: unknown) => T, options: {
  method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal;
} = {}): Promise<T> {
  try {
    return await pluginRequest(token, path, decode, options);
  } catch (error) {
    // Only these bank collection endpoints imply feature availability. A missing individual
    // plugin connection or a named bank business error must retain its original meaning.
    if (error instanceof WorkbenchError && [404, 501].includes(error.status)
      && ['REQUEST_FAILED', 'NOT_FOUND', 'NOT_IMPLEMENTED'].includes(error.code)) {
      throw new WorkbenchError('BANKING_UNAVAILABLE', error.status);
    }
    throw error;
  }
}

export const fetchBankWallet = (token: string, signal?: AbortSignal) => bankRequest(token, '/v1/banking/wallet', decodeBankWallet, { signal });
export const connectBanks = (token: string, bankIds: string[], signal?: AbortSignal) => bankRequest(token, '/v1/banking/connect', decodeBankWallet, { method: 'POST', body: { bank_ids: bankIds }, signal });
export function fetchBankTransactions(token: string, options: { bankId?: string; cursor?: string | null; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ limit: '20' }); if (options.bankId) params.set('bank_id', options.bankId); if (options.cursor) params.set('cursor', options.cursor);
  return bankRequest(token, `/v1/banking/transactions?${params}`, decodeBankPage(decodeBankReceipt), { signal: options.signal });
}
export function fetchBankEntries(token: string, options: { bankId?: string; cursor?: string | null; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ limit: '30' }); if (options.bankId) params.set('bank_id', options.bankId); if (options.cursor) params.set('cursor', options.cursor);
  return bankRequest(token, `/v1/banking/entries?${params}`, decodeBankPage(decodeBankEntry), { signal: options.signal });
}
export function bankingError(error: unknown, text: (zh: string, en: string) => string): string {
  const code = error instanceof WorkbenchError ? error.code : 'UNKNOWN';
  const status = error instanceof WorkbenchError ? error.status : 0;
  if (status === 401) return text('请重新登录 Q 后查看钱包。', 'Sign in to Q again to view your wallet.');
  if (status === 429) return text('操作较频繁，请稍后再读取钱包。', 'Too many requests. Wait a moment before reading your wallet again.');
  if (code === 'BANKING_UNAVAILABLE' && [404, 501].includes(status)) return text('当前服务暂不提供银行插件，请稍后重试。', 'Bank plugins are currently unavailable from this service. Please try again later.');
  if (status >= 500) return text('钱包服务暂时不可用，请稍后再读取。已提交的操作请先查询状态。', 'The wallet service is temporarily unavailable. Read it again later; check the status of submitted actions first.');
  if (status === 403) return text('当前账号暂时无法访问此钱包。', 'This account cannot access this wallet at the moment.');
  const messages: Record<string, [string, string]> = {
    UNAUTHORIZED: ['请重新登录 Q 后查看钱包。', 'Sign in to Q again to view your wallet.'],
    BANK_NOT_CONNECTED: ['请先添加付款银行插件。', 'Add the source bank plugin first.'],
    INSUFFICIENT_FUNDS: ['模拟余额不足，请修改金额或付款银行。', 'Insufficient demo balance. Change the amount or source bank.'],
    BANK_ACCOUNT_UNAVAILABLE: ['请先添加收款银行插件。', 'Add the destination bank plugin first.'],
    PLUGIN_NOT_FOUND: ['这个银行连接已不可用，请返回插件列表刷新。', 'This bank connection is no longer available. Return to the plugin list and refresh.'],
    INVALID_RESPONSE: ['暂时无法识别钱包数据，请重新读取。已提交的操作请先查询状态。', 'The wallet data could not be understood. Read it again; check the status of submitted actions first.'],
    NETWORK_ERROR: ['无法连接钱包服务，请检查网络后重新读取。已提交的操作请先查询状态。', 'Cannot reach the wallet service. Check your network and read it again; check submitted actions first.'],
    REQUEST_TIMEOUT: ['读取钱包超时，请稍后重新读取。已提交的操作请先查询状态，不要重复执行。', 'The wallet request timed out. Read it again later; check submitted actions and do not repeat them.'],
    CANCELLED: ['已停止等待。若操作已提交，请先查询状态，不要重复执行。', 'Stopped waiting. If an action was submitted, check its status and do not repeat it.'],
    INSECURE_API_URL: ['当前服务地址不可用，请检查应用配置或联系支持。', 'The service address is unavailable. Check the app configuration or contact support.'],
    RATE_LIMITED: ['操作较频繁，请稍后再读取钱包。', 'Too many requests. Wait a moment before reading your wallet again.'],
  };
  if (messages[code]) return text(...messages[code]);
  if (status === 404) return text('未找到这条银行记录或连接，请返回列表刷新。', 'This bank record or connection was not found. Return to the list and refresh.');
  return text('暂时无法读取钱包。请稍后重新读取；已提交的操作请先查询状态。', 'The wallet could not be read. Read it again later; check the status of submitted actions first.');
}
