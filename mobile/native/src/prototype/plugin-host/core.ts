import { WorkbenchError } from '../api-workbench/core';
import { normalizeOwnerName, type EntryKind, type PluginEntryIntent } from '../plugin-workbench/materials';
import { BANKS } from '../banking/catalog';

export type PluginEntryIntentOutcome = 'discovered' | 'dismissed';
type PluginEntryIntentEvent =
  | { type: 'received'; intent: PluginEntryIntent }
  | { type: 'settled'; intent: PluginEntryIntent; outcome: PluginEntryIntentOutcome }
  | { type: 'session'; authenticated: boolean };

/** Session changes never consume a public link; only discovery or explicit dismissal does. */
export function pluginEntryIntentReducer(current: PluginEntryIntent | null, event: PluginEntryIntentEvent): PluginEntryIntent | null {
  if (event.type === 'received') return event.intent;
  if (event.type === 'session') return current;
  return current?.entry === event.intent.entry && current.kind === event.intent.kind ? null : current;
}

/** Prefill only: callers must wait for a user action before discovery, adding, or authorization. */
export function initialPluginEntryState(intent?: PluginEntryIntent | null): { entry: string; kind: EntryKind; adding: boolean; advanced: boolean } {
  return { entry: intent?.entry ?? '', kind: intent?.kind ?? 'auto', adding: !!intent, advanced: !!intent && intent.kind !== 'auto' };
}

export function pluginAuthModalReducer(pending: boolean, event: 'requested' | 'shown' | 'dismissed'): boolean {
  switch (event) {
    case 'requested':
    case 'shown': return true;
    case 'dismissed': return false;
    default: return pending;
  }
}

/** iOS dismissal is asynchronous; a valid session alone does not free the native presenter. */
export function canPresentPluginConnectionPage(state: {
  platform?: string; authenticated: boolean; authOpen: boolean; authModalPending: boolean;
}): boolean {
  return state.authenticated && !state.authOpen && (state.platform !== 'ios' || !state.authModalPending);
}

export type JsonObject = Record<string, unknown>;
export type PluginConnection = {
  id: string; card_url: string; name: string; title: string; description: string; version: string;
  endpoint_url: string; revision: number; status: string; auth_status: string; last_error_code: string | null;
  owner_name?: string | null;
  connection_kind?: 'remote_mcp' | 'bank_demo'; builtin_service_id?: string | null;
  created_at: string; updated_at: string; pending_update: boolean; pending_update_details?: unknown;
};
export type PluginTool = { name: string; title?: string | null; description: string; inputSchema: JsonObject; outputSchema?: unknown; annotations?: unknown; _meta?: unknown };
export type Candidate = { candidate_id: string; card_url: string; endpoint_url: string; name: string; title: string; description: string; version: string; owner_name?: string | null };
export type Discovery = { discovery_id: string; expires_at: string; candidates: Candidate[] };
export type PluginInvocation = { id: string; connection_id: string; connection_revision: number; connection_title: string; card_url: string; endpoint_url: string; owner_name?: string | null; connection_kind?: 'remote_mcp' | 'bank_demo'; builtin_service_id?: string | null; tool_name: string; tool_title?: string | null; input_schema?: JsonObject | null; arguments: JsonObject; status: string; result: unknown; error_code: string | null; created_at: string; updated_at: string; expires_at: string };
export type ResourceLink = { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string };
export type PluginContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | ResourceLink;
export type PluginResult = { content: PluginContent[]; structuredContent?: unknown; isError?: boolean };
export const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const str = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const toolName = (value: unknown): value is string => str(value, 512) && value.length > 0 && Array.from(value).length <= 128;
const fail = (): never => { throw new WorkbenchError('INVALID_RESPONSE'); };
const nullable = (value: unknown): value is string | null => value === null || str(value);

type PluginIdentity = { endpoint_url: string; card_url?: string; connection_kind?: string; builtin_service_id?: string | null };
/** Only a service identity returned by Q can select the native bank renderer. */
export function bankIdForPlugin(value: PluginIdentity | null | undefined): string | null {
  if (!value || value.connection_kind !== 'bank_demo' || typeof value.builtin_service_id !== 'string') return null;
  const bank = BANKS.find(item => value.builtin_service_id === `q.bank-demo.${item.id}`);
  if (!bank || value.endpoint_url !== `urn:q:bank-demo:${bank.id}` || (value.card_url !== undefined && value.card_url !== value.endpoint_url)) return null;
  return bank.id;
}

export function decodePluginIdentity(value: JsonObject): { connection_kind: 'remote_mcp' | 'bank_demo'; builtin_service_id: string | null } {
  const kind = value.connection_kind ?? 'remote_mcp';
  if (kind === 'bank_demo') {
    if (!bankIdForPlugin(value as PluginIdentity)) return fail();
    return { connection_kind: kind, builtin_service_id: value.builtin_service_id as string };
  }
  if (kind !== 'remote_mcp' || value.builtin_service_id != null
    || (typeof value.endpoint_url === 'string' && /^urn:/i.test(value.endpoint_url))
    || (typeof value.card_url === 'string' && /^urn:/i.test(value.card_url))) return fail();
  return { connection_kind: 'remote_mcp', builtin_service_id: null };
}

export type BankTransferArguments = { sourceBankId: string; destinationBankId: string; recipient: 'self' | 'demo_chen'; amountMinor: number; memo: string };
export function bankTransferArguments(invocation: PluginInvocation): BankTransferArguments | null {
  const sourceBankId = bankIdForPlugin(invocation), args = invocation.arguments;
  if (!sourceBankId || invocation.tool_name !== 'bank_transfer' || !record(args)
    || !BANKS.some(item => item.id === args.to_bank_id) || !['self', 'demo_chen'].includes(String(args.recipient))
    || typeof args.amount_minor !== 'number' || !Number.isSafeInteger(args.amount_minor) || args.amount_minor <= 0
    || (args.memo !== undefined && (typeof args.memo !== 'string' || Array.from(args.memo).length > 120 || /[\u0000-\u001f\u007f]/.test(args.memo)))
    || Object.keys(args).some(key => !['to_bank_id', 'recipient', 'amount_minor', 'memo'].includes(key))) return null;
  return { sourceBankId, destinationBankId: args.to_bank_id as string, recipient: args.recipient as 'self' | 'demo_chen', amountMinor: args.amount_minor, memo: typeof args.memo === 'string' ? args.memo : '' };
}
export function decodePluginStatus(value: unknown) {
  if (!record(value) || typeof value.available !== 'boolean' || typeof value.oauth_configured !== 'boolean' || !str(value.protocol_version, 30)) return fail();
  return { available: value.available, oauth_configured: value.oauth_configured, protocol_version: value.protocol_version };
}
export function decodePluginConnection(value: unknown): PluginConnection {
  if (!record(value) || !isUuid(value.id) || !['card_url', 'name', 'title', 'description', 'version', 'endpoint_url', 'status', 'auth_status', 'created_at', 'updated_at'].every(key => str(value[key], 16000)) || !Number.isSafeInteger(value.revision) || typeof value.pending_update !== 'boolean' || !nullable(value.last_error_code)) return fail();
  const identity = decodePluginIdentity(value);
  if (identity.connection_kind === 'bank_demo' && value.auth_status !== 'anonymous') return fail();
  return { ...value, ...identity, owner_name: normalizeOwnerName(value.owner_name) } as PluginConnection;
}
export function decodeTool(value: unknown): PluginTool {
  if (!record(value) || !toolName(value.name) || !str(value.description, 16000) || !record(value.inputSchema) || (value.title !== undefined && value.title !== null && !str(value.title, 1024))) return fail();
  return value as PluginTool;
}
export function decodeDiscovery(value: unknown): Discovery {
  if (!record(value) || !isUuid(value.discovery_id) || !str(value.expires_at, 64) || !Array.isArray(value.candidates) || value.candidates.length > 100) return fail();
  const candidates = value.candidates.map((item: unknown) => {
    if (!record(item) || !isUuid(item.candidate_id) || !['card_url', 'endpoint_url', 'name', 'title', 'description', 'version'].every(key => str(item[key], 16000))) return fail();
    return { ...item, owner_name: normalizeOwnerName(item.owner_name) } as Candidate;
  });
  return { ...value, candidates } as Discovery;
}
export function decodeInvocation(value: unknown): PluginInvocation {
  if (!record(value) || !isUuid(value.id) || !isUuid(value.connection_id) || !Number.isSafeInteger(value.connection_revision) || !str(value.connection_title) || !str(value.card_url) || !str(value.endpoint_url) || !str(value.expires_at, 64) || !toolName(value.tool_name) || !record(value.arguments) || !str(value.status, 64) || !nullable(value.error_code) || !str(value.created_at, 64) || !str(value.updated_at, 64)) return fail();
  if ((value.tool_title !== undefined && value.tool_title !== null && !str(value.tool_title)) || (value.input_schema !== undefined && value.input_schema !== null && !record(value.input_schema))) return fail();
  if (!['awaiting_confirmation', 'running', 'succeeded', 'tool_error', 'failed', 'unknown', 'cancelled', 'expired', 'input_required'].includes(value.status)) return fail();
  return { ...value, ...decodePluginIdentity(value), owner_name: normalizeOwnerName(value.owner_name) } as PluginInvocation;
}
export function decodeResourceLink(value: unknown): ResourceLink {
  if (!record(value) || !str(value.uri) || !value.uri || !str(value.name) || (value.title !== undefined && !str(value.title)) || (value.description !== undefined && !str(value.description, 16000)) || (value.mimeType !== undefined && !str(value.mimeType, 128))) return fail();
  return { ...value, type: 'resource_link' } as ResourceLink;
}
export function decodeResources(value: unknown): ResourceLink[] {
  if (!record(value) || !Array.isArray(value.resources) || value.resources.length > 500) return fail();
  return value.resources.map(decodeResourceLink);
}
function imageData(data: unknown, mime: unknown): string {
  if (!str(data, 1400000) || !data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(mime))) return fail();
  return `data:${mime};base64,${data}`;
}
export function decodeResourceImage(value: unknown): string {
  if (!record(value) || !Array.isArray(value.contents) || value.contents.length !== 1 || !record(value.contents[0])) return fail();
  return imageData(value.contents[0].blob, value.contents[0].mimeType);
}
export function decodeResult(value: unknown): PluginResult {
  if (!record(value) || !Array.isArray(value.content) || value.content.length > 500) return fail();
  const content: PluginContent[] = value.content.map(item => {
    if (!record(item)) return fail();
    if (item.type === 'text' && str(item.text, 1048576)) return { type: 'text', text: item.text };
    if (item.type === 'resource_link') return decodeResourceLink(item);
    if (item.type === 'image') { imageData(item.data, item.mimeType); return { type: 'image', data: item.data as string, mimeType: item.mimeType as string }; }
    // Unsupported blocks stay readable as data and never execute HTML or script.
    return { type: 'text', text: JSON.stringify(item).slice(0, 16000) };
  });
  return { content, ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }), ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {}) };
}
export function parseArguments(value: string): JsonObject {
  if (value.length > 16000) throw new WorkbenchError('PLUGIN_ARGUMENTS_INVALID');
  try { const parsed: unknown = JSON.parse(value); if (record(parsed)) return parsed; } catch { /* Show one safe local error. */ }
  throw new WorkbenchError('PLUGIN_ARGUMENTS_INVALID');
}
export function publicHttps(value: unknown): string | null {
  if (!str(value, 8192)) return null;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* Not a link. */ }
  return null;
}
export function pluginOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}
export function connectionStatusLabel(status: string, text: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    ready: ['可以使用', 'Ready to use'], auth_required: ['需要授权', 'Authorization needed'],
    blocked: ['暂不可用', 'Unavailable'], needs_review: ['有更新待确认', 'Update needs review'],
    revoked: ['已断开', 'Disconnected'],
  };
  return labels[status] ? text(...labels[status]) : text('状态待确认', 'Status unavailable');
}
export function authorizationLabel(status: string, text: (zh: string, en: string) => string): string {
  const labels: Record<string, [string, string]> = {
    none: ['无需单独授权', 'No separate authorization needed'], required: ['等待授权', 'Awaiting authorization'],
    anonymous: ['仅小Q模拟账户', 'Q simulated account only'],
    authorized: ['已授权', 'Authorized'], blocked: ['暂不可授权', 'Authorization unavailable'],
  };
  return labels[status] ? text(...labels[status]) : text('授权状态待确认', 'Authorization status unavailable');
}
export function pluginError(error: unknown, text: (zh: string, en: string) => string): string {
  const code = error instanceof WorkbenchError ? error.code : typeof error === 'string' ? error : 'REQUEST_FAILED';
  const messages: Record<string, [string, string]> = {
    UNAUTHORIZED: ['登录已过期，请重新登录 Q。', 'Your Q session expired. Sign in again.'],
    PLUGIN_AUTH_REQUIRED: ['此插件需要单独授权，Q 登录仍然有效。', 'Authorize this plugin separately. Your Q session is still valid.'],
    PLUGIN_OAUTH_NOT_CONFIGURED: ['服务端尚未配置插件授权回调，请联系管理员。', 'Plugin OAuth hosting is not configured on this server.'],
    PLUGIN_RECONFIRM_REQUIRED: ['插件连接或工具发生变化，请检查并确认更新。', 'The plugin changed. Review and confirm its update.'],
    PLUGIN_ARGUMENTS_INVALID: ['参数必须是有效的 JSON 对象。', 'Arguments must be a valid JSON object.'],
    BANKING_NOT_CONNECTED: ['请先在钱包或银行插件页添加这家银行。', 'Add this bank in Wallet or Bank plugins first.'],
    BANKING_SOURCE_MISMATCH: ['这条对话绑定了另一家银行，请选择付款银行后开始新对话。', 'This chat uses another bank. Select the source bank and start a new chat.'],
    BANKING_INSUFFICIENT_FUNDS: ['模拟账户余额不足，请修改金额后重新提出转账。', 'The simulated account has insufficient funds. Submit a new transfer with another amount.'],
    INSUFFICIENT_FUNDS: ['模拟账户余额不足，请修改金额后重新提出转账。', 'The simulated account has insufficient funds. Submit a new transfer with another amount.'],
    PLUGIN_UNAVAILABLE: ['插件服务暂不可用。', 'Plugin services are unavailable.'],
    MCP_UNSAFE_URL: ['仅支持可公开访问的 HTTPS 插件地址。', 'Use a publicly reachable HTTPS plugin address.'],
    MCP_UNSUPPORTED: ['这个插件要求的协议能力尚未支持。', 'This plugin requires an unsupported capability.'],
    MCP_DISCOVERY_FAILED: ['这个地址没有找到可添加的插件，请检查链接或展开高级选项。', 'No addable plugin was found at this address. Check the link or open Advanced options.'],
    MCP_NETWORK_ERROR: ['暂时无法连接插件，请稍后重新读取；已提交的调用请先查询状态。', 'The plugin is temporarily unreachable. Read it again later; check the status of submitted invocations first.'],
    MCP_TIMEOUT: ['插件响应超时。已提交的调用请查询状态，不要重复执行。', 'The plugin timed out. Check submitted invocations; do not repeat them.'],
    MCP_HTTP_ERROR: ['插件服务暂未正常响应，请稍后重新读取。', 'The plugin service is not responding normally. Read it again later.'],
    MCP_LIMIT_EXCEEDED: ['插件内容超出当前支持范围。已提交的调用请先查询状态，不要重复执行。', 'The plugin content exceeds supported limits. Check submitted invocations; do not repeat them.'],
    MCP_VERSION_UNSUPPORTED: ['此插件暂不支持小Q使用的协议版本。', 'This plugin does not support Q’s protocol version.'],
    MCP_METHOD_UNSUPPORTED: ['此插件暂不提供这项能力。', 'This plugin does not provide this capability.'],
    MCP_INVALID_RESPONSE: ['插件返回的内容不符合协议。', 'The plugin returned an invalid response.'],
    INVALID_RESPONSE: ['暂时无法完整读取插件内容，请查询调用状态或稍后重新读取。', 'The plugin content could not be read completely. Check the invocation status or read it again later.'],
    PLUGIN_DISCOVERY_EXPIRED: ['查找结果已过期，请重新查找这个链接。', 'These discovery results expired. Look up the link again.'],
    PLUGIN_DISCOVERY_LIMIT: ['近期查找较多，请稍后再试。', 'There have been many recent lookups. Try again later.'],
    PLUGIN_CONNECTION_LIMIT: ['已达到当前连接数量上限，请联系管理员。', 'The connection limit has been reached. Contact the administrator.'],
    PLUGIN_IMAGE_DECODE: ['这张图片无法显示，说明与来源仍保留。', 'This image could not be displayed. Its description and attribution are preserved.'],
    PLUGIN_STORAGE_LIMIT: ['历史记录保存空间已满。已有调用仍可查询，请联系管理员整理历史。', 'Plugin history storage is full. Existing invocations remain available; contact the administrator to archive history.'],
    PLUGIN_AUTH_CHANGED: ['插件授权身份已变化，这个旧提案已取消。', 'The plugin authorization changed; this previous proposal was cancelled.'],
    PLUGIN_OAUTH_ATTEMPT_LIMIT: ['授权尝试较多，请完成已有授权或等待其过期。', 'Too many authorization attempts. Complete an existing attempt or wait for it to expire.'],
    NETWORK_ERROR: ['网络连接失败。请先查询调用状态，再决定下一步。', 'Connection failed. Check the invocation status before continuing.'],
    REQUEST_TIMEOUT: ['等待超时。请查询调用状态，不要重复执行。', 'Request timed out. Check its status; do not repeat the action.'],
    CANCELLED: ['请求已停止；已发送的调用请查询状态。', 'Stopped waiting. Check the status of any submitted invocation.'],
  };
  const message = messages[code];
  return message ? text(...message) : text('操作未完成。已提交的调用请先查询状态。', 'The action did not complete. Check the status of any submitted invocation first.');
}
