import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const actor = '22222222-2222-4222-8222-222222222222';
const payer = '11111111-1111-4111-8111-111111111111';
const first = '44444444-4444-4444-8444-444444444444';
const second = '66666666-6666-4666-8666-666666666666';
const proposal = '55555555-5555-4555-8555-555555555555';
const at = '2026-11-05T02:00:00Z';
const evidence = 'a'.repeat(64);

function order(id: string) {
  return { payment_id: id, account_id: payer, channel: 'alipay', status: 'awaiting_credit_approval', queue: 'first_review', credit_currency: 'HKD', pay_currency: 'CNY', credit_amount_minor_hkd: 10000, pay_amount_minor_cny: 9300, base_amount_minor_cny: 9200, fee_minor_cny: 100, fee_basis_points: 100, evidence_version: 2, created_at: at, updated_at: at, error_code: null, refund_status: null, quote_id: id, client_request_id: id, rate_cny_per_100_hkd: '92', rate_source: 'Fixture', rate_source_url: 'https://example.invalid', rate_source_date: '2026-11-05', rate_at: at, rate_fetched_at: at, rate_evidence_sha256: evidence, expires_at: at, server_time: at, rounding_policy: 'total_ceiling_minor_v1', checkout_url: null, checkout_expires_at: at, checkout_detached: false, terminal: false, safe_to_start_new: false, can_detach_checkout: false, poll_after_seconds: 3, credited_transaction_id: null };
}

async function fixture(page: Page) {
  let proposed = false;
  let posts = 0;
  let delayNext = false;
  let expireNext = false;
  let release: () => void = () => {};
  let readStarted: () => void = () => {};
  const delayedRead = new Promise<void>((resolve) => { readStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const unexpected: string[] = [];
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.pathname.startsWith('/q-admin/') && ['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (url.origin !== 'http://127.0.0.1:18789') { unexpected.push(req.url()); return route.abort(); }
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/auth/login') return send({ token: 'fixture-payment-race-token', user: { id: actor } });
    if (url.pathname === '/v1/auth/logout') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/payments/operator/me') return send({ user_id: actor, roles: ['maker'], server_time: at });
    if (url.pathname === '/v1/payments/operator/orders') return send({ items: [order(first), order(second)], next_cursor: null });
    if (url.pathname === `/v1/payments/orders/${first}/proposals`) { posts += 1; proposed = true; return send({}, 503); }
    for (const id of [first, second]) if (url.pathname === `/v1/payments/operator/orders/${id}`) {
      if (id === first && expireNext) { expireNext = false; return send({}, 401); }
      if (id === first && delayNext) { delayNext = false; readStarted(); await gate; }
      return send({ order: order(id), merchant_order_no: `merchant-${id}`, provider_trade_no: `provider-${id}`, provider_paid_at: at, verified_at: at, evidence_sha256: evidence, proposal: id === first && proposed ? { proposal_id: proposal, payment_id: id, maker_id: actor, evidence_version: 2, created_at: at } : null, approval: null, refund: null, audit: [] });
    }
    unexpected.push(`${req.method()} ${url.pathname}`); return route.abort();
  });
  return { posts: () => posts, unexpected, delayNext: () => { delayNext = true; }, expireNext: () => { expireNext = true; }, delayedRead, release };
}

async function login(page: Page) {
  await page.getByLabel('账号', { exact: true }).fill('maker');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-not-a-secret');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出 / 切换账号', exact: true })).toBeVisible();
}
async function find(page: Page, id: string) {
  await page.getByLabel('订单编号', { exact: true }).fill(id);
  await page.getByRole('button', { name: '查找', exact: true }).click();
  await expect(page.locator('article.pay-detail')).toContainText(id);
}
async function unknownProposal(page: Page) {
  await find(page, first);
  await page.getByRole('button', { name: '提交初审', exact: true }).click();
  await page.getByRole('dialog', { name: '确认初审', exact: true }).getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询原审批结果', exact: true })).toBeEnabled();
}

test('late recovery for payment A cannot replace the selected payment B', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments'); await login(page); await unknownProposal(page);
  f.delayNext(); await page.getByRole('button', { name: '查询原审批结果', exact: true }).click(); await f.delayedRead;
  await find(page, second);
  const returned = page.waitForResponse((response) => response.url().endsWith(`/operator/orders/${first}`));
  f.release(); await returned;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator('article.pay-detail')).toContainText(second);
  await expect(page.locator('article.pay-detail')).not.toContainText(first);
  await expect(page.getByRole('button', { name: '提交初审', exact: true })).toBeEnabled();
  expect(f.posts()).toBe(1); expect(f.unexpected).toEqual([]);
});

test('401 while reconciling an unknown payment preserves the original request across sign-in', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments'); await login(page); await unknownProposal(page);
  f.expireNext(); await page.getByRole('button', { name: '查询原审批结果', exact: true }).click();
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toBeVisible();
  await login(page); await find(page, first);
  await expect(page.getByRole('button', { name: '提交初审', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '查询原审批结果', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询原审批结果', exact: true })).toHaveCount(0);
  expect(f.posts()).toBe(1); expect(f.unexpected).toEqual([]);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('fixture-payment-race-token'); expect(storage).not.toContain('fixture-only-not-a-secret');
});

test('unknown approval only resolves when checker, proposal and both evidence versions match the original request', async ({ page }) => {
  const f = await fixture(page);
  const maker = '33333333-3333-4333-8333-333333333333';
  const replacement = '77777777-7777-4777-8777-777777777777';
  const approvalPosts: unknown[] = [];
  let credited = false;
  let currentProposal = proposal;
  let proposalVersion = 2;
  let orderVersion = 2;
  await page.route('http://127.0.0.1:18789/v1/**', async (route) => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } });
    if (req.method() === 'OPTIONS') return route.fallback();
    if (path === '/v1/payments/operator/me') return send({ user_id: actor, roles: ['checker'], server_time: at });
    if (path === `/v1/payments/orders/${first}/approvals` && req.method() === 'POST') {
      approvalPosts.push(req.postDataJSON());
      credited = true; currentProposal = replacement; proposalVersion = 3; orderVersion = 3;
      return send({}, 503);
    }
    if (path === `/v1/payments/operator/orders/${first}` && req.method() === 'GET') {
      return send({ order: { ...order(first), status: credited ? 'credited' : 'awaiting_credit_approval', evidence_version: orderVersion }, merchant_order_no: 'merchant-original', provider_trade_no: 'provider-original', provider_paid_at: at, verified_at: at, evidence_sha256: evidence, proposal: { proposal_id: currentProposal, payment_id: first, maker_id: maker, evidence_version: proposalVersion, created_at: at }, approval: credited ? { checker_id: actor, created_at: at } : null, refund: null, audit: [] });
    }
    return route.fallback();
  });
  await page.goto('wallet-payments'); await login(page); await find(page, first);
  await page.getByRole('button', { name: '复审并入账', exact: true }).click();
  await page.getByRole('dialog', { name: '确认复审入账', exact: true }).getByRole('button', { name: '确认提交', exact: true }).click();
  const query = page.getByRole('button', { name: '查询原审批结果', exact: true });
  await expect(query).toBeEnabled();
  async function expectUnconfirmed() {
    await query.click();
    await expect(page.getByText('尚未确认原操作结果。保留原引用，继续查询或交由运维核实；不创建新审批。', { exact: true })).toBeVisible();
    await expect(query).toBeEnabled();
    await expect(page.getByRole('button', { name: '复审并入账', exact: true })).toBeDisabled();
    expect(approvalPosts).toEqual([{ proposal_id: proposal, evidence_version: 2 }]);
  }
  // The same checker and credited status alone cannot prove which approval ran.
  await expectUnconfirmed();
  proposalVersion = 2; orderVersion = 2;
  await expectUnconfirmed(); // Wrong proposal, matching versions.
  currentProposal = proposal; proposalVersion = 3;
  await expectUnconfirmed(); // Right proposal, wrong proposal evidence.
  proposalVersion = 2; orderVersion = 3;
  await expectUnconfirmed(); // Right proposal, wrong order evidence.
  orderVersion = 2;
  await query.click();
  await expect(query).toHaveCount(0);
  expect(approvalPosts).toEqual([{ proposal_id: proposal, evidence_version: 2 }]);
  expect(f.unexpected).toEqual([]);
});

test('root and payment deep links load authenticated documents with consistent CSP', async ({ page }) => {
  const f = await fixture(page);
  const documents: string[] = [];
  await page.route('**/q-admin/**', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    documents.push(new URL(route.request().url()).pathname);
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self' http://127.0.0.1:18789; form-action 'none'; base-uri 'self'" } });
  });
  await page.goto('./'); await login(page);
  const initialCount = documents.length;
  await page.getByRole('link', { name: '支付审核与退款', exact: true }).click();
  await expect(page).toHaveURL(/wallet-payments\/orders$/);
  expect(documents.length).toBe(initialCount);
  await page.reload();
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toBeVisible();
  await login(page);
  expect(documents.at(-1)).toBe('/q-admin/wallet-payments/orders');
  const blocked = await page.evaluate(async () => { try { await fetch('https://example.invalid/v1/probe'); return false; } catch { return true; } });
  expect(blocked).toBe(true); expect(f.posts()).toBe(0); expect(f.unexpected).toEqual([]);
});

test('pagehide synchronously removes protected file forms and persisted pageshow returns to clean sign-in', async ({ page }) => {
  const f = await fixture(page);
  await page.route(/^http:\/\/127\.0\.0\.1:18789\/v1\/payments\/operator\/settlements(?:\?.*)?$/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [], next_cursor: null }), headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto('wallet-payments'); await login(page);
  await page.getByRole('link', { name: '结算与储备凭证', exact: true }).click();
  await page.getByLabel('资料来源名称', { exact: true }).fill('private-file-form-marker');
  await page.getByLabel('规范化 JSON 文件', { exact: true }).setInputFiles({ name: 'private-mapping.json', mimeType: 'application/json', buffer: Buffer.from('{"private":"not-submitted"}') });
  const immediate = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return { files: document.querySelectorAll('input[type=file]').length, protectedSession: document.querySelectorAll('.pay-session').length, oldValue: [...document.querySelectorAll('input')].some((input) => input.value.includes('private-file-form-marker')) };
  });
  expect(immediate).toEqual({ files: 0, protectedSession: 0, oldValue: false });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('账号', { exact: true })).toHaveValue('');
  await page.getByLabel('密码', { exact: true }).fill('unsent-password-marker');
  const cleared = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    return (document.querySelector('input[type=password]') as HTMLInputElement | null)?.value;
  });
  expect(cleared).toBe('');
  expect(f.posts()).toBe(0); expect(f.unexpected).toEqual([]);
});

test('late 401 from a pre-pagehide request cannot expire a newly authenticated session', async ({ page }) => {
  const f = await fixture(page);
  // Simulate an already-delivered old response whose promise ignores cancellation.
  // All other API calls still use the fully intercepted loopback fixture.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window); let firstList = true;
    const state = window as unknown as { releaseOldPaymentResponse?: () => void; oldPaymentResponseReleased?: boolean };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (firstList && url.startsWith('http://127.0.0.1:18789/v1/payments/operator/orders?')) {
        firstList = false;
        await new Promise<void>((resolve) => { state.releaseOldPaymentResponse = resolve; });
        state.oldPaymentResponseReleased = true;
        return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      return original(input, init);
    };
  });
  await page.goto('wallet-payments'); await login(page);
  await page.waitForFunction(() => typeof (window as unknown as { releaseOldPaymentResponse?: () => void }).releaseOldPaymentResponse === 'function');
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await login(page);
  await expect(page.getByRole('button', { name: '查看订单', exact: true })).toHaveCount(2);
  await page.evaluate(() => (window as unknown as { releaseOldPaymentResponse: () => void }).releaseOldPaymentResponse());
  await page.waitForFunction(() => (window as unknown as { oldPaymentResponseReleased?: boolean }).oldPaymentResponseReleased === true);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('button', { name: '退出 / 切换账号', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toHaveCount(0);
  expect(f.posts()).toBe(0); expect(f.unexpected).toEqual([]);
});

test('browser back from an unavailable page never restores the authenticated payment document', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments'); await login(page); await find(page, first);
  await page.goto('accounts');
  await expect(page.getByRole('heading', { name: '此模块尚未接入正式后台', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toBeVisible();
  await expect(page.locator('article.pay-detail')).toHaveCount(0);
  await expect(page.locator('input[type=file]')).toHaveCount(0);
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  expect(f.posts()).toBe(0); expect(f.unexpected).toEqual([]);
});

test('production bundle on the public IP refuses credentials and offers only the official wallet link', async ({ page }) => {
  const unexpected: string[] = [];
  const production = new URL('../dist/', import.meta.url);
  await page.route('**/*', async (route) => {
    const req = route.request(); const url = new URL(req.url());
    if (url.origin !== 'https://8.163.108.216' || req.method() !== 'GET') { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/q-admin/wallet-payments') return route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('index.html', production)), headers: { 'Cache-Control': 'no-store' } });
    const match = url.pathname.match(/^\/q-admin\/(assets\/[A-Za-z0-9_.-]+\.(js|css))$/);
    if (match) return route.fulfill({ contentType: match[2] === 'js' ? 'text/javascript' : 'text/css', body: readFileSync(new URL(match[1], production)) });
    unexpected.push(req.url()); return route.abort();
  });
  // Every request to this address is fulfilled from local production files above.
  await page.goto('https://8.163.108.216/q-admin/wallet-payments');
  await expect(page.getByRole('heading', { name: '请使用小Q官方后台', exact: true })).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByLabel('账号', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '打开官方后台', exact: true })).toHaveAttribute('href', 'https://q.kaicloudpay.com/q-admin/');
  expect(unexpected).toEqual([]);
});
