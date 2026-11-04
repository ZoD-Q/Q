// Pure simulated-market and portfolio math for the wealth center. Deterministic given the injected
// rng; the page layer owns timers, state and rendering. Demo data only — never a live price feed.
import { EQUITY_UNITS, marketFunds, shelfItems, shelfRiskGroups, type MarketFund, type RiskLevel, type ShelfItem, type ShelfRiskGroup } from './catalog';

export type Candle = { o: number; c: number; h: number; l: number };
const drift = (value: number, rng: () => number, scale: number) => value * (1 + (rng() - 0.5) * scale);
export function nextCandle(price: number, rng: () => number = Math.random): { candle: Candle; price: number } {
  const o = price;
  const c = o * (1 + (rng() - 0.485) * 0.0018);
  const candle: Candle = { o, c, h: Math.max(o, c) * (1 + rng() * 0.0008), l: Math.min(o, c) * (1 - rng() * 0.0008) };
  return { candle, price: c };
}
export function seedCandles(count = 30, start = 1.039, rng: () => number = Math.random): { candles: Candle[]; price: number } {
  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i++) { const step = nextCandle(price, rng); candles.push(step.candle); price = step.price; }
  return { candles, price };
}
export function sliceWindow(candles: readonly Candle[], size = 26): Candle[] {
  return candles.slice(-size);
}
export function windowBounds(candles: readonly Candle[]): { min: number; max: number } {
  let min = Infinity; let max = -Infinity;
  for (const candle of candles) { if (candle.l < min) min = candle.l; if (candle.h > max) max = candle.h; }
  return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 1 : max };
}
export function todayPct(price: number, dayOpen: number): number {
  if (dayOpen <= 0) return 0;
  return (price / dayOpen - 1) * 100;
}
export function todayPnl(price: number, dayOpen: number, units = EQUITY_UNITS): number {
  return (price - dayOpen) * units;
}
export function distribution(fundMv: number, depositMv: number): { fundPct: number; depositPct: number } {
  const total = fundMv + depositMv;
  if (total <= 0) return { fundPct: 0, depositPct: 0 };
  return { fundPct: (fundMv / total) * 100, depositPct: (depositMv / total) * 100 };
}
export function filterShelf(items: readonly ShelfItem[], riskGroup: ShelfRiskGroup | 'all', termCat: ShelfItem['termCat'] | 'all'): ShelfItem[] {
  return items.filter(item => (riskGroup === 'all' || (shelfRiskGroups[riskGroup] as readonly string[]).includes(item.risk)) && (termCat === 'all' || item.termCat === termCat));
}
export function filterFunds(items: readonly MarketFund[], cat: MarketFund['cat'] | 'all'): MarketFund[] {
  return items.filter(item => cat === 'all' || item.cat === cat);
}
export const RISK_LABEL: Record<RiskLevel, string> = { R1: 'R1 · 低', R2: 'R2 · 中低', R3: 'R3 · 中', R4: 'R4 · 中高', R5: 'R5 · 高' };
export { marketFunds, shelfItems };
