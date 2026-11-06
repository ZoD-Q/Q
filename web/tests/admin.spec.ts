import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import type { PaymentAuditEvent } from '../src/payments/audit-data';

const apiOrigin = 'http://127.0.0.1:18789';
const maker = '22222222-2222-4222-8222-222222222222';
const checker = '33333333-3333-4333-8333-333333333333';
const payer = '11111111-1111-4111-8111-111111111111';
const payment = '44444444-4444-4444-8444-444444444444';
const batch = '55555555-5555-4555-8555-555555555555';
const auditIds = ['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662', '66666666-6666-4666-8666-666666666663'];
const at = '2026-11-06T12:00:00.000Z';
const cursor = `${at}|${auditIds[1]}`;
const pages = [
  ['orders', '支付审核与退款'], ['settlements', '结算与储备凭证'], ['fx', '汇率状态'], ['audit', '支付操作记录'],
] as const;
const settlement = {
  settlement_id: batch, client_request_id: '77777777-7777-4777-8777-777777777777', kind: 'order_reconciliation', source: 'Controlled server evidence', currency: 'CNY',
  status: 'awaiting_verification', mapping_sha256: 'a'.repeat(64), evidence_sha256: 'b'.repeat(64), source_document_media_type: 'application/pdf',
  bank_reference: null, bank_amount_minor: null, check_version: 1, record_count: 1, matched_count: 1, differences: [],
  maker_id: maker, checker_id: null, created_at: at, verified_at: null, source_validation: 'operator_supplied',
};
function auditEvent(id: string, actor: string, action = 'credit_proposed', target: string | null = payment): PaymentAuditEvent {
  return { audit_id: id, actor_id: actor, payment_id: target, action, created_at: at, details: { evidence_version: 1 } };
}

async function fixture(page: Page, options: { settlementGate?: Promise<void>; secondOrderGate?: Promise<void> } = {}) {
  let actor = maker;
  const state = { orderError: false, settlementError: false, detailError: false, auditError: false, auditEmpty: false, unknownAuditActions: false };
  const requests: { method: string; path: string; search: string; actor: string }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => unexpected.push(socket.url()));
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== apiOrigin) {
      if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/q-admin/') && request.method() === 'GET'
        && ['document', 'script', 'stylesheet', 'font', 'other'].includes(request.resourceType())) return route.continue();
      unexpected.push(request.url()); return route.abort();
    }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    requests.push({ method: request.method(), path: url.pathname, search: url.search, actor });
    if (url.pathname === '/v1/auth/login') {
      const handle = request.postDataJSON().handle;
      actor = handle === 'checker' ? checker : handle === 'payer' ? payer : maker;
      return send({ token: `controlled-${actor}`, user: { id: actor } });
    }
    if (url.pathname === '/v1/auth/logout') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/payments/operator/me') return actor === payer ? send({}, 403) : send({ user_id: actor, roles: actor === checker ? ['checker'] : ['maker'], server_time: at });
    if (request.method() !== 'GET' || actor === payer) { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/v1/payments/operator/orders') return state.orderError ? send({}, 503) : send({ items: [], next_cursor: null });
    if (url.pathname === `/v1/payments/operator/orders/${payment}` || url.pathname === `/v1/payments/operator/orders/${batch}`) {
      if (url.pathname.endsWith(batch) && options.secondOrderGate) await options.secondOrderGate;
      const id = url.pathname.split('/').at(-1)!;
      return send({ order: { payment_id: id, account_id: payer, channel: 'alipay', status: 'awaiting_credit_approval', pay_currency: 'CNY', credit_currency: 'HKD', pay_amount_minor_cny: 9300, credit_amount_minor_hkd: 10000, fee_minor_cny: 100, evidence_version: 2, created_at: at, updated_at: at },
        merchant_order_no: `merchant-${id}`, provider_trade_no: `trade-${id}`, provider_paid_at: at, verified_at: at, evidence_sha256: 'a'.repeat(64), proposal: null, approval: null, refund: null, audit: [] });
    }
    if (url.pathname === '/v1/payments/operator/settlements') {
      if (options.settlementGate) await options.settlementGate;
      return state.settlementError ? send({}, 503) : send({ items: [settlement], next_cursor: null });
    }
    if (url.pathname === `/v1/payments/operator/settlements/${batch}`) return state.detailError ? send({}, 503) : send(settlement);
    if (url.pathname === `/v1/payments/operator/settlements/${batch}/checks`) return send({ items: [{ check_version: 1, matched_count: 1, differences: [], actor_id: maker, created_at: at }], next_cursor: null });
    if (url.pathname === '/v1/payments/fx/status') return send({
      mode: 'manual', state: 'unconfigured', current: null, candidate: null, generation: null, policy_fingerprint: 'c'.repeat(64),
      last_checked_at: null, last_success_at: null, last_error_code: null, hold_reason: null, next_attempt_at: null, last_http_status: null,
      refresh_in_progress: false, alerts: { within_24h: false, within_6h: false, stale: true, held: false }, server_time: at,
    });
    if (url.pathname === '/v1/payments/operator/audit') {
      if (state.auditError) return send({}, 503);
      if (state.auditEmpty) return send({ items: [], next_cursor: null });
      if (state.unknownAuditActions) return send({ items: [auditEvent(auditIds[0], actor, 'constructor'), auditEvent(auditIds[1], actor, '__proto__')], next_cursor: null });
      if (url.searchParams.has('payment_id')) return send({ items: url.searchParams.get('payment_id') === payment ? [auditEvent(auditIds[0], actor)] : [], next_cursor: null });
      if (url.searchParams.has('cursor')) return send({ items: [auditEvent(auditIds[2], actor, 'refund_requested')], next_cursor: null });
      return send({ items: [auditEvent(auditIds[0], actor), auditEvent(auditIds[1], actor, 'fx_candidate_activated', null)], next_cursor: cursor });
    }
    unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  return { state, requests, unexpected, errors };
}
async function login(page: Page, handle = 'maker') {
  await page.getByLabel('账号', { exact: true }).fill(handle);
  await page.getByLabel('密码', { exact: true }).fill('controlled-fixture-only');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  if (handle !== 'payer') await expect(page.getByRole('navigation', { name: '管理导航', exact: true })).toBeVisible();
}

for (const route of ['', ...pages.map(([id]) => `wallet-payments/${id}`)]) {
  test(`formal route ${route || '/'} requires Q sign-in before any operator data`, async ({ page }) => {
    const f = await fixture(page); await page.goto(route || './');
    await expect(page.getByRole('heading', { name: '使用 Q 账号登录', exact: true })).toBeVisible();
    expect(f.requests).toEqual([]); await expect(page.locator('table')).toHaveCount(0);
    await login(page);
    await expect(page.getByRole('button', { name: '退出 / 切换账号', exact: true })).toBeVisible();
    await expect.poll(() => f.requests.filter((request) => request.path.startsWith('/v1/payments/') && !request.path.endsWith('/me')).length).toBeGreaterThan(0);
    const dataRead = f.requests.findIndex((request) => request.path.startsWith('/v1/payments/') && !request.path.endsWith('/me'));
    expect(dataRead).toBeGreaterThan(f.requests.findIndex((request) => request.path.endsWith('/operator/me')));
    expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
  });
}

test('four authenticated navigation links keep their URLs and preserve the same verified session', async ({ page }) => {
  const f = await fixture(page); await page.goto('./'); await login(page);
  const navigation = page.getByRole('navigation', { name: '管理导航', exact: true });
  for (const [id, label] of pages) {
    await navigation.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/q-admin/wallet-payments/${id}$`));
    await expect(navigation.getByRole('link', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '使用 Q 账号登录', exact: true })).toHaveCount(0);
  }
  expect(f.requests.filter((request) => request.path === '/v1/auth/login')).toHaveLength(1);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('unconnected legacy routes expose no invented records, statistics, login or business requests', async ({ page }) => {
  const f = await fixture(page);
  for (const route of ['accounts', 'sessions', 'ai-calls', 'plugin-directory', 'video-tasks', 'refunds/refund-701', 'configuration', 'wallet-payments/not-connected']) {
    await page.goto(route);
    await expect(page.getByRole('heading', { name: '此模块尚未接入正式后台', exact: true })).toBeVisible();
    await expect(page.locator('table, input[type=password]')).toHaveCount(0);
    await expect(page.getByText(/演示原型|虚构数据|今日工作台|总用户|晴窗天气|林间/)).toHaveCount(0);
  }
  expect(f.requests).toEqual([]); expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('an ordinary account rejected by operator/me cannot read any operator lists', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments/audit'); await login(page, 'payer');
  await expect(page.getByRole('alert')).toContainText('没有钱包支付操作权限');
  await expect(page.getByRole('navigation', { name: '管理导航', exact: true })).toHaveCount(0);
  expect(f.requests.filter((request) => request.path.startsWith('/v1/payments/') && !request.path.endsWith('/operator/me'))).toEqual([]);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('an unavailable order list is not presented as an empty queue', async ({ page }) => {
  const f = await fixture(page); f.state.orderError = true;
  await page.goto('wallet-payments/orders'); await login(page);
  await expect(page.getByText('未能读取此页订单，无法判断队列是否为空。请手动刷新。', { exact: true })).toBeVisible();
  await expect(page.getByText('此队列当前页没有返回订单', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  f.state.orderError = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('此队列当前页没有返回订单', { exact: true })).toBeVisible();
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('settlement loading and failures identify stale data and disable attestation after a failed detail refresh', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(page, { settlementGate: gate });
  await page.goto('wallet-payments/settlements'); await login(page, 'checker');
  await expect(page.getByText('正在读取结算列表…', { exact: true })).toBeVisible();
  await expect(page.getByText('本次查询没有返回结算材料。', { exact: true })).toHaveCount(0);
  release();
  await page.getByRole('button', { name: settlement.source, exact: true }).click();
  await expect(page.getByRole('heading', { name: '结算详情', exact: true })).toBeVisible();
  const check = page.getByRole('checkbox'); await check.check();
  const attest = page.getByRole('button', { name: '核对后提交人工核材', exact: true });
  await expect(attest).toBeEnabled();
  f.state.settlementError = true;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByText('列表读取失败，以下为先前载入的记录，请刷新确认。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: settlement.source, exact: true })).toBeVisible();
  f.state.detailError = true;
  await page.getByRole('button', { name: '刷新批次与核对历史', exact: true }).click();
  await expect(page.getByText('未能重新读取材料；当前显示上次结果，请刷新后再核材。', { exact: true })).toBeVisible();
  await expect(attest).toBeDisabled(); await expect(check).toBeDisabled();
  expect(f.requests.filter((request) => request.method === 'POST' && !request.path.startsWith('/v1/auth/'))).toEqual([]);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('payment audit supports bounded pages, exact payment filtering, empty results and explicit read errors', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments/audit'); await login(page);
  const panel = page.getByRole('region', { name: '支付审计', exact: true });
  await expect(panel.getByText(auditIds[0], { exact: true })).toBeVisible();
  await expect(panel.getByText('未关联付款订单', { exact: true })).toBeVisible();
  await expect(panel.getByText(at, { exact: true })).toHaveCount(2);
  await panel.getByRole('button', { name: '下一页审计', exact: true }).click();
  await expect(panel.getByText(auditIds[2], { exact: true })).toBeVisible();
  await expect(panel.getByText(auditIds[0], { exact: true })).toHaveCount(0);
  expect(new URLSearchParams(f.requests.at(-1)!.search).get('cursor')).toBe(cursor);
  await panel.getByRole('button', { name: '上一页审计', exact: true }).click();
  await expect(panel.getByText(auditIds[0], { exact: true })).toBeVisible();
  await panel.getByLabel('按付款订单筛选（可留空）', { exact: true }).fill(payment);
  await panel.getByRole('button', { name: '应用筛选', exact: true }).click();
  await expect(panel.getByText('未关联付款订单', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '下一页审计', exact: true })).toBeDisabled();
  expect(new URLSearchParams(f.requests.at(-1)!.search).get('payment_id')).toBe(payment);
  f.state.auditEmpty = true;
  await panel.getByRole('button', { name: '刷新当前页', exact: true }).click();
  await expect(panel.getByText('本次范围与页码没有返回审计记录。', { exact: true })).toBeVisible();
  f.state.auditError = true;
  await panel.getByRole('button', { name: '刷新当前页', exact: true }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByText('本次范围与页码没有返回审计记录。', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('未能读取此页，不能判断是否存在记录。请手动刷新。', { exact: true })).toBeVisible();
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('audit records disappear on sign-out and reload only for the next verified account', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments/audit'); await login(page);
  let panel = page.getByRole('region', { name: '支付审计', exact: true });
  await expect(panel.getByRole('cell', { name: maker, exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  await expect(page.locator('table')).toHaveCount(0);
  await login(page, 'checker'); panel = page.getByRole('region', { name: '支付审计', exact: true });
  await expect(panel.getByRole('cell', { name: checker, exact: true })).toHaveCount(2);
  await expect(panel.getByRole('cell', { name: maker, exact: true })).toHaveCount(0);
  expect(f.requests.filter((request) => request.path.endsWith('/audit')).map((request) => request.actor)).toEqual([maker, checker]);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('unknown audit actions named constructor and __proto__ remain readable once each', async ({ page }) => {
  const f = await fixture(page); f.state.unknownAuditActions = true;
  await page.goto('wallet-payments/audit'); await login(page);
  const panel = page.getByRole('region', { name: '支付审计', exact: true });
  await expect(panel.getByText('constructor', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('__proto__', { exact: true })).toHaveCount(1);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('production files contain no demo catalog and unofficial routes never collect credentials or request images', async ({ page }) => {
  const production = new URL('../dist/', import.meta.url);
  expect(readdirSync(production)).not.toContain('privacy.html');
  expect(readdirSync(production)).not.toContain('mascot');
  const scripts = readdirSync(new URL('assets/', production)).filter((name) => name.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  const code = scripts.map((name) => readFileSync(new URL(`assets/${name}`, production), 'utf8')).join('\n');
  expect(code).not.toMatch(/晴窗天气|演示用户|确认演示操作|演示操作者|demo-refund-701|createInitialState/);
  const unexpected: string[] = []; const images: string[] = [];
  page.on('request', (request) => { if (request.resourceType() === 'image') images.push(request.url()); });
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== 'https://8.163.108.216' || request.method() !== 'GET') { unexpected.push(request.url()); return route.abort(); }
    if (request.resourceType() === 'document' && url.pathname.startsWith('/q-admin/')) return route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('index.html', production)) });
    const asset = url.pathname.match(/^\/q-admin\/(assets\/[A-Za-z0-9_.-]+\.(js|css))$/);
    if (asset) return route.fulfill({ contentType: asset[2] === 'js' ? 'text/javascript' : 'text/css', body: readFileSync(new URL(asset[1], production)) });
    unexpected.push(request.url()); return route.abort();
  });
  for (const path of ['', 'accounts', 'wallet-payments/audit']) {
    await page.goto(`https://8.163.108.216/q-admin/${path}`);
    await expect(page.getByRole('heading', { name: '请使用小Q官方后台', exact: true })).toBeVisible();
    await expect(page.locator('input[type=password], table')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '打开官方后台', exact: true })).toHaveAttribute('href', 'https://q.kaicloudpay.com/q-admin/');
  }
  expect(unexpected).toEqual([]); expect(images).toEqual([]);
});


test('changing the selected payment immediately blocks an old confirmation and hides stale refund actions', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(page, { secondOrderGate: gate });
  await page.goto('wallet-payments/orders'); await login(page);
  await page.getByLabel('订单编号', { exact: true }).fill(payment);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByRole('button', { name: '提交初审', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: '外部全额退款', exact: true })).toBeVisible();
  await page.getByLabel('订单编号', { exact: true }).fill(batch);
  await page.getByRole('button', { name: '提交初审', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认初审', exact: true })).toBeVisible();
  // Keep the old button reference while dispatching the new selection, before React effects run.
  await page.evaluate(() => {
    const oldSubmit = [...document.querySelectorAll('button')].find((button) => button.textContent === '确认提交');
    const lookup = document.querySelector('form.pay-lookup');
    if (!oldSubmit || !lookup) throw Error('Missing review controls');
    lookup.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    oldSubmit.click();
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '外部全额退款', exact: true })).toHaveCount(0);
  expect(f.requests.filter((request) => request.method === 'POST' && !request.path.startsWith('/v1/auth/'))).toEqual([]);
  release();
  await expect(page.getByRole('button', { name: '提交初审', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: '外部全额退款', exact: true })).toContainText(batch);
  expect(f.unexpected).toEqual([]); expect(f.errors).toEqual([]);
});

test('empty credentials and invalid order filters report in-page errors without browser validation popups or requests', async ({ page }) => {
  const f = await fixture(page); await page.goto('./');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('请填写账号和密码。');
  expect(f.requests).toEqual([]);
  await login(page);
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  const count = f.requests.length;
  await page.getByLabel('订单编号', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('请输入完整有效的订单编号。');
  expect(f.requests).toHaveLength(count);
  await page.getByRole('link', { name: '支付操作记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用筛选', exact: true })).toBeEnabled();
  const auditCount = f.requests.length;
  await page.getByLabel('按付款订单筛选（可留空）', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('请输入完整有效的订单编号，或留空查询。');
  expect(f.requests).toHaveLength(auditCount); expect(f.unexpected).toEqual([]);
});
