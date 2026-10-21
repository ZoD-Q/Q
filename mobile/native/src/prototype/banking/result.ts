import { bankTransferArguments, record, type PluginInvocation } from '../plugin-host/core';
import { decodeBankReceipt, type BankReceipt } from './data';

/** Bind the server's flat structured receipt to the original immutable proposal. */
export function bankReceiptForInvocation(invocation: PluginInvocation): BankReceipt | null {
  const proposal = bankTransferArguments(invocation);
  if (!proposal || invocation.status !== 'succeeded' || !record(invocation.result)
    || invocation.result.isError === true || !record(invocation.result.structuredContent)
    || invocation.result.structuredContent.kind !== 'bank_transfer') return null;
  try {
    const saved = decodeBankReceipt(invocation.result.structuredContent);
    return saved.source_bank_id === proposal.sourceBankId && saved.destination_bank_id === proposal.destinationBankId
      && saved.recipient === proposal.recipient && saved.amount_minor === proposal.amountMinor && saved.memo === proposal.memo
      ? saved : null;
  } catch { return null; }
}

export function bankFailureForInvocation(invocation: PluginInvocation): string | null {
  if (!bankTransferArguments(invocation) || invocation.status !== 'tool_error' || !record(invocation.result)
    || invocation.result.isError !== true || !record(invocation.result.structuredContent)
    || invocation.result.structuredContent.kind !== 'bank_error' || invocation.result.structuredContent.mode !== 'demo') return null;
  const code = invocation.result.structuredContent.error_code;
  return typeof code === 'string' && ['INSUFFICIENT_FUNDS', 'BANK_ACCOUNT_UNAVAILABLE', 'BANK_SAME_ACCOUNT', 'VALIDATION_ERROR', 'IDEMPOTENCY_CONFLICT'].includes(code) ? code : 'BANK_TOOL_ERROR';
}
