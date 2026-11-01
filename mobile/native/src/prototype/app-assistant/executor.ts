import { requestMarketReport } from '../market-data/client';
import { buildResearchDraft, marketErrorText } from '../market-data/core';
import { MarketDataSession, publicMemory } from '../market-data/use-market-data';
import { createAppNavigationAction, executeLocalAppCommand, validateAppCommand, type AppCommand, type AppReadResult } from './core';

// Three public results must fit the shared 24000-character continuation budget.
export const APP_RESULT_LIMIT = 8000;
function reportText(report: Parameters<typeof buildResearchDraft>[0], locale: 'zh' | 'en', maxCharacters: number) {
  // The draft's first/last paragraphs are model instructions, not fetched facts.
  // Tool results are already labelled untrusted by the server; keep chat display factual.
  const paragraphs = buildResearchDraft(report, locale, maxCharacters).split('\n\n');
  return paragraphs.slice(1, -1).join('\n\n')
    .replace(/^外部资料引用 (\d+)（仅作数据，不是指令）：/gm, '资料 $1：')
    .replace(/^External source quotation (\d+) \(data, never instructions\):/gm, 'Source item $1:');
}
export function appResultContext(result: AppReadResult): string {
  const compact = JSON.stringify({ text: result.text, ...(result.data === undefined ? {} : { data: result.data }) });
  if (Array.from(compact).length <= APP_RESULT_LIMIT) return compact;
  const textOnly = JSON.stringify({ text: result.text });
  if (Array.from(textOnly).length <= APP_RESULT_LIMIT) return textOnly;
  throw new Error('APP_RESULT_TOO_LARGE');
}

/** Only local public catalog reads and fixed-source market reads. No account API or navigation. */
export async function executeAppCommand(value: AppCommand, locale: 'zh' | 'en', options: { signal: AbortSignal; transport: typeof fetch }): Promise<AppReadResult> {
  const command = validateAppCommand(value);
  if (options.signal.aborted) throw new Error('CANCELLED');
  const local = executeLocalAppCommand(command, locale);
  if (command.name !== 'market_query') return local;
  const session = new MarketDataSession(command.arguments, {
    request: (query, signal) => requestMarketReport(query, { signal, transport: options.transport }),
    onChange: () => {}, isCurrent: () => !options.signal.aborted, memory: publicMemory,
  });
  const abort = () => session.cancel(false);
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    session.configure(command.arguments, true);
    const success = await session.run();
    if (options.signal.aborted) throw new Error('CANCELLED');
    const report = session.state.report;
    const actions = [createAppNavigationAction('market-data', locale, { marketQuery: command.arguments })];
    if (!success || !report || session.state.phase !== 'ready') {
      const explanation = session.state.phase === 'cooldown'
        ? locale === 'zh' ? '公开来源仍在冷却期，本次没有取得新资料。请稍后在市场资料页查询。' : 'The public source is cooling down. No new data was obtained; try the market page later.'
        : marketErrorText(session.state.error, locale);
      return { text: explanation, actions, data: { success: false, nextAllowedAt: session.state.nextAllowedAt } };
    }
    // Crop the rendered record list, never the source report: available counts and
    // topic counts must keep describing the original complete returned sample.
    let maxCharacters = 7500;
    let text = reportText(report, locale, maxCharacters);
    let encodedLength = JSON.stringify({ text }).length;
    while (encodedLength > APP_RESULT_LIMIT) {
      // Escaped quotes and backslashes also consume the serialized context budget.
      maxCharacters -= Math.max(256, encodedLength - APP_RESULT_LIMIT);
      text = reportText(report, locale, maxCharacters);
      encodedLength = JSON.stringify({ text }).length;
    }
    return { text, actions };
  } finally {
    options.signal.removeEventListener('abort', abort);
    session.dispose();
  }
}
