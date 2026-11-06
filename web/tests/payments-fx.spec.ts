import { expect, test, type Page } from '@playwright/test';
import type { FxStatus } from '../src/payments/types';

const actor = '11111111-1111-4111-8111-111111111111';
const otherActor = '22222222-2222-4222-8222-222222222222';
const activeId = '33333333-3333-4333-8333-333333333333';
const candidateId = '44444444-4444-4444-8444-444444444444';
const activationId = '55555555-5555-4555-8555-555555555555';
const evidence = 'b'.repeat(64);
const at = '2026-11-05T12:00:00Z';
const reason = '已核对官方原始证据和异常变动原因';

function fx(): FxStatus {
  return {
    mode: 'automatic', state: 'held', generation: 7, policy_fingerprint: 'c'.repeat(64),
    current: { snapshot_id: activeId, source_date: '2026-11-04', rate_at: '2026-11-04T00:00:00Z', fetched_at: '2026-11-04T16:00:00Z', expires_at: '2026-11-05T14:00:00Z', remaining_seconds: 7200, rate_cny_per_100_hkd: '92.50000000', evidence_sha256: 'a'.repeat(64), evidence_verified: true },
    candidate: { id: candidateId, source_date: '2026-11-05', rate_cny_per_100_hkd: '95.00000000', evidence_sha256: evidence, reason: 'rate_jump', manual_activation_allowed: true },
    last_checked_at: at, last_success_at: '2026-11-04T16:00:00Z', last_error_code: 'rate_jump', hold_reason: 'rate_jump',
    next_attempt_at: '2026-11-05T12:15:00Z', last_http_status: 200, refresh_in_progress: false,
    alerts: { within_24h: true, within_6h: true, stale: false, held: true }, server_time: at,
  };
}

async function fixture(page: Page, options: { status?: FxStatus; outcome?: 'success' | 'unknown-matched' | 'unknown-changed' | 'unknown-old-generation' | 'unknown-wrong-evidence' | 'wrong-receipt-generation' | 'wrong-receipt-snapshot' } = {}) {
  let status = options.status ?? fx();
  let owner = actor;
  const activations: unknown[] = [];
  const unexpected: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const send = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (url.pathname.startsWith('/q-admin/') && ['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    if (url.origin !== 'http://127.0.0.1:18789') { unexpected.push(request.url()); return route.abort(); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/auth/login') { owner = request.postDataJSON().handle === 'other' ? otherActor : actor; return send({ token: `fx-test-${owner}`, user: { id: owner } }); }
    if (url.pathname === '/v1/auth/logout') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/payments/operator/me') return send({ user_id: owner, roles: ['maker'], server_time: at });
    if (url.pathname === '/v1/payments/operator/orders') return send({ items: [], next_cursor: null });
    if (url.pathname === '/v1/payments/fx/status' && request.method() === 'GET') return send(status);
    if (url.pathname === '/v1/payments/fx/activations' && request.method() === 'POST') {
      activations.push(request.postDataJSON());
      status = { ...status, generation: 8, state: 'ready', hold_reason: null, candidate: null, alerts: { within_24h: false, within_6h: false, stale: false, held: false }, current: { ...fx().current!, snapshot_id: candidateId, evidence_sha256: evidence, rate_cny_per_100_hkd: '95.00000000' } };
      if (options.outcome === 'unknown-changed') status = { ...status, generation: 9 };
      if (options.outcome === 'unknown-old-generation') status = { ...status, generation: 7 };
      if (options.outcome === 'unknown-wrong-evidence') status = { ...status, current: { ...status.current!, evidence_sha256: 'd'.repeat(64) } };
      return options.outcome?.startsWith('unknown') ? send({}, 503) : send({ activation_id: activationId, snapshot_id: options.outcome === 'wrong-receipt-snapshot' ? activeId : candidateId, generation: options.outcome === 'wrong-receipt-generation' ? 7 : 8, activated_at: at });
    }
    unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  return { activations, unexpected };
}

async function login(page: Page, handle = 'maker') {
  await page.getByLabel('账号', { exact: true }).fill(handle);
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-not-a-secret');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出 / 切换账号', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '汇率状态', exact: true }).click();
  await expect(page.getByRole('heading', { name: '参考汇率与证据', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /查询当前状态|查询待确认激活/ })).toBeEnabled();
}

async function confirmActivation(page: Page) {
  await page.getByLabel('人工核对理由（10–500 字）', { exact: true }).fill(reason);
  await page.getByRole('button', { name: '核对并激活此候选', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认激活参考汇率候选', exact: true });
  await expect(dialog).toContainText(candidateId);
  await expect(dialog).toContainText(evidence);
  await expect(dialog).toContainText(reason);
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click();
}

test('FX displays server fields and alert snapshots without requesting provider refresh', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments'); await login(page);
  const panel = page.getByRole('region', { name: '汇率状态', exact: true });
  for (const value of ['92.50000000', '95.00000000', '7200', '2026-11-05T14:00:00Z', '2026-11-05T12:15:00Z', evidence, 'c'.repeat(64)]) await expect(panel).toContainText(value);
  await expect(panel).toContainText('不是可成交汇率');
  await page.getByRole('button', { name: '查询当前状态', exact: true }).click();
  await expect(panel).toContainText('最近 HTTP 状态');
  expect(f.activations).toEqual([]); expect(f.unexpected).toEqual([]);
});

test('FX activation requires reason and explicit confirmation of the exact candidate', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments'); await login(page);
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toBeDisabled();
  await page.getByLabel('人工核对理由（10–500 字）').fill('太短');
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toBeDisabled();
  await page.getByLabel('人工核对理由（10–500 字）').fill(reason);
  await page.getByRole('button', { name: '核对并激活此候选' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(f.activations).toEqual([]);
  await confirmActivation(page);
  await expect(page.getByRole('heading', { name: '服务端已返回激活回执' })).toBeVisible();
  expect(f.activations).toEqual([{ candidate_id: candidateId, evidence_sha256: evidence, expected_generation: 7, reason }]);
  expect(f.unexpected).toEqual([]);
});

test('unknown FX activation recovers by exact status after refresh and never reposts', async ({ page }) => {
  const f = await fixture(page, { outcome: 'unknown-matched' }); await page.goto('wallet-payments'); await login(page); await confirmActivation(page);
  await expect(page.getByRole('button', { name: '查询待确认激活' })).toBeVisible();
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toHaveCount(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('fx-test-'); expect(stored).not.toContain('fixture-only-not-a-secret'); expect(stored).not.toContain(reason);
  await page.reload(); await login(page);
  await page.getByRole('button', { name: '查询待确认激活' }).click();
  await expect(page.getByText(/已核实目标状态/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '服务端已返回激活回执' })).toHaveCount(0);
  expect(f.activations).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

test('changed FX generation retains uncertainty and account switching cannot expose another pending request', async ({ page }) => {
  const f = await fixture(page, { outcome: 'unknown-changed' }); await page.goto('wallet-payments'); await login(page); await confirmActivation(page);
  await page.getByRole('button', { name: '查询待确认激活' }).click();
  await expect(page.getByText(/当前状态仍不能确认原激活结果/)).toBeVisible();
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toHaveCount(0);
  await page.getByRole('button', { name: '退出 / 切换账号' }).click(); await login(page, 'other');
  await expect(page.getByRole('button', { name: '查询待确认激活' })).toHaveCount(0);
  await page.getByRole('button', { name: '退出 / 切换账号' }).click(); await login(page);
  await expect(page.getByRole('button', { name: '查询待确认激活' })).toBeVisible();
  expect(f.activations).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

test('unconfigured and disallowed FX candidates cannot be activated', async ({ page }) => {
  const empty = { ...fx(), generation: null, current: null, candidate: null, state: 'unconfigured' as const, last_http_status: null };
  const f = await fixture(page, { status: empty }); await page.goto('wallet-payments'); await login(page);
  await expect(page.getByText('服务端未提供当前快照。')).toBeVisible();
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toHaveCount(0);
  expect(f.activations).toEqual([]); expect(f.unexpected).toEqual([]);
});

test('server-disallowed candidate stays read-only at 375px', async ({ page }) => {
  const initial = fx(); initial.candidate!.manual_activation_allowed = false;
  const f = await fixture(page, { status: initial }); await page.setViewportSize({ width: 375, height: 812 }); await page.goto('wallet-payments'); await login(page);
  await expect(page.getByText(/该候选当前不可人工激活/)).toBeVisible();
  await expect(page.getByRole('button', { name: '核对并激活此候选' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '外观主题' })).toHaveCount(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.activations).toEqual([]); expect(f.unexpected).toEqual([]);
});


for (const outcome of ['unknown-old-generation', 'unknown-wrong-evidence'] as const) {
  test(`FX recovery retains the original request for ${outcome} despite a matching snapshot ID`, async ({ page }) => {
    const f = await fixture(page, { outcome }); await page.goto('wallet-payments'); await login(page); await confirmActivation(page);
    await expect(page.getByRole('button', { name: '查询待确认激活' })).toBeVisible();
    await expect.poll(() => f.activations.length).toBe(1);
    await page.reload(); await login(page);
    await page.getByRole('button', { name: '查询待确认激活' }).click();
    await expect(page.getByText(/当前状态仍不能确认原激活结果/)).toBeVisible();
    await expect(page.getByRole('button', { name: '查询待确认激活' })).toBeVisible();
    await expect(page.getByRole('button', { name: '核对并激活此候选' })).toHaveCount(0);
    expect(f.activations).toHaveLength(1); expect(f.unexpected).toEqual([]);
  });
}
for (const outcome of ['wrong-receipt-generation', 'wrong-receipt-snapshot'] as const) {
  test(`FX rejects ${outcome} before clearing recovery and accepts the exact N+1 state by query`, async ({ page }) => {
    const f = await fixture(page, { outcome }); await page.goto('wallet-payments'); await login(page); await confirmActivation(page);
    await expect(page.getByRole('button', { name: '查询待确认激活' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '服务端已返回激活回执' })).toHaveCount(0);
    await page.getByRole('button', { name: '查询待确认激活' }).click();
    await expect(page.getByText(/已核实目标状态/)).toBeVisible();
    await expect(page.getByRole('button', { name: '查询待确认激活' })).toHaveCount(0);
    expect(f.activations).toHaveLength(1); expect(f.unexpected).toEqual([]);
  });
}
