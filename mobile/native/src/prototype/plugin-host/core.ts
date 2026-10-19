import { WorkbenchError } from '../api-workbench/core';

export type JsonObject = Record<string, unknown>;
export type PluginConnection = {
  id: string; card_url: string; name: string; title: string; description: string; version: string;
  endpoint_url: string; revision: number; status: string; auth_status: string; last_error_code: string | null;
  created_at: string; updated_at: string; pending_update: boolean; pending_update_details?: unknown;
};
export type PluginTool = { name: string; title?: string | null; description: string; inputSchema: JsonObject; outputSchema?: unknown; annotations?: unknown; _meta?: unknown };
export type Candidate = { candidate_id: string; card_url: string; endpoint_url: string; name: string; title: string; description: string; version: string };
export type Discovery = { discovery_id: string; expires_at: string; candidates: Candidate[] };
export type PluginInvocation = { id: string; connection_id: string; connection_revision: number; connection_title: string; card_url: string; endpoint_url: string; tool_name: string; arguments: JsonObject; status: string; result: unknown; error_code: string | null; created_at: string; updated_at: string; expires_at: string };
export type ResourceLink = { type: 'resource_link'; uri: string; name: string; title?: string; description?: string; mimeType?: string };
export type PluginContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string } | ResourceLink;
export type PluginResult = { content: PluginContent[]; structuredContent?: unknown; isError?: boolean };
export const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const str = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const toolName = (value: unknown): value is string => str(value, 512) && value.length > 0 && Array.from(value).length <= 128;
const fail = (): never => { throw new WorkbenchError('INVALID_RESPONSE'); };
const nullable = (value: unknown): value is string | null => value === null || str(value);
export function decodePluginStatus(value: unknown) {
  if (!record(value) || typeof value.available !== 'boolean' || typeof value.oauth_configured !== 'boolean' || !str(value.protocol_version, 30)) return fail();
  return { available: value.available, oauth_configured: value.oauth_configured, protocol_version: value.protocol_version };
}
export function decodePluginConnection(value: unknown): PluginConnection {
  if (!record(value) || !isUuid(value.id) || !['card_url', 'name', 'title', 'description', 'version', 'endpoint_url', 'status', 'auth_status', 'created_at', 'updated_at'].every(key => str(value[key], 16000)) || !Number.isSafeInteger(value.revision) || typeof value.pending_update !== 'boolean' || !nullable(value.last_error_code)) return fail();
  return value as PluginConnection;
}
export function decodeTool(value: unknown): PluginTool {
  if (!record(value) || !toolName(value.name) || !str(value.description, 16000) || !record(value.inputSchema) || (value.title !== undefined && value.title !== null && !str(value.title, 1024))) return fail();
  return value as PluginTool;
}
export function decodeDiscovery(value: unknown): Discovery {
  if (!record(value) || !isUuid(value.discovery_id) || !str(value.expires_at, 64) || !Array.isArray(value.candidates) || value.candidates.length > 100) return fail();
  for (const item of value.candidates) if (!record(item) || !isUuid(item.candidate_id) || !['card_url', 'endpoint_url', 'name', 'title', 'description', 'version'].every(key => str(item[key], 16000))) return fail();
  return value as Discovery;
}
export function decodeInvocation(value: unknown): PluginInvocation {
  if (!record(value) || !isUuid(value.id) || !isUuid(value.connection_id) || !Number.isSafeInteger(value.connection_revision) || !str(value.connection_title) || !str(value.card_url) || !str(value.endpoint_url) || !str(value.expires_at, 64) || !toolName(value.tool_name) || !record(value.arguments) || !str(value.status, 64) || !nullable(value.error_code) || !str(value.created_at, 64) || !str(value.updated_at, 64)) return fail();
  if (!['awaiting_confirmation', 'running', 'succeeded', 'tool_error', 'failed', 'unknown', 'cancelled', 'expired', 'input_required'].includes(value.status)) return fail();
  return value as PluginInvocation;
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
export function pluginError(error: unknown, text: (zh: string, en: string) => string): string {
  const code = error instanceof WorkbenchError ? error.code : typeof error === 'string' ? error : 'REQUEST_FAILED';
  const messages: Record<string, [string, string]> = {
    UNAUTHORIZED: ['登录已过期，请重新登录 Q。', 'Your Q session expired. Sign in again.'],
    PLUGIN_AUTH_REQUIRED: ['此插件需要单独授权，Q 登录仍然有效。', 'Authorize this plugin separately. Your Q session is still valid.'],
    PLUGIN_OAUTH_NOT_CONFIGURED: ['服务端尚未配置插件授权回调，请联系管理员。', 'Plugin OAuth hosting is not configured on this server.'],
    PLUGIN_RECONFIRM_REQUIRED: ['插件连接或工具发生变化，请检查并确认更新。', 'The plugin changed. Review and confirm its update.'],
    PLUGIN_ARGUMENTS_INVALID: ['参数必须是有效的 JSON 对象。', 'Arguments must be a valid JSON object.'],
    PLUGIN_UNAVAILABLE: ['插件服务暂不可用。', 'Plugin services are unavailable.'],
    MCP_UNSAFE_URL: ['仅支持可公开访问的 HTTPS 插件地址。', 'Use a publicly reachable HTTPS plugin address.'],
    MCP_UNSUPPORTED: ['这个插件要求的协议能力尚未支持。', 'This plugin requires an unsupported capability.'],
    MCP_INVALID_RESPONSE: ['插件返回的内容不符合协议。', 'The plugin returned an invalid response.'],
    PLUGIN_IMAGE_DECODE: ['这张图片无法显示，说明与来源仍保留。', 'This image could not be displayed. Its description and attribution are preserved.'],
    PLUGIN_STORAGE_LIMIT: ['历史记录保存空间已满。已有调用仍可查询，请联系管理员整理历史。', 'Plugin history storage is full. Existing invocations remain available; contact the administrator to archive history.'],
    PLUGIN_AUTH_CHANGED: ['插件授权身份已变化，这个旧提案已取消。', 'The plugin authorization changed; this previous proposal was cancelled.'],
    PLUGIN_OAUTH_ATTEMPT_LIMIT: ['授权尝试较多，请完成已有授权或等待其过期。', 'Too many authorization attempts. Complete an existing attempt or wait for it to expire.'],
    NETWORK_ERROR: ['网络连接失败。请先查询调用状态，再决定下一步。', 'Connection failed. Check the invocation status before continuing.'],
    REQUEST_TIMEOUT: ['等待超时。请查询调用状态，不要重复执行。', 'Request timed out. Check its status; do not repeat the action.'],
    CANCELLED: ['请求已停止；已发送的调用请查询状态。', 'Stopped waiting. Check the status of any submitted invocation.'],
  };
  const message = messages[code];
  return message ? text(...message) : text(`操作未完成（${code}）。`, `The action did not complete (${code}).`);
}
