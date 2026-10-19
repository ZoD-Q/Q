/** Local-only material checks. No fetch, DNS, imports of pasted code, or schema execution.
 * Reviewed 2026-10-19 against:
 * https://github.com/modelcontextprotocol/experimental-ext-server-card/blob/main/schema.ts
 * https://ai-catalog.io/spec/ and backend/docs/plugin-integration.md.
 * Q's concrete HTTPS / 2026-07-28 requirements are stricter than the upstream Card shape.
 */
export type EntryKind = 'card' | 'catalog' | 'page' | 'domain';
export type PluginDraft = {
  title: string;
  description: string;
  name: string;
  version: string;
  cardUrl: string;
  endpointUrl: string;
  needsAuth: boolean;
  hasUi: boolean;
  domainDiscovery: boolean;
  publicListing: boolean;
};
export type Issue = { field: string; level: 'error' | 'warning'; zh: string; en: string };
export type CheckReport = { issues: Issue[]; normalizedUrl?: string };

const CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
const MCP_VERSION = '2026-07-28';
const CARD_MEDIA = 'application/mcp-server-card+json';
const CATALOG_MEDIA = 'application/ai-catalog+json';
const MAX_URL_LENGTH = 4096;
const MAX_JSON_BYTES = 65_536;
const SECRET_KEYS = new Set([
  'apikey', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authorization',
  'auth', 'bearer', 'password', 'passwd', 'secret', 'clientsecret', 'credential',
  'credentials', 'session', 'sessionid', 'signature', 'sig', 'accesskey', 'accesskeyid',
  'secretaccesskey', 'xamzcredential', 'xamzsignature', 'xamzsecuritytoken',
  'xgoogcredential', 'xgoogsignature', 'xgoogsecuritytoken',
]);
const AMBIGUOUS_QUERY_KEYS = new Set(['key', 'code']);
const PRIVATE_KEYS = new Set(['auth', 'authentication', 'authorization', 'oauth', 'oauth2', 'security', 'credentials']);
const RUNTIME_KEYS = new Set(['tools', 'resources', 'prompts', 'capabilities']);
const issue = (field: string, level: Issue['level'], zh: string, en: string): Issue => ({ field, level, zh, en });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasErrors = (issues: Issue[]) => issues.some(item => item.level === 'error');
const keyShape = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const secretValue = (value: string) => /\bBearer\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value);
const localNotice = () => issue('scope', 'warning', '仅做本地语法与关键字段检查；未进行联网、DNS、完整 schema、SSRF 防护或实际连接验证。', 'Local syntax and key-field checks only; no network, DNS, complete schema, SSRF protection, or connection verification.');

function decoded(value: string): string {
  let result = value;
  for (let count = 0; count < 3; count++) {
    try {
      const next = decodeURIComponent(result);
      if (next === result) break;
      result = next;
    } catch { break; }
  }
  return result;
}

function privateIpv4(host: string): boolean {
  const bytes = host.split('.').map(Number);
  if (bytes.length !== 4 || bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = bytes;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

function explicitPrivateHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || /\.(local|internal|lan|home|localdomain)$/.test(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true;
  if (privateIpv4(host)) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || /^(?:f[cd]|fe[89ab]|ff)/.test(host)) return true;
    const embedded = host.match(/^::(?:ffff:)?([a-f0-9]{1,4}):([a-f0-9]{1,4})$/);
    if (embedded) {
      const high = parseInt(embedded[1], 16), low = parseInt(embedded[2], 16);
      return privateIpv4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }
  }
  return false;
}

function credentialQuery(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (SECRET_KEYS.has(keyShape(decoded(key))) || secretValue(decoded(value))) return true;
  }
  return false;
}

function checkUrl(value: unknown, kind: EntryKind, field: string): CheckReport {
  const fail = (zh: string, en: string): CheckReport => ({ issues: [issue(field, 'error', zh, en)] });
  if (typeof value !== 'string' || !value.trim()) return fail('请填写入口地址。', 'Enter an entry address.');
  let input = value.trim();
  if (input.length > MAX_URL_LENGTH) return fail('地址过长，本地检查上限为 4096 个字符。', 'The address exceeds the local 4096-character limit.');
  if (/[\u0000-\u0020\u007f\\]/.test(input) || /%(?![0-9a-f]{2})/i.test(input)) return fail('地址包含空白、控制字符、反斜杠或无效转义。', 'The address contains whitespace, control characters, backslashes, or invalid escapes.');
  if (kind === 'domain' && !/^[a-z][a-z0-9+.-]*:/i.test(input)) input = `https://${input}`;
  if (!/^https:\/\//i.test(input)) return fail('入口必须使用 HTTPS。域名入口可省略 https://。', 'Use HTTPS. A domain entry may omit https://.');
  if (input.includes('#')) return fail('入口不能包含 fragment；请提供不含锚点的完整地址。', 'Entry URLs cannot contain a fragment. Provide the complete URL without an anchor.');
  if (/[{}]/.test(input)) return fail('本地检查只接受具体 HTTPS 地址，暂不处理 URL 模板。', 'This local check accepts concrete HTTPS URLs, not URL templates.');
  const parts = input.match(/^https:\/\/([^/?#]*)([^#]*)$/i);
  if (!parts || !parts[1]) return fail('HTTPS 地址必须显式包含有效主机。', 'The HTTPS URL must explicitly contain a valid host.');
  if (parts[1].includes('@')) return fail('入口不能包含用户名或密码。', 'Entry URLs cannot include user information.');
  let parsed: URL;
  try { parsed = new URL(input); } catch { return fail('无法解析此 HTTPS 地址。', 'This HTTPS address could not be parsed.'); }
  if (!parsed.hostname || parsed.username || parsed.password) return fail('入口必须包含有效主机，且不能附带凭据。', 'Provide a valid host without embedded credentials.');
  if (explicitPrivateHost(parsed.hostname)) return fail('本地检查不接受显式回环、内网或本机地址；这不替代服务器端 SSRF 防护。', 'Explicit loopback, private, and local addresses are not accepted; this does not replace server-side SSRF protection.');
  if (credentialQuery(parsed)) {
    return fail('查询参数疑似包含凭据。请移除凭据，不要粘贴真实令牌或密码。', 'A query parameter appears to contain credentials. Remove secrets; do not paste real tokens or passwords.');
  }
  const suffix = parts[2];
  if (kind === 'domain' && suffix !== '' && suffix !== '/') return fail('域名入口仅接受域名和可选的根斜杠。具体路径或查询请改选 Card、Catalog 或介绍页，不会自动丢弃。', 'Domain entries accept only a host and optional root slash. Use Card, Catalog, or Page for a path or query; these are never silently discarded.');
  // Preserve raw path case, trailing slash, escape spelling, query ordering and duplicates.
  const normalizedUrl = `${parsed.origin}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  const ambiguous = [...parsed.searchParams.keys()].some(key => AMBIGUOUS_QUERY_KEYS.has(keyShape(decoded(key))));
  const issues = ambiguous ? [issue(field, 'warning', '部分查询参数既可能用于普通业务，也可能携带凭据；请确认它们不是凭据或私有数据。原值与顺序保持不变。', 'Some query parameters may represent ordinary business values or credentials. Confirm they contain no credentials or private data. Values and order are preserved.')] : [];
  return { issues, normalizedUrl };
}

export function inspectEntry(value: string, kind: EntryKind): CheckReport {
  if (!['card', 'catalog', 'page', 'domain'].includes(kind)) return { issues: [issue('kind', 'error', '请选择支持的入口类型。', 'Choose a supported entry type.'), localNotice()] };
  const report = checkUrl(value, kind, 'entry');
  return { ...report, issues: [...report.issues, localNotice()] };
}

function checkText(value: unknown, field: string, min: number, max: number, issues: Issue[]) {
  if (typeof value !== 'string' || value.trim().length < min || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    issues.push(issue(field, 'error', `此字段须为 ${min}–${max} 字符的非空文本，不能包含控制字符。`, `Use nonempty text of ${min}–${max} characters without control characters.`));
  } else if (secretValue(value)) issues.push(issue(field, 'error', '此字段疑似含有密钥或令牌，请勿粘贴真实凭据。', 'This field appears to contain a secret or token. Do not paste real credentials.'));
}

function checkIdentity(card: Record<string, unknown>, issues: Issue[]) {
  checkText(card.name, 'name', 3, 200, issues);
  if (typeof card.name === 'string' && !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(card.name)) issues.push(issue('name', 'error', '服务名须采用反向域名/服务名形式，且只含一个斜杠。', 'Use reverse-DNS namespace/server-name syntax with exactly one slash.'));
  checkText(card.version, 'version', 1, 255, issues);
  if (typeof card.version === 'string') {
    if (/[~^<>=*]|\|\||(?:^|\.)x(?:\.|$)|\s+-\s+/i.test(card.version)) issues.push(issue('version', 'error', '请填写具体服务版本，不使用版本范围或通配符。', 'Provide a concrete service version, not a range or wildcard.'));
    else if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(card.version)) issues.push(issue('version', 'warning', '此版本不是常见 SemVer 格式；Card 允许具体非语义版本，但排序可能不稳定。', 'This is not a common SemVer form. Concrete non-semantic versions are allowed, but sorting may be unpredictable.'));
  }
  checkText(card.description, 'description', 1, 100, issues);
  if ('title' in card) checkText(card.title, 'title', 1, 100, issues);
}

function utf8Size(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_JSON_BYTES) break;
  }
  return bytes;
}

function inspectSensitiveTree(value: unknown, issues: Issue[]) {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 4000 || item.depth > 32) {
      issues.push(issue('json', 'error', 'JSON 结构过深或节点过多，超出本地检查范围。', 'JSON nesting or node count exceeds the local check limits.'));
      return;
    }
    let sensitiveUrl = false;
    if (typeof item.value === 'string' && /^https?:\/\//i.test(item.value)) {
      try {
        const url = new URL(item.value);
        sensitiveUrl = !!url.username || !!url.password || credentialQuery(url);
      } catch { /* Optional fields are not complete schema validation. */ }
    }
    if (typeof item.value === 'string' && (secretValue(item.value) || sensitiveUrl)) {
      issues.push(issue('json', 'error', 'JSON 中疑似包含真实凭据；检查结果不会回显该内容。', 'The JSON appears to contain a credential; it is not echoed in this report.'));
      return;
    }
    if (Array.isArray(item.value)) pending.push(...item.value.map(entry => ({ value: entry, depth: item.depth + 1 })));
    else if (isObject(item.value)) {
      for (const [key, entry] of Object.entries(item.value)) {
        const normalizedKey = keyShape(key);
        if (PRIVATE_KEYS.has(normalizedKey) || SECRET_KEYS.has(normalizedKey)) {
          issues.push(issue('json', 'error', 'Card 不应包含授权配置或凭据，授权信息通过标准发现机制取得。', 'A Card must not embed authorization configuration or credentials; use standard authorization discovery.'));
          return;
        }
        pending.push({ value: entry, depth: item.depth + 1 });
      }
    }
  }
}

export function inspectCardJson(source: string): CheckReport {
  const issues: Issue[] = [localNotice()];
  if (typeof source !== 'string' || !source.trim()) return { issues: [...issues, issue('json', 'error', '请粘贴 Server Card JSON。', 'Paste Server Card JSON.')] };
  if (source.length > MAX_JSON_BYTES || utf8Size(source) > MAX_JSON_BYTES) return { issues: [...issues, issue('json', 'error', 'Card JSON 不能超过 64 KiB。', 'Card JSON must not exceed 64 KiB.')] };
  let card: unknown;
  try { card = JSON.parse(source); } catch { return { issues: [...issues, issue('json', 'error', 'JSON 格式无效；不会执行或修复输入内容。', 'Invalid JSON. Input is never executed or automatically repaired.')] }; }
  if (!isObject(card)) return { issues: [...issues, issue('json', 'error', 'Server Card 顶层必须是 JSON 对象。', 'The Server Card root must be a JSON object.')] };
  if (card.$schema !== CARD_SCHEMA) issues.push(issue('$schema', 'error', '请使用固定的 MCP Server Card v1 schema 地址。', 'Use the pinned MCP Server Card v1 schema URL.'));
  checkIdentity(card, issues);
  for (const field of RUNTIME_KEYS) if (field in card) issues.push(issue(field, 'error', 'Card 只描述身份与连接，不列出工具、资源、提示词或运行时能力。', 'Cards describe identity and connection, not tools, resources, prompts, or runtime capabilities.'));
  inspectSensitiveTree(card, issues);
  if (card.websiteUrl !== undefined) issues.push(...checkUrl(card.websiteUrl, 'page', 'websiteUrl').issues);
  if (!Array.isArray(card.remotes) || card.remotes.length === 0) issues.push(issue('remotes', 'error', 'Q 接入要求至少一个兼容的远程端点。', 'Q requires at least one compatible remote endpoint.'));
  else {
    let compatible = false;
    card.remotes.forEach((remote: unknown, index: number) => {
      const field = `remotes[${index}]`;
      if (!isObject(remote)) { issues.push(issue(field, 'error', '远程端点必须是对象。', 'A remote endpoint must be an object.')); return; }
      const url = checkUrl(remote.url, 'card', `${field}.url`);
      issues.push(...url.issues);
      if (remote.type !== 'streamable-http' && remote.type !== 'sse') issues.push(issue(`${field}.type`, 'error', '远程传输类型无效。Q 要求 Streamable HTTP。', 'Invalid remote transport type. Q requires Streamable HTTP.'));
      else if (remote.type === 'sse') issues.push(issue(`${field}.type`, 'warning', '此 SSE 端点不符合 Q 选定传输，需要另有兼容的 Streamable HTTP 端点。', 'This SSE endpoint is not Q’s selected transport; provide a compatible Streamable HTTP endpoint.'));
      const versions = remote.supportedProtocolVersions;
      if (versions === undefined) issues.push(issue(`${field}.supportedProtocolVersions`, 'warning', '此端点未声明协议版本，不能据此确认 Q 兼容；Card v1 允许省略，但仍需另有明确兼容的端点。', 'This endpoint declares no protocol versions, so Q compatibility is unconfirmed. Card v1 permits omission, but another explicitly compatible endpoint is required.'));
      else if (!Array.isArray(versions) || versions.some(version => typeof version !== 'string' || !version.trim())) issues.push(issue(`${field}.supportedProtocolVersions`, 'error', '提供协议版本时，须使用字符串数组，版本值不能为空。', 'When provided, supported protocol versions must be an array of nonempty strings.'));
      else if (versions.length === 0) issues.push(issue(`${field}.supportedProtocolVersions`, 'warning', '此端点的协议版本列表为空，不能据此确认 Q 兼容。', 'This endpoint lists no protocol versions, so Q compatibility is unconfirmed.'));
      else if (remote.type === 'streamable-http' && versions.includes(MCP_VERSION) && !hasErrors(url.issues)) compatible = true;
      if (remote.headers !== undefined || remote.variables !== undefined) issues.push(issue(field, 'warning', '本地检查不验证 headers/variables 的完整结构与运行时替换；不得在其中存放真实凭据。', 'This check does not fully validate headers/variables or runtime substitution; never embed real credentials.'));
      if (Array.isArray(remote.headers) && remote.headers.some(header => isObject(header) && typeof header.name === 'string' && (SECRET_KEYS.has(keyShape(header.name)) || keyShape(header.name) === 'cookie'))) issues.push(issue(`${field}.headers`, 'error', 'Card 不应配置凭据请求头，请通过标准授权发现取得授权信息。', 'Cards must not configure credential headers. Obtain authorization information through standard discovery.'));
    });
    if (!compatible) issues.push(issue('remotes', 'error', '需要具体 HTTPS Streamable HTTP 端点，并声明支持 MCP 2026-07-28。', 'Provide a concrete HTTPS Streamable HTTP endpoint declaring MCP 2026-07-28 support.'));
  }
  const known = new Set(['$schema', 'name', 'version', 'description', 'title', 'websiteUrl', 'repository', 'icons', 'remotes', '_meta', ...RUNTIME_KEYS, ...PRIVATE_KEYS]);
  if (Object.keys(card).some(key => !known.has(key))) issues.push(issue('json', 'warning', '存在本地检查未覆盖的字段，请用锁定的 v1 schema 另行验证。', 'Some fields are outside these local checks. Validate separately against the pinned v1 schema.'));
  return { issues };
}

function catalogLocation(cardUrl: string, endpointUrl: string, domainDiscovery: boolean): { url: string; collision: boolean } {
  const parsed = new URL(cardUrl);
  const occupied = new Set([new URL(cardUrl).href, new URL(endpointUrl).href]);
  if (domainDiscovery) {
    const url = `${parsed.origin}/.well-known/ai-catalog.json`;
    return { url, collision: occupied.has(new URL(url).href) };
  }
  const suffix = cardUrl.slice(parsed.origin.length);
  const split = suffix.indexOf('?');
  const path = split < 0 ? suffix : suffix.slice(0, split);
  const query = split < 0 ? '' : suffix.slice(split);
  const directory = path.slice(0, path.lastIndexOf('/') + 1);
  let index = 1;
  let url: string;
  do {
    const filename = index === 1 ? 'catalog.json' : `catalog-${index}.json`;
    url = `${parsed.origin}${directory}${filename}${query}`;
    index++;
  } while (occupied.has(new URL(url).href));
  return { url, collision: false };
}

export function inspectDraft(draft: PluginDraft): Issue[] {
  if (!isObject(draft)) return [issue('draft', 'error', '请填写插件材料表单。', 'Complete the plugin material form.'), localNotice()];
  const issues: Issue[] = [localNotice()];
  checkIdentity(draft, issues);
  if (!Object.prototype.hasOwnProperty.call(draft, 'title')) checkText(undefined, 'title', 1, 100, issues);
  const card = checkUrl(draft.cardUrl, 'card', 'cardUrl');
  const endpoint = checkUrl(draft.endpointUrl, 'card', 'endpointUrl');
  issues.push(...card.issues, ...endpoint.issues);
  for (const field of ['needsAuth', 'hasUi', 'domainDiscovery', 'publicListing'] as const) {
    if (typeof draft[field] !== 'boolean') issues.push(issue(field, 'error', '此选项必须为布尔值。', 'This option must be a boolean.'));
  }
  if (card.normalizedUrl && endpoint.normalizedUrl && new URL(card.normalizedUrl).origin !== new URL(endpoint.normalizedUrl).origin) issues.push(issue('endpointUrl', 'warning', 'Card 与 MCP 端点跨来源；部署时须分别校验来源，不能转交或复用另一来源的凭据。', 'The Card and MCP endpoint have different origins. Validate each separately and never forward or reuse cross-origin credentials.'));
  if (draft.domainDiscovery && card.normalizedUrl && endpoint.normalizedUrl && catalogLocation(card.normalizedUrl, endpoint.normalizedUrl, true).collision) issues.push(issue('domainDiscovery', 'error', '根 Catalog 的固定地址与 Card 或 MCP 端点重合，请修改对应服务地址；不会自动改写 well-known 路径。', 'The fixed root Catalog URL collides with the Card or MCP endpoint. Change the service address; the well-known path is never silently changed.'));
  if (draft.publicListing && card.normalizedUrl && new URL(card.normalizedUrl).search) issues.push(issue('publicListing', 'warning', '公开收录前确认查询参数不是用户、租户私有配置；参数不会被自动删除。', 'Before public listing, confirm query parameters are not private user or tenant configuration. They are not automatically removed.'));
  return issues;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function createMaterials(draft: PluginDraft): { card: string; catalog: string; intro: string; checklistZh: string; checklistEn: string } {
  if (hasErrors(inspectDraft(draft))) throw new Error('INVALID_PLUGIN_DRAFT');
  const cardUrl = checkUrl(draft.cardUrl, 'card', 'cardUrl').normalizedUrl!;
  const endpointUrl = checkUrl(draft.endpointUrl, 'card', 'endpointUrl').normalizedUrl!;
  const catalogUrl = catalogLocation(cardUrl, endpointUrl, draft.domainDiscovery).url;
  const card = JSON.stringify({ $schema: CARD_SCHEMA, name: draft.name, title: draft.title, version: draft.version, description: draft.description, remotes: [{ type: 'streamable-http', url: endpointUrl, supportedProtocolVersions: [MCP_VERSION] }] }, null, 2);
  // An absolute Card URL is a standard Catalog identifier and keeps query-scoped identities distinct.
  const catalog = JSON.stringify({ specVersion: '1.0', entries: [{ identifier: cardUrl, type: CARD_MEDIA, url: cardUrl }] }, null, 2);
  const intro = `<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${html(draft.title)}</title>\n  <link rel="ai-catalog" type="${CATALOG_MEDIA}" href="${html(catalogUrl)}">\n</head>\n<body>\n  <h1>${html(draft.title)}</h1>\n  <p>${html(draft.description)}</p>\n  <p>本地生成材料，尚未部署或验证连接。 / Generated locally; not deployed or connection-verified.</p>\n  <a href="${html(cardUrl)}">Server Card</a>\n</body>\n</html>`;
  const zh = [
    '以下为待办清单，生成材料不等于部署、授权、接入或公开收录成功。',
    `部署独立稳定 Card：${cardUrl}；响应类型 ${CARD_MEDIA}；用锁定的 v1 schema 完整验证。`,
    `部署 MCP 端点：${endpointUrl}；使用 HTTPS Streamable HTTP 与 MCP ${MCP_VERSION}，按逐请求版本模型实现，不把旧 initialize 握手只换日期。`,
    'Q 先按所需身份完成授权，再调用 server/discover；实际能力、输入输出、文本结果、权限和未知写操作恢复都须真实联调。',
    `Catalog 示例部署位置：${catalogUrl}；类型 ${CATALOG_MEDIA}、specVersion 1.0。可调整具体位置，但介绍页声明与真实部署必须一致。`,
    draft.domainDiscovery ? '已选择域名发现：必须发布根 /.well-known/ai-catalog.json；多个服务应让用户选择。' : '未选择域名发现：不要求根 Catalog。生成的单插件 Catalog 可用于介绍页或按需分享。',
    draft.needsAuth ? '需要身份：采用 MCP 授权和 Protected Resource Metadata；Q 客户端及授权服务器双方支持 CIMD，按连接/用户/资源绑定凭据，不把 OAuth 配置写入 Card。' : '未选择账户登录；仍须按真实业务校验权限。将来需要身份时采用 MCP 授权、Protected Resource Metadata 与双方 CIMD。',
    draft.hasUi ? '提供界面：实现 MCP Apps 2026-01-26，工具 _meta.ui.resourceUri 指向 ui:// 资源，resources/read 返回 text/html;profile=mcp-app；独立 ui/initialize、宿主沙箱/CSP和文本降级，UI 失败不重执行业务。' : '未选择 Apps 界面：工具仍提供可理解文本；以后增加 UI 时采用标准 MCP Apps，不把工具文本直接执行为 HTML。',
    draft.publicListing ? '申请公开索引：发布者须主动将通用 Card 列入自己的公开 Catalog；来源校验、独立匿名抓取、robots.txt 与 X-Robots-Tag: noindex 均需检查，私有连接/能力/结果不得公开。' : '未选择公开索引：个人添加与公共收录分开；不因生成 Catalog 自动创建公共条目。',
    '四类入口分开验证；保留具体路径与有效查询。添加、授权、执行分开；不按 name 合并服务或权限。开发者账号、Registry 注册和人工审核不是接入前置门槛。',
    '真实联网前逐次检查 DNS、实际连接和重定向的目标、超时与体积；本地地址检查不证明可达、可信或 SSRF 安全。',
    '分别记录：网页部署、MCP 可连接、授权完成、Q 联调、真实业务验证；当前均未由此工具验证。',
  ];
  const en = [
    'This is a to-do checklist. Generated materials do not prove deployment, authorization, integration, or public listing.',
    `Deploy the stable Card at ${cardUrl}; serve ${CARD_MEDIA}; validate against the complete pinned v1 schema.`,
    `Deploy ${endpointUrl} with HTTPS Streamable HTTP and MCP ${MCP_VERSION}; use the per-request version model, not an old initialize handshake with a changed date.`,
    'Q obtains any required authorization before server/discover. Verify runtime capabilities, schemas, text results, permissions, and recovery of uncertain writes with real integration tests.',
    `Example Catalog location: ${catalogUrl}; use ${CATALOG_MEDIA} and specVersion 1.0. If the location changes, update the introduction page declaration to match.`,
    draft.domainDiscovery ? 'Domain discovery selected: publish /.well-known/ai-catalog.json at the origin root and let users choose among multiple services.' : 'Domain discovery not selected: a root Catalog is not required. The generated per-plugin Catalog can support the introduction page or optional sharing.',
    draft.needsAuth ? 'Identity required: implement MCP authorization and Protected Resource Metadata, with CIMD supported by both the Q client and authorization server. Bind credentials to user/connection/resource; do not embed OAuth configuration in the Card.' : 'Account sign-in not selected: applicable business permissions still apply. If identity is later required, use MCP authorization, Protected Resource Metadata, and CIMD on both sides.',
    draft.hasUi ? 'UI selected: implement MCP Apps 2026-01-26 with a tool _meta.ui.resourceUri, ui:// resources via resources/read, text/html;profile=mcp-app, separate ui/initialize, host sandbox/CSP, and text fallback. UI failure must not repeat business execution.' : 'Apps UI not selected: tools still return understandable text. A later UI must use standard MCP Apps; never execute tool text as HTML.',
    draft.publicListing ? 'Public indexing selected: the publisher must list the generic Card in its own public Catalog. Verify publisher origin, independent anonymous retrieval, robots.txt and X-Robots-Tag: noindex. Never index private connections, capabilities, or results.' : 'Public indexing not selected: personal addition and public listing remain separate. Generating a Catalog does not create a public entry.',
    'Verify all four entry kinds while preserving paths and meaningful queries. Keep adding, authorizing, and executing separate; never merge permissions by name. Developer accounts, Registry registration, and manual review are not prerequisites.',
    'Before networking, validate DNS, actual connections, redirects, timeout and size limits. Local URL checks do not establish reachability, trust, or SSRF safety.',
    'Report webpage deployment, MCP connectivity, authorization, Q integration, and real business verification separately. None is verified by this tool.',
  ];
  return { card, catalog, intro, checklistZh: zh.map(line => `- ${line}`).join('\n'), checklistEn: en.map(line => `- ${line}`).join('\n') };
}
