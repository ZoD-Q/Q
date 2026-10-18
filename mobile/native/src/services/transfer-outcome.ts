/** A rejected retry never proves that an earlier ambiguous attempt did not commit. */
export function canDiscardFailedTransfer(code: string, status: number, previouslyUnknown: boolean): boolean {
  if (previouslyUnknown || status < 400 || status >= 500) return false;
  return ['VALIDATION_ERROR', 'INSUFFICIENT_FUNDS', 'SELF_TRANSFER', 'USER_NOT_FOUND'].includes(code);
}
