import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectEntry, inspectCardJson, inspectDraft, createMaterials, normalizeOwnerName, OWNER_META_KEY } from './materials.ts';

const schema = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';
const errorIssues = report => (Array.isArray(report) ? report : report.issues).filter(issue => issue.level === 'error');
const draft = (patch = {}) => ({
  title: 'Calendar helper', description: 'Find free time and create calendar events.',
  name: 'example.acme/calendar', version: '1.0.0',
  cardUrl: 'https://Acme.Example/Plugins/Calendar/server-card?tenant=public&a=2&a=1',
  endpointUrl: 'https://acme.example/MCP/Calendar/?workspace=public&mode=read',
  needsAuth: false, hasUi: false, domainDiscovery: false, publicListing: false, ...patch,
});
const validCard = (patch = {}) => ({
  $schema: schema, name: 'example.acme/calendar', title: 'Calendar', version: '1.0.0',
  description: 'Calendar planning.',
  remotes: [{ type: 'streamable-http', url: 'https://acme.example/MCP?tenant=public', supportedProtocolVersions: ['2026-07-28'] }],
  ...patch,
});

test('all four entry kinds work without claiming a network or schema validation', () => {
  for (const kind of ['card', 'catalog', 'page']) {
    const report = inspectEntry('https://Example.com/Path/Case/?id=one&id=two&tenant=public', kind);
    assert.equal(errorIssues(report).length, 0);
    assert.equal(report.normalizedUrl, 'https://example.com/Path/Case/?id=one&id=two&tenant=public');
    assert.ok(report.issues.some(issue => issue.level === 'warning' && issue.en.includes('no network')));
  }
  assert.equal(inspectEntry('Example.com', 'domain').normalizedUrl, 'https://example.com/');
  assert.equal(inspectEntry('https://Example.com/', 'domain').normalizedUrl, 'https://example.com/');
});

test('auto checks preserve full URLs and never infer Card type or remove a supplied path', () => {
  const url='https://Example.com/Specific/Entry/?tenant=A&tag=b&tag=a';
  const report=inspectEntry(url,'auto');
  assert.equal(errorIssues(report).length,0);
  assert.equal(report.normalizedUrl,'https://example.com/Specific/Entry/?tenant=A&tag=b&tag=a');
  assert.ok(report.issues.some(item=>item.field==='scope'&&item.level==='warning'));
  assert.equal(inspectEntry('example.com','auto').normalizedUrl,'https://example.com/');
  assert.ok(errorIssues(inspectEntry('example.com/specific/path','auto')).length);
  assert.ok(errorIssues(inspectEntry(url,'domain')).length);
  assert.equal(report.kind,undefined,'local checks do not pretend to identify the remote media type');
});

test('owner names are optional display claims with Unicode and control limits',()=>{
  assert.equal(normalizeOwnerName('  Example Studio  '),'Example Studio');
  assert.equal(normalizeOwnerName('😀'.repeat(80)),'😀'.repeat(80));
  for(const value of [undefined,null,42,{},'', ' ', 'x'.repeat(81),'😀'.repeat(81),'hello\nworld','\towner','owner\u202e','owner\u2067','owner\u200f'])assert.equal(normalizeOwnerName(value),null);
  assert.equal(errorIssues(inspectDraft(draft())).length,0);
  assert.equal(errorIssues(inspectDraft(draft({ownerName:'   '}))).length,0);
  for(const ownerName of [42,'x'.repeat(81),'owner\n','owner\u202e','owner\u2066'])assert.ok(errorIssues(inspectDraft(draft({ownerName}))).some(item=>item.field==='ownerName'));
});

test('owner metadata round-trips and generated HTML escapes the publisher claim',()=>{
  const ownerName='Studio <Q> & "Friends"';
  const generated=createMaterials(draft({ownerName:` ${ownerName} `}));
  const card=JSON.parse(generated.card);
  assert.deepEqual(card._meta[OWNER_META_KEY],{name:ownerName});
  assert.equal(card.owner,undefined);
  assert.equal(errorIssues(inspectCardJson(generated.card)).length,0);
  assert.match(generated.intro,/Studio &lt;Q&gt; &amp; &quot;Friends&quot;/);
  assert.match(generated.intro,/Publisher-declared, not verified/);
  assert.equal(JSON.parse(createMaterials(draft()).card)._meta,undefined);
  for(const owner of [{name:'bad\u202e'}, {name:''}, {name:44}, 'someone', null]){
    const report=inspectCardJson(JSON.stringify(validCard({_meta:{[OWNER_META_KEY]:owner,'com.example/info':{note:'kept'}}})));
    assert.equal(errorIssues(report).length,0,'invalid remote owner must not reject a standard Card');
    assert.ok(report.issues.some(item=>item.field==='ownerName'&&item.level==='warning'));
  }
});

test('domain mode never drops a supplied specific path or query', () => {
  for (const value of ['example.com/Card', 'https://example.com/Card', 'example.com?tenant=a', 'https://example.com//']) {
    const report = inspectEntry(value, 'domain');
    assert.ok(errorIssues(report).length > 0);
    assert.equal(report.normalizedUrl, undefined);
  }
});

test('normalization preserves identity-sensitive queries, escape spelling, and trailing slashes', () => {
  const url = 'HTTPS://EXAMPLE.COM:443/Team/A%2fb/../Card/?tenantId=AbC&identity=one&profile=Public&x=1&x=2&q=a+b%20c';
  assert.equal(inspectEntry(url, 'card').normalizedUrl, 'https://example.com/Team/A%2fb/../Card/?tenantId=AbC&identity=one&profile=Public&x=1&x=2&q=a+b%20c');
  assert.notEqual(inspectEntry('https://example.com/Card?a=1&a=2', 'card').normalizedUrl, inspectEntry('https://example.com/Card?a=2&a=1', 'card').normalizedUrl);
  assert.notEqual(inspectEntry('https://example.com/Card', 'card').normalizedUrl, inspectEntry('https://example.com/Card/', 'card').normalizedUrl);
});

test('empty, malformed, non-HTTPS, user-info and fragment entries fail safely', () => {
  for (const value of ['', ' ', 'https://', 'https:///example.com', 'https:////example.com', 'plain-domain.example', 'http://example.com', 'file:///a', 'javascript:alert(1)', 'https://user:pass@example.com/Card', 'https://@example.com/Card', 'https://example.com/Card#', 'https://example.com/Card#part', 'https://example.com/a b', 'https://example.com/a\\b', 'https://example.com/%zz', 'https://example.com/{tenant}', 'https://example.com/' + 'a'.repeat(4096)]) {
    const report = inspectEntry(value, 'card');
    assert.ok(errorIssues(report).length > 0, `Expected invalid case ${value.slice(0, 32)}`);
    assert.equal(report.normalizedUrl, undefined);
  }
  assert.ok(errorIssues(inspectEntry('https://example.com', 'unsupported')).length > 0);
});

test('credential query keys and recognizable secret values are rejected without reflection', () => {
  const secret = 'SECRET_VALUE_DO_NOT_ECHO';
  for (const key of ['token', 'access_token', 'api-key', 'Authorization', 'password', 'client_secret', 'X-Amz-Signature', 'access%255ftoken']) {
    const report = inspectEntry(`https://example.com/Card?${key}=${secret}`, 'card');
    assert.ok(errorIssues(report).length > 0);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(report.normalizedUrl, undefined);
  }
  assert.ok(errorIssues(inspectEntry('https://example.com/Card?identity=Bearer%20SECRET_VALUE_DO_NOT_ECHO', 'card')).length > 0);
  assert.ok(errorIssues(inspectEntry('https://example.com/Card?q=sk-1234567890123456', 'card')).length > 0);
});

test('ordinary key/code queries are preserved with a warning instead of rejected', () => {
  const url = 'https://example.com/Card?key=calendar&code=zh&key=shared&mode=read';
  const report = inspectEntry(url, 'card');
  assert.equal(errorIssues(report).length, 0);
  assert.equal(report.normalizedUrl, url);
  assert.ok(report.issues.some(issue => issue.field === 'entry' && issue.level === 'warning' && issue.en.includes('ordinary business')));
  const card = validCard({ websiteUrl: url, _meta: { reference: url } });
  card.remotes[0].url = url;
  const checked = inspectCardJson(JSON.stringify(card));
  assert.equal(errorIssues(checked).length, 0);
  assert.ok(checked.issues.some(issue => issue.field === 'remotes[0].url' && issue.level === 'warning'));
  const material = createMaterials(draft({ cardUrl: url, endpointUrl: url }));
  assert.equal(JSON.parse(material.catalog).entries[0].url, url);
  assert.equal(JSON.parse(material.card).remotes[0].url, url);
});

test('generic key/code parameters still reject recognizable credential values', () => {
  for (const key of ['key', 'code', 'k%65y', 'co%64e']) {
    const secret = 'sk-DO_NOT_ECHO_123456';
    const url = `https://example.com/Card?${key}=${secret}`;
    const report = inspectEntry(url, 'card');
    assert.ok(errorIssues(report).length > 0);
    assert.equal(report.normalizedUrl, undefined);
    assert.equal(JSON.stringify(report).includes(secret), false);
    const checked = inspectCardJson(JSON.stringify(validCard({ _meta: { reference: url } })));
    assert.ok(errorIssues(checked).length > 0);
    assert.equal(JSON.stringify(checked).includes(secret), false);
  }
});

test('explicit private and loopback forms are rejected without DNS', () => {
  for (const host of ['localhost', 'localhost.', 'local.localhost', 'dev.local', 'metadata.internal', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '[::]', '[::1]', '[fc00::1]', '[fd12::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::127.0.0.1]']) {
    assert.ok(errorIssues(inspectEntry(`https://${host}/Card`, 'card')).length > 0, host);
  }
  assert.equal(errorIssues(inspectEntry('https://example.com/Card', 'card')).length, 0);
  assert.equal(errorIssues(inspectEntry('https://[2606:4700:4700::1111]/Card', 'card')).length, 0);
});

test('valid Card key fields pass while limits remain explicit', () => {
  const report = inspectCardJson(JSON.stringify(validCard()));
  assert.equal(errorIssues(report).length, 0);
  assert.ok(report.issues.some(issue => issue.field === 'scope' && issue.level === 'warning'));
  assert.equal(report.normalizedUrl, undefined);
});

test('Card JSON rejects empty, malformed, primitive, oversized and deeply nested data', () => {
  for (const source of ['', '{', 'null', '[]', '42', 'true', '"hello"', '({name:"x"})', ' '.repeat(65_537), JSON.stringify({ padding: '海'.repeat(25_000) })]) {
    assert.ok(errorIssues(inspectCardJson(source)).length > 0);
  }
  let nested = {};
  for (let index = 0; index < 34; index++) nested = { next: nested };
  assert.ok(errorIssues(inspectCardJson(JSON.stringify(validCard({ _meta: nested })))).length > 0);
  globalThis.__q_material_test = false;
  inspectCardJson('globalThis.__q_material_test = true');
  assert.equal(globalThis.__q_material_test, false);
  delete globalThis.__q_material_test;
});

test('Card schema identity and required field types are checked', () => {
  const patches = [
    { $schema: schema.replace('/v1/', '/v2/') }, { $schema: undefined }, { name: 42 },
    { name: 'plainname' }, { name: 'a/b/c' }, { description: '' }, { description: 'a'.repeat(101) },
    { version: 1 }, { version: '^1.2.3' }, { version: '1.x' }, { version: '1.0.0 - 2.0.0' },
    { remotes: undefined }, { remotes: {} }, { remotes: [] }, { remotes: ['https://example.com'] },
  ];
  for (const patch of patches) assert.ok(errorIssues(inspectCardJson(JSON.stringify(validCard(patch)))).length > 0);
  const dated = inspectCardJson(JSON.stringify(validCard({ version: 'release-2026-10' })));
  assert.equal(errorIssues(dated).length, 0);
  assert.ok(dated.issues.some(issue => issue.field === 'version' && issue.level === 'warning'));
});

test('Card requires Q-compatible HTTPS Streamable HTTP with selected protocol support', () => {
  for (const remote of [
    { type: 'sse', url: 'https://example.com/mcp', supportedProtocolVersions: ['2026-07-28'] },
    { type: 'streamable-http', url: 'http://example.com/mcp', supportedProtocolVersions: ['2026-07-28'] },
    { type: 'streamable-http', url: 'https://example.com/mcp', supportedProtocolVersions: ['2025-11-25'] },
    { type: 'streamable-http', url: 'https://example.com/mcp', supportedProtocolVersions: '2026-07-28' },
    { type: 'streamable-http', url: 'https://example.com/mcp', supportedProtocolVersions: [20260728] },
  ]) assert.ok(errorIssues(inspectCardJson(JSON.stringify(validCard({ remotes: [remote] })))).length > 0);
});

test('secondary endpoints may omit protocol versions when a Q-compatible endpoint exists', () => {
  const card = validCard();
  card.remotes.push({ type: 'sse', url: 'https://example.com/legacy-sse' });
  card.remotes.push({ type: 'streamable-http', url: 'https://example.com/other-mcp', supportedProtocolVersions: ['2025-11-25'] });
  const report = inspectCardJson(JSON.stringify(card));
  assert.equal(errorIssues(report).length, 0);
  assert.ok(report.issues.some(issue => issue.field === 'remotes[1].supportedProtocolVersions' && issue.level === 'warning'));
  assert.ok(report.issues.some(issue => issue.field === 'remotes[1].type' && issue.level === 'warning'));
});

test('a sole endpoint with omitted versions fails only the missing Q compatibility requirement', () => {
  const report = inspectCardJson(JSON.stringify(validCard({ remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }] })));
  assert.deepEqual(errorIssues(report).map(issue => issue.field), ['remotes']);
  assert.ok(report.issues.some(issue => issue.field === 'remotes[0].supportedProtocolVersions' && issue.level === 'warning'));
});

test('an explicitly malformed secondary protocol version field is still rejected', () => {
  for (const versions of [null, '2026-07-28', [20260728], ['']]) {
    const card = validCard();
    card.remotes.push({ type: 'sse', url: 'https://example.com/legacy-sse', supportedProtocolVersions: versions });
    const report = inspectCardJson(JSON.stringify(card));
    assert.ok(errorIssues(report).some(issue => issue.field === 'remotes[1].supportedProtocolVersions'));
    assert.ok(!errorIssues(report).some(issue => issue.field === 'remotes'));
  }
});

test('an empty secondary version array is valid shape but does not prove compatibility', () => {
  const card = validCard();
  card.remotes.push({ type: 'streamable-http', url: 'https://example.com/extra', supportedProtocolVersions: [] });
  const report = inspectCardJson(JSON.stringify(card));
  assert.equal(errorIssues(report).length, 0);
  assert.ok(report.issues.some(issue => issue.field === 'remotes[1].supportedProtocolVersions' && issue.level === 'warning'));
  assert.ok(errorIssues(inspectCardJson(JSON.stringify(validCard({ remotes: [card.remotes[1]] })))).some(issue => issue.field === 'remotes'));
});

test('Card rejects runtime capability lists and embedded authentication material', () => {
  for (const field of ['tools', 'resources', 'prompts', 'capabilities', 'auth', 'authentication', 'oauth', 'credentials', 'token', 'api_key', 'secret']) {
    assert.ok(errorIssues(inspectCardJson(JSON.stringify(validCard({ [field]: {} })))).length > 0);
  }
  const card = validCard();
  card.remotes[0].headers = [{ name: 'Authorization', value: 'DO_NOT_ECHO_OPAQUE' }];
  const report = inspectCardJson(JSON.stringify(card));
  assert.ok(errorIssues(report).some(issue => issue.field.endsWith('headers')));
  assert.equal(JSON.stringify(report).includes('DO_NOT_ECHO_OPAQUE'), false);
  const icon = inspectCardJson(JSON.stringify(validCard({ icons: [{ src: 'https://example.com/icon?token=DO_NOT_ECHO_TOKEN' }] })));
  assert.ok(errorIssues(icon).length > 0);
  assert.equal(JSON.stringify(icon).includes('DO_NOT_ECHO_TOKEN'), false);
});

test('draft validation catches missing fields, unsafe URLs and nonboolean options', () => {
  assert.equal(errorIssues(inspectDraft(draft())).length, 0);
  for (const patch of [{ title: '' }, { description: 'a'.repeat(101) }, { cardUrl: 'http://example.com' }, { endpointUrl: 'https://localhost/mcp' }, { needsAuth: 'true' }]) assert.ok(errorIssues(inspectDraft(draft(patch))).length > 0);
  const missing = draft(); delete missing.title;
  assert.ok(errorIssues(inspectDraft(missing)).some(issue => issue.field === 'title'));
  const crossOrigin = inspectDraft(draft({ endpointUrl: 'https://other.example/mcp' }));
  assert.equal(errorIssues(crossOrigin).length, 0);
  assert.ok(crossOrigin.some(issue => issue.field === 'endpointUrl' && issue.level === 'warning'));
});

test('material generation follows Card v1 and Catalog 1.0 without losing identity queries', () => {
  const source = Object.freeze(draft());
  const before = JSON.stringify(source);
  const result = createMaterials(source);
  const card = JSON.parse(result.card), catalog = JSON.parse(result.catalog);
  assert.equal(card.$schema, schema);
  assert.equal(card.remotes[0].type, 'streamable-http');
  assert.deepEqual(card.remotes[0].supportedProtocolVersions, ['2026-07-28']);
  assert.equal(card.remotes[0].url, source.endpointUrl);
  assert.equal(catalog.specVersion, '1.0');
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].type, 'application/mcp-server-card+json');
  assert.equal(catalog.entries[0].url, 'https://acme.example/Plugins/Calendar/server-card?tenant=public&a=2&a=1');
  assert.equal(catalog.entries[0].identifier, catalog.entries[0].url);
  assert.equal(errorIssues(inspectCardJson(result.card)).length, 0);
  assert.equal(JSON.stringify(source), before);
  assert.ok(result.intro.includes('rel="ai-catalog"'));
  assert.ok(result.intro.includes('?tenant=public&amp;a=2&amp;a=1'));
});

test('conditional checklists keep Auth, Apps, domain discovery and public listing separate', () => {
  const enabled = createMaterials(draft({ needsAuth: true, hasUi: true, domainDiscovery: true, publicListing: true }));
  for (const word of ['Protected Resource Metadata', 'CIMD', 'ui/initialize', 'resources/read', 'robots.txt', 'X-Robots-Tag: noindex', 'server/discover']) assert.ok(enabled.checklistEn.includes(word));
  assert.ok(enabled.intro.includes('https://acme.example/.well-known/ai-catalog.json'));
  assert.ok(enabled.checklistZh.includes('已选择域名发现：必须发布根'));
  const disabled = createMaterials(draft());
  assert.ok(disabled.checklistEn.includes('root Catalog is not required'));
  assert.ok(disabled.checklistEn.includes('Public indexing not selected'));
  assert.ok(disabled.checklistEn.includes('Apps UI not selected'));
  assert.ok(disabled.checklistEn.includes('Account sign-in not selected'));
  assert.ok(!disabled.intro.includes('/.well-known/ai-catalog.json'));
  assert.equal(Object.hasOwn(JSON.parse(enabled.card), 'auth'), false);
  assert.equal(Object.hasOwn(JSON.parse(enabled.card), 'capabilities'), false);
});

test('optional Catalog names avoid Card collisions and preserve scoped query identity', () => {
  const cardUrl = 'https://example.com/plugins/catalog.json?tenant=A&mode=read&tenant=B';
  const input = draft({ cardUrl, endpointUrl: 'https://example.com/mcp', domainDiscovery: false });
  const result = createMaterials(input);
  const catalogUrl = 'https://example.com/plugins/catalog-2.json?tenant=A&amp;mode=read&amp;tenant=B';
  assert.ok(result.intro.includes(`href="${catalogUrl}"`));
  assert.equal(JSON.parse(result.catalog).entries[0].url, cardUrl);
  assert.equal(JSON.parse(result.catalog).entries[0].identifier, cardUrl);
  assert.deepEqual(createMaterials(input), result);
});

test('optional Catalog names also avoid the MCP endpoint and advance deterministically', () => {
  const first = createMaterials(draft({ cardUrl: 'https://example.com/plugins/server-card', endpointUrl: 'https://example.com/plugins/catalog.json' }));
  assert.ok(first.intro.includes('href="https://example.com/plugins/catalog-2.json"'));
  const both = createMaterials(draft({ cardUrl: 'https://example.com/plugins/catalog.json?tenant=A', endpointUrl: 'https://example.com/plugins/catalog-2.json?tenant=A' }));
  assert.ok(both.intro.includes('href="https://example.com/plugins/catalog-3.json?tenant=A"'));
  assert.equal(JSON.parse(both.catalog).entries[0].url, 'https://example.com/plugins/catalog.json?tenant=A');
});

test('domain discovery rejects a fixed root Catalog collision with Card or MCP endpoint', () => {
  const rootCatalog = 'https://example.com/.well-known/ai-catalog.json';
  for (const input of [
    draft({ cardUrl: rootCatalog, endpointUrl: 'https://example.com/mcp', domainDiscovery: true }),
    draft({ cardUrl: 'https://example.com/plugins/card', endpointUrl: rootCatalog, domainDiscovery: true }),
    draft({ cardUrl: 'https://example.com/plugins/card', endpointUrl: 'https://example.com/.well-known/./ai-catalog.json', domainDiscovery: true }),
  ]) {
    assert.ok(errorIssues(inspectDraft(input)).some(issue => issue.field === 'domainDiscovery'));
    assert.throws(() => createMaterials(input), /INVALID_PLUGIN_DRAFT/);
  }
  const distinct = createMaterials(draft({ cardUrl: 'https://example.com/plugins/card', endpointUrl: 'https://example.com/mcp', domainDiscovery: true }));
  assert.ok(distinct.intro.includes(`href="${rootCatalog}"`));
});

test('generated introduction escapes content and invalid draft generation reveals no secret', () => {
  const result = createMaterials(draft({ title: '<script>alert("hi")</script>', description: '<img src=x onerror="attack"> & text' }));
  assert.equal(result.intro.includes('<script>'), false);
  assert.equal(result.intro.includes('<img src='), false);
  assert.ok(result.intro.includes('&lt;script&gt;'));
  assert.throws(() => createMaterials(draft({ cardUrl: 'https://example.com/?token=DO_NOT_ECHO' })), error => error.message === 'INVALID_PLUGIN_DRAFT' && !error.message.includes('DO_NOT_ECHO'));
});
