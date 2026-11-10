import { listCompanyFilings, readCompanyFiling, filingErrorText } from '../company-research/filings-client';
import { buildFilingCatalogText, buildFilingEvidenceText, buildFilingCatalogSummary, buildFilingSummary } from '../company-research/filings-core';
import { searchCompanies, researchCompany } from '../company-research/client';
import { buildCompanyResearchText, buildCompanyResearchSummary, CompanyResearchError } from '../company-research/core';
import { rememberCompanyResult, rememberCompanyFilingResult, forgetCompanyFilingResult } from '../company-research/handoff';
import { requestMarketReport } from '../market-data/client';
import { buildResearchDraft, marketErrorText, marketDirectReadAllowed, MarketDataError } from '../market-data/core';
import { MarketDataSession, publicMemory } from '../market-data/use-market-data';
import { createAppNavigationAction, companyNavigationLabel, executeLocalAppCommand, validateAppCommand, type AppCommand, type AppReadResult, type AppResultSource, type AppNavigationAction } from './core';

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
  const text = result.modelText ?? result.text;
  const compact = JSON.stringify({ text, ...(result.data === undefined ? {} : { data: result.data }) });
  if (Array.from(compact).length <= APP_RESULT_LIMIT) return compact;
  const textOnly = JSON.stringify({ text });
  if (Array.from(textOnly).length <= APP_RESULT_LIMIT) return textOnly;
  throw new Error('APP_RESULT_TOO_LARGE');
}

function companyAction(locale: 'zh' | 'en', query?: string, issuerId?: string, filing?: { companyView: 'filings'; companyAccession?: string }): AppNavigationAction {
  const action = createAppNavigationAction('market-data', locale, {
    ...(query ? { companyQuery: Array.from(query).slice(0, 120).join('') } : {}),
    ...(issuerId ? { companyIssuerId: issuerId } : {}),
    ...filing,
  });
  return { ...action, label: companyNavigationLabel(action, locale) };
}

function readableLocalResult(command: AppCommand, result: AppReadResult, locale: 'zh' | 'en'): AppReadResult {
  const zh = locale === 'zh';
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
  const sources: AppResultSource[] = Array.isArray(data.sources) ? data.sources.flatMap(source => source && typeof source === 'object' && !Array.isArray(source)
    && typeof source.title === 'string' && typeof source.url === 'string' ? [{ label: source.title, url: source.url }] : []) : [];
  let text = result.text;
  if (command.name === 'app_info' && command.arguments.module === 'all') {
    text = zh ? '小Q可查询公开市场资料、解释保障知识，并帮你找到应用里的功能。' : 'Q can look up public market information, explain coverage concepts and help you find app features.';
  } else if (command.name === 'insurance_search' || command.name === 'insurance_compare') {
    const titles = Array.isArray(data.records) ? data.records.flatMap(row => row && typeof row === 'object' && !Array.isArray(row) && typeof row.title === 'string' ? [row.title] : []) : [];
    text = titles.length ? zh ? `已找到${titles.join('、')}的保障说明。以下按保障方向解释，不代表在售产品或报价。` : `Found coverage information for ${titles.join(', ')}. These are coverage concepts, not live products or quotations.`
      : zh ? '没有找到匹配的保障方向。可以换一个保障需求或在保险页浏览。' : 'No matching coverage concept was found. Try another need or browse the insurance guide.';
  } else if (command.name === 'app_open') text = result.text.split('\n\n')[0];
  return { ...result, text, modelText: result.text, sources, ...(command.name === 'app_info' && command.arguments.module === 'all' ? { actions: [] } : {}) };
}

function marketSummary(report: Parameters<typeof buildResearchDraft>[0], locale: 'zh' | 'en'): string {
  const zh = locale === 'zh';
  if (report.kind === 'crypto') {
    const row = report.records[0];
    if (!row || row.priceUsd === null) return zh ? '本次未取得可用参考价。' : 'No reference price was available.';
    const time = row.asOf ? new Date(row.asOf).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : zh ? '来源未提供时间' : 'Source time unavailable';
    return zh ? `${row.symbol} 参考价为 ${row.priceUsd.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 美元。来源：Chainlink，${time}；这不是交易所实时成交价。`
      : `${row.symbol} reference price: USD ${row.priceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}. Chainlink, ${time}; this is not a live exchange trade price.`;
  }
  if (report.kind === 'filings') return zh ? `取得 ${report.records.length} 份申报目录，尚未读取文件正文。` : `Retrieved ${report.records.length} filing entries; document text has not been read.`;
  const availability = report.newsCache?.status;
  if (!report.records.length) return zh ? '本次没有取得可用新闻，不能据此判断没有新消息。' : 'No usable news was retrieved. This does not mean there are no new updates.';
  return zh ? `取得 ${report.records.length} 条公开新闻资料${availability === 'stale' ? '，其中资料已过期' : availability === 'partial' ? '，部分来源暂不可用' : ''}。下面只分析这些已取得的资料。`
    : `Retrieved ${report.records.length} public news items${availability === 'stale' ? '; the cached material is out of date' : availability === 'partial' ? '; some sources are unavailable' : ''}. Analysis is limited to these items.`;
}

/** Only local public catalog reads and fixed-source market reads. No account API or navigation. */
export async function executeAppCommand(value: AppCommand, locale: 'zh' | 'en', options: { signal: AbortSignal; transport: typeof fetch }): Promise<AppReadResult> {
  const command = validateAppCommand(value);
  if (options.signal.aborted) throw new Error('CANCELLED');
  if (command.name === 'company_filings' || command.name === 'company_filing') {
    try {
      const report = command.name === 'company_filings'
        ? await listCompanyFilings(command.arguments.issuerId, options)
        : await readCompanyFiling(command.arguments.issuerId, command.arguments.accession, { ...options, offset: command.arguments.offset, expectedSha256: command.arguments.expectedSha256 });
      const catalog = 'filings' in report;
      const text = catalog ? buildFilingCatalogSummary(report, locale) : buildFilingSummary(report, locale);
      const modelText = catalog ? buildFilingCatalogText(report, locale) : buildFilingEvidenceText(report, locale);
      if (options.signal.aborted) throw new Error('CANCELLED');
      rememberCompanyFilingResult(report);
      const result: AppReadResult = { text, modelText, actions: [companyAction(locale, report.company_name, command.arguments.issuerId, { companyView: 'filings', ...(!catalog ? { companyAccession: report.filing.accession } : {}) })],
        sources: catalog ? report.filings.slice(0, 3).map(filing => ({ label: `${report.company_name} · ${filing.form} · ${filing.filed_at}`, url: filing.document_url }))
          : [{ label: `${report.company_name} · ${report.filing.form} · ${report.filing.filed_at}`, url: report.filing.document_url }] };
      appResultContext(result);
      return result;
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (!(error instanceof CompanyResearchError)) throw error;
      if (error.code === 'RESEARCH_DOCUMENT_CHANGED' && command.name === 'company_filing') forgetCompanyFilingResult({ issuerId: command.arguments.issuerId, accession: command.arguments.accession });
      return { text: filingErrorText(error, locale), actions: [companyAction(locale, undefined, command.arguments.issuerId, { companyView: 'filings', ...(command.name === 'company_filing' ? { companyAccession: command.arguments.accession } : {}) })], data: { success: false, documentRead: false } };
    }
  }
  if (command.name === 'company_search' || command.name === 'company_research') {
    const report = command.name === 'company_search' ? await searchCompanies(command.arguments.query, { ...options, purpose: 'assistant' }) : await researchCompany(command.arguments.issuerId, options);
    if (options.signal.aborted) throw new Error('CANCELLED');
    rememberCompanyResult(report);
    const name = report.kind === 'company-search' ? report.query : report.company?.name;
    return { text: buildCompanyResearchSummary(report, locale), modelText: buildCompanyResearchText(report, locale),
      actions: [companyAction(locale, name, report.kind === 'company-research' ? report.issuerId : undefined)],
      sources: report.kind === 'company-search' ? report.candidates.slice(0, 4).map(candidate => ({ label: `${candidate.name} · ${candidate.source === 'sec' ? 'SEC' : 'Wikidata'}`, url: candidate.sourceUrl }))
        : report.facts.slice(0, 3).map(fact => ({ label: `${report.company?.name ?? 'SEC'} · ${fact.form} · ${fact.filed}`, url: fact.sourceUrl })) };
  }
  const local = executeLocalAppCommand(command, locale);
  if (command.name !== 'market_query') return readableLocalResult(command, local, locale);
  if (!marketDirectReadAllowed(command.arguments, process.env.EXPO_OS)) {
    return {
      text: marketErrorText(new MarketDataError('browser_unsupported'), locale),
      actions: [createAppNavigationAction('market-data', locale, { marketQuery: command.arguments })],
      data: { success: false, code: 'browser_unsupported', nextAllowedAt: null },
    };
  }
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
    return { text: marketSummary(report, locale), modelText: text, actions,
      sources: report.kind === 'news' ? report.records.slice(0, 5).map(row => ({ label: row.title, url: row.url }))
        : report.kind === 'filings' ? report.records.slice(0, 3).map(row => ({ label: `${row.form} · ${row.filingDate}`, url: row.url }))
          : [{ label: report.source.name, url: report.source.referenceUrl ?? report.source.url }] };
  } finally {
    options.signal.removeEventListener('abort', abort);
    session.dispose();
  }
}
