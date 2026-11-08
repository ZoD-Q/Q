import { WorkbenchError } from '../api-workbench/core';
import { decodePluginConnection, isUuid, record, type PluginConnection } from '../plugin-host/core';

export const FINANCIAL_PROVIDERS = {
  ifind: { name: '同花顺 iFinD', en: 'iFinD', auth: 'api_key', home: 'https://mcp.51ifind.com/',
    description: ['股票、基金、债券、港美股、指数、期货期权、宏观与新闻公告，按账号权益取数。', 'Stocks, funds, bonds, overseas equities, indexes, derivatives, macro and news, subject to account access.'],
    example: ['研究一家公司的财务变化和公告依据', 'Research a company’s financial changes and filings'] },
  jin10: { name: '金十数据', en: 'Jin10', auth: 'api_key', home: 'https://mcp.jin10.com/app/doc.html',
    description: ['行情报价、K线、财经快讯与资讯，受供应商权益和额度限制。', 'Quotes, charts, financial flashes and news, subject to provider access and quotas.'],
    example: ['查找黄金近期的行情与财经事件', 'Look up gold market data and related financial events'] },
  massive: { name: 'Massive', en: 'Massive', auth: 'oauth', home: 'https://www.massive.com/docs/ai-tools/quickstart',
    description: ['美国市场资料，范围和时效取决于套餐；支持即时查询，不支持跨次调用的临时表保存与分析。', 'US market data depends on your plan. Supports immediate queries, without saved temporary tables or analysis across calls.'],
    example: ['查看美股历史行情和市场资料', 'Explore historical US stock prices and market data'] },
  alphavantage: { name: 'Alpha Vantage', en: 'Alpha Vantage', auth: 'oauth', home: 'https://mcp.alphavantage.co/',
    description: ['股票行情、历史数据和金融指标，按授权后的实际能力使用。', 'Stock prices, historical data and financial indicators within your authorized access.'],
    example: ['查询股票的历史表现与金融指标', 'Look up stock history and financial indicators'] },
  twelvedata: { name: 'Twelve Data', en: 'Twelve Data', auth: 'oauth', home: 'https://github.com/twelvedata/mcp',
    description: ['行情、技术指标、基本面和公司资料，覆盖以账号权限为准。', 'Prices, technical indicators, fundamentals and company data within your account coverage.'],
    example: ['查询证券历史价格和技术指标', 'Look up historical security prices and technical indicators'] },
  coingecko: { name: 'CoinGecko', en: 'CoinGecko', auth: 'none', home: 'https://mcp.api.coingecko.com/',
    description: ['加密资产市场资料；公共服务无需个人密钥，但有调用限流。', 'Crypto market research; the public service needs no personal key but is rate limited.'],
    example: ['研究比特币的市场数据与历史变化', 'Research Bitcoin market data and historical changes'] },
  tavily: { name: 'Tavily', en: 'Tavily', auth: 'none', home: 'https://docs.tavily.com/documentation/mcp',
    description: ['搜索公开网页、提取正文；无需个人密钥，有共享额度，结果需核对原始来源。', 'Search public pages and extract text without a personal key. Shared quotas apply; verify the original sources.'],
    example: ['搜索一家公司的近期公告，并核对原始出处', 'Find a company’s recent announcements and verify their original sources'] },
  fred: { name: 'FRED', en: 'FRED', auth: 'oauth', home: 'https://fred.stlouisfed.org/docs/api/fred/',
    description: ['研究宏观时间序列。查询和结果仅临时显示，不进入小Q缓存或聊天历史。', 'Research macroeconomic time series. Queries and results are temporary and never enter Q’s cache or chat history.'],
    example: ['查找宏观数据系列及其观测值', 'Find macroeconomic series and their observations'] },
} as const;
export type FinancialProviderId = keyof typeof FINANCIAL_PROVIDERS;
export type FinancialProvider = { id: FinancialProviderId; name: string; description: string; homepage_url: string; auth_mode: 'none' | 'api_key' | 'oauth'; connection: PluginConnection | null };
export type FinancialCatalog = { available: boolean; credentials_configured: boolean; oauth_configured: boolean; providers: FinancialProvider[] };
const fail = (): never => { throw new WorkbenchError('INVALID_RESPONSE'); };
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const financialProviderId = (value: unknown): value is FinancialProviderId => typeof value === 'string' && Object.hasOwn(FINANCIAL_PROVIDERS, value);

export function decodeFinancialConnection(value: unknown, provider: FinancialProviderId, expectedId?: string): PluginConnection {
  const connection = decodePluginConnection(value);
  const actualProvider = connection.financial_provider_id ?? connection.research_provider_id;
  if (connection.connection_kind !== 'remote_mcp' || connection.builtin_service_id !== null || actualProvider !== provider || (expectedId !== undefined && connection.id !== expectedId)) return fail();
  return connection;
}
export function decodeFinancialCatalog(value: unknown): FinancialCatalog {
  if (!record(value) || typeof value.available !== 'boolean' || typeof value.credentials_configured !== 'boolean' || typeof value.oauth_configured !== 'boolean' || !Array.isArray(value.providers) || value.providers.length > 8) return fail();
  const ids = new Set<string>();
  const providers = value.providers.map((item): FinancialProvider => {
    if (!record(item) || !financialProviderId(item.id) || ids.has(item.id) || !text(item.name, 120) || !text(item.description, 4000)) return fail();
    const expected = FINANCIAL_PROVIDERS[item.id];
    if (item.auth_mode !== expected.auth || !text(item.homepage_url, 2048)) return fail();
    let url: URL; try { url = new URL(item.homepage_url); } catch { return fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.origin !== new URL(expected.home).origin) return fail();
    ids.add(item.id);
    return { id: item.id, name: item.name, description: item.description, homepage_url: item.homepage_url, auth_mode: expected.auth, connection: item.connection === null ? null : decodeFinancialConnection(item.connection, item.id) };
  });
  return { available: value.available, credentials_configured: value.credentials_configured, oauth_configured: value.oauth_configured, providers };
}
export type FinancialAuthorization = { id: string; url: string; connectionId: string; provider: FinancialProviderId };
const oauthOrigins: Partial<Record<FinancialProviderId, string>> = { massive: 'https://auth.massive.com', alphavantage: 'https://mcp.alphavantage.co', twelvedata: 'https://auth.twelvedata.com', fred: 'https://mcp.stlouisfed.org' };
export function decodeFinancialAuthorization(value: unknown, provider: FinancialProviderId, connectionId: string): FinancialAuthorization {
  if (!record(value) || !isUuid(value.attempt_id) || !text(value.authorization_url, 8192) || !isUuid(connectionId)) return fail();
  let url: URL; try { url = new URL(value.authorization_url); } catch { return fail(); }
  if (!oauthOrigins[provider] || url.origin !== oauthOrigins[provider] || url.username || url.password || url.hash || !url.searchParams.get('state') || !url.searchParams.get('code_challenge')) return fail();
  return { id: value.attempt_id, url: url.href, connectionId, provider };
}
export function decodeAuthorizationAttempt(value: unknown, authorization: FinancialAuthorization): boolean {
  if (!record(value) || value.id !== authorization.id || value.connection_id !== authorization.connectionId || typeof value.status !== 'string') return fail();
  if (value.status === 'succeeded') return true;
  throw new WorkbenchError(['pending', 'exchanging'].includes(value.status) ? 'PLUGIN_AUTH_PENDING' : 'PLUGIN_AUTH_REQUIRED');
}
export function financialError(error: unknown, translate: (zh: string, en: string) => string): string {
  const code = error instanceof WorkbenchError ? error.code : '';
  if (error instanceof WorkbenchError && error.status === 404) return translate('当前服务器尚未提供金融插件，请更新服务后重试。', 'This server does not provide financial plugins yet. Update the service and try again.');
  const errors: Record<string, [string, string]> = {
    PLUGIN_AUTH_REQUIRED: ['需要完成此服务的授权，或重新配置有效密钥。', 'Authorize this provider or configure a valid key.'],
    PLUGIN_AUTH_PENDING: ['授权还未完成，请在浏览器完成后再检查。', 'Authorization is not complete. Finish in the browser, then check again.'],
    PLUGIN_EPHEMERAL_REQUIRED: ['请进入 FRED 临时研究页。查询和结果不会保存到聊天历史。', 'Open FRED temporary research. Queries and results are not saved to chat history.'],
    MCP_FORBIDDEN: ['服务拒绝了此项访问，请核对账号权限；现有授权仍保留。', 'The provider denied access. Check account permissions; your authorization is retained.'],
    MCP_PAYMENT_REQUIRED: ['服务要求额外的套餐或额度，请到服务方核对权益。', 'The provider requires additional plan or credit access. Check your subscription.'],
    MCP_RATE_LIMITED: ['服务调用额度或频率已达上限，请稍后再试。', 'The provider’s quota or rate limit was reached. Try later.'],
    MCP_AUTH_REQUIRED: ['服务授权已失效，请重新完成授权。', 'Provider authorization expired. Authorize again.'],
    MCP_NETWORK_ERROR: ['暂时无法连接服务；授权仍保留，请稍后再试。', 'The provider is unreachable. Your authorization is retained; try later.'],
    MCP_TIMEOUT: ['服务响应超时；授权仍保留，已提交的调用先查询状态。', 'The provider timed out. Your authorization is retained; check submitted calls first.'],
    PLUGIN_CAPABILITY_UNSUPPORTED: ['此项能力当前不可用。请刷新能力，或核对供应商权限。', 'This capability is unavailable. Refresh capabilities or check provider access.'],
    PLUGIN_RECONFIRM_REQUIRED: ['服务能力有更新，请在“我的连接”核对并确认更新后使用。', 'Capabilities changed. Review and accept the update in My connections.'],
    PLUGIN_CREDENTIALS_NOT_CONFIGURED: ['服务器尚未启用安全密钥保存，请联系小Q服务管理员。', 'Secure key storage is not configured. Contact the Q service administrator.'],
    PLUGIN_OAUTH_NOT_CONFIGURED: ['服务器尚未配置安全授权，请联系小Q服务管理员。', 'Secure authorization is not configured on this server. Contact the Q service administrator.'],
    INVALID_RESPONSE: ['服务返回内容未通过校验，请刷新连接状态后重试。', 'The response could not be verified. Refresh the connection state and retry.'],
    VALIDATION_ERROR: ['请检查输入的密钥格式；不会在对话中保存密钥。', 'Check the key format. Keys are not stored in chat.'],
    NETWORK_ERROR: ['暂时无法连接。添加或保存的结果可能尚未确认，请先刷新状态。', 'Connection failed. An add or save may have completed; refresh the state first.'],
    REQUEST_TIMEOUT: ['请求超时，结果尚未确认。请先刷新状态，不要重复提交密钥。', 'The request timed out and its result is unconfirmed. Refresh before submitting the key again.'],
    UNAUTHORIZED: ['请重新登录小Q后继续。', 'Sign in to Q again to continue.'],
    CANCELLED: ['操作已取消；返回后可刷新连接状态。', 'Operation cancelled. Refresh connection state when you return.'],
  };
  return errors[code] ? translate(...errors[code]) : translate('金融插件暂时不可用。请刷新状态，或核对服务授权和额度。', 'This financial plugin is unavailable. Refresh or check provider access and quota.');
}
