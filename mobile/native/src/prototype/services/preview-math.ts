/** All demo amounts are integer QDC minor units, never a real quote. */
export function splitPayments(total: number, count: number): number[] {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isInteger(count) || count < 1 || count > 36) {
    throw new Error('Invalid payment plan');
  }
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => base + (i < total % count ? 1 : 0));
}

export function parseDemoAmount(input: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(input.trim())) return null;
  const [whole, fraction = ''] = input.trim().split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return result >= 10000 && result <= 100000000 ? result : null;
}

export function scenarioReturn(principal: number, days: number, basisPoints: number): number {
  if (!Number.isSafeInteger(principal) || principal < 0 || ![30, 90, 180, 365].includes(days) || !Number.isInteger(basisPoints) || Math.abs(basisPoints) > 10000) {
    throw new Error('Invalid scenario');
  }
  return Math.round(principal * basisPoints * days / (10000 * 365));
}

export const demoMoney = (minor: number) => (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
