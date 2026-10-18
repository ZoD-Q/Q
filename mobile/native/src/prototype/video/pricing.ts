/** Display-only QDC quote. This does not charge a wallet or create an ad agreement. */
export const MAX_ADS = 10;
export const AD_DISCOUNT_PERCENT = 5;

export interface VideoQuote {
  baseMinor: number;
  selectedCount: number;
  discountPercent: number;
  savingsMinor: number;
  totalMinor: number;
}

export function quoteVideo(baseMinor: number, brandIds: string[]): VideoQuote {
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) {
    throw new RangeError('baseMinor must be a nonnegative safe integer.');
  }
  if (!Array.isArray(brandIds) || brandIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('brandIds must contain nonempty string IDs.');
  }
  const selectedCount = new Set(brandIds).size;
  if (selectedCount > MAX_ADS) {
    throw new RangeError(`Select at most ${MAX_ADS} distinct brands.`);
  }
  const discountPercent = selectedCount * AD_DISCOUNT_PERCENT;
  // Use exact integer arithmetic; fractional minor-unit savings round down.
  const savingsMinor = Number((BigInt(baseMinor) * BigInt(discountPercent)) / 100n);
  return { baseMinor, selectedCount, discountPercent, savingsMinor, totalMinor: baseMinor - savingsMinor };
}
