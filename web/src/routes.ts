export const adminPages = [
  { id: 'orders', path: '/wallet-payments/orders', zh: '支付审核与退款', en: 'Reviews & refunds' },
  { id: 'settlements', path: '/wallet-payments/settlements', zh: '结算与储备凭证', en: 'Settlement & reserve evidence' },
  { id: 'fx', path: '/wallet-payments/fx', zh: '汇率状态', en: 'FX status' },
  { id: 'audit', path: '/wallet-payments/audit', zh: '支付操作记录', en: 'Payment audit' },
] as const;
export type AdminPage = typeof adminPages[number]['id'];
export function adminPageForPath(path: string): AdminPage | null {
  const normalized = path.replace(/\/+$/, '') || '/';
  if (normalized === '/' || normalized === '/wallet-payments') return 'orders';
  return adminPages.find(page => page.path === normalized)?.id ?? null;
}
