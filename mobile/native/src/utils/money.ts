/** Parse decimal text into integer minor units, without floating-point multiplication. */
export function parseAmount(value: string): number | null {
  const input = value.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor >= 1 && minor <= 100000000 ? minor : null;
}
export function formatAmount(minor: number): string {
  const whole = Math.floor(Math.abs(minor) / 100).toLocaleString('en-US');
  return `${minor < 0 ? '-' : ''}${whole}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
}
