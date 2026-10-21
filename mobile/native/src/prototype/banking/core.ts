export type Owner = 'me' | 'chen';
export class BankDemoError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
/** Decimal string → integer cents without floating-point rounding or permissive parseFloat. */
export function parseAmount(text: string): number {
  const value = text.trim();
  if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) throw new BankDemoError('INVALID_AMOUNT');
  const [whole, fraction = ''] = value.replaceAll(',', '').split('.');
  const minor = Number(`${whole}${fraction.padEnd(2, '0')}`);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new BankDemoError('INVALID_AMOUNT');
  return minor;
}

export function formatHKD(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new BankDemoError('INVALID_AMOUNT');
  const absolute = Math.abs(minor);
  return `${minor < 0 ? '-' : ''}HK$${Math.floor(absolute / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(absolute % 100).padStart(2, '0')}`;
}
