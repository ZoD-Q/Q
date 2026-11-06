import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { components } from '../../mobile/shared/src/generated';

const payer = '11111111-1111-4111-8111-111111111111';
const maker = '22222222-2222-4222-8222-222222222222';
const checker = '33333333-3333-4333-8333-333333333333';
const other = '77777777-7777-4777-8777-777777777777';
const payment = '44444444-4444-4444-8444-444444444444';
const refundId = '66666666-6666-4666-8666-666666666666';
const at = '2026-11-01T02:00:00.000Z';
type Refund = components['schemas']['PaymentRefund'];
type EvidenceVersion = components['schemas']['PaymentRefundEvidenceVersion'];
function seeded(): Refund { return { refund_id: refundId, payment_id: payment, client_request_id: '88888888-8888-4888-8888-888888888888', status: 'approved_external', version: 2, reason: 'test-full-refund', notes: null, approved_at: at, pay_amount_minor_cny: 9300, credit_amount_minor_hkd: 10000, frozen_minor_hkd: 10000, maker_id: maker, checker_id: checker, external_reference: null, executed_at: null, evidence_sha256: null, evidence_version: null, rejection_reason: null, verified_by: null, created_at: at, updated_at: at }; }

async function fixture(page: Page, options: { initial?: Refund; unknownCreate?: boolean; commitUnknown?: boolean; unknownStatus?: 401 | 503; unknownEvidence?: boolean; commitEvidence?: boolean; historyPageSize?: number; unknownRejection?: boolean; writeReply?: (refund: Refund) => Refund; refundReadReply?: (refund: Refund) => Refund } = {}) {
  let refund: Refund | null = options.initial ?? null;
  let actor = maker;
  let createAttempts = 0;
  const writes: { path: string; body: Record<string, unknown>; actor: string }[] = [];
  const documents: string[] = [];
  const historyReads: string[] = [];
  const history: EvidenceVersion[] = refund?.evidence_version && refund.evidence_sha256 && refund.external_reference && refund.executed_at ? [{ evidence_version: refund.evidence_version, evidence_sha256: refund.evidence_sha256, external_reference: refund.external_reference, executed_at: refund.executed_at, actor_id: maker, notes: refund.notes ?? 'Original attachment', created_at: at, rejected_by: null, rejection_reason: null, rejected_at: null }] : [];
  const unexpected: string[] = [];
  const order = () => ({ payment_id: payment, account_id: payer, channel: 'alipay', status: 'credited', queue: 'credited', pay_currency: 'CNY', credit_currency: 'HKD', credit_amount_minor_hkd: 10000, pay_amount_minor_cny: 9300, fee_minor_cny: 100, evidence_version: 2, created_at: at, updated_at: at, error_code: null, refund_status: refund?.status ?? null });
  page.on('request', (request) => { const url = new URL(request.url()); if (url.origin !== 'http://127.0.0.1:18789' && !['127.0.0.1', 'localhost'].includes(url.hostname)) unexpected.push(request.url()); });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/q-admin/') && route.request().method() === 'GET') return route.continue();
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.route('http://127.0.0.1:18789/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname; const method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' } });
    if (path === '/v1/auth/login') { const body = request.postDataJSON() as Record<string, unknown>; actor = body.handle === 'checker' ? checker : body.handle === 'payer' ? payer : body.handle === 'other' ? other : maker; return send({ token: `refund-test-${actor}`, user: { id: actor } }); }
    if (path === '/v1/auth/logout') return route.fulfill({ status: 204 });
    if (path === '/v1/payments/operator/me') return send({ user_id: actor, roles: actor === checker || actor === other ? ['checker'] : ['maker'], server_time: new Date().toISOString() });
    if (path === '/v1/payments/operator/orders') return send({ items: [order()], next_cursor: null });
    if (path === `/v1/payments/operator/orders/${payment}`) return send({ order: order(), merchant_order_no: 'M-REFUND', provider_trade_no: 'P-REFUND', provider_paid_at: at, verified_at: at, evidence_sha256: 'a'.repeat(64), proposal: null, approval: null, refund, audit: writes.map((write, index) => ({ audit_id: `audit-${index}`, actor_id: write.actor, action: ({ refunds: 'refund_requested', approve: 'refund_external_approved', unknown: 'refund_result_unknown', evidence: 'refund_evidence_attached', 'evidence-rejections': 'refund_evidence_correction_requested', verify: 'refund_external_verified' } as Record<string, string>)[write.path.split('/').at(-1)!], created_at: at, details: {} })) });
    if (path === `/v1/payments/operator/refunds/${refundId}` && method === 'GET') return refund ? send(options.refundReadReply?.(refund) ?? refund) : send({}, 404);
    if (path === `/v1/payments/operator/refunds/${refundId}/evidence` && method === 'GET') {
      historyReads.push(request.url());
      const cursor = new URL(request.url()).searchParams.get('cursor');
      const rows = history.filter((row) => !cursor || row.evidence_version < Number(cursor)).sort((a, b) => b.evidence_version - a.evidence_version);
      const size = options.historyPageSize ?? 20;
      const items = rows.slice(0, size);
      return send({ items, next_cursor: rows.length > size ? String(items.at(-1)!.evidence_version) : null });
    }
    if (path === `/v1/payments/operator/refunds/${refundId}/document`) { documents.push(request.url()); return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from('external-proof') }); }
    if (method === 'POST' && (path.endsWith('/refunds') || path.includes(`/refunds/${refundId}/`))) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body, actor });
      if (actor === payer) return send({}, 403);
      if (path.endsWith('/refunds')) {
        createAttempts++;
        if (actor !== maker) return send({}, 403);
        if (createAttempts === 1 && options.unknownCreate && !options.commitUnknown) return send({}, options.unknownStatus ?? 503);
        refund = { ...seeded(), client_request_id: String(body.client_request_id), reason: String(body.reason), status: 'requested', version: 1, checker_id: null, approved_at: null };
        return send(options.writeReply?.(refund) ?? refund, createAttempts === 1 && options.unknownCreate ? options.unknownStatus ?? 503 : 200);
      }
      if (!refund) return send({}, 404);
      if (body.version !== refund.version) return send({}, 409);
      if (path.endsWith('/evidence') && options.unknownEvidence && options.commitEvidence === false) return send({}, 503);
      if (path.endsWith('/approve')) { if (actor !== checker || actor === refund.maker_id) return send({}, 403); refund = { ...refund, status: 'approved_external', checker_id: actor, approved_at: at, version: refund.version + 1 }; }
      else if (path.endsWith('/unknown')) { if (![refund.maker_id, refund.checker_id].includes(actor)) return send({}, 403); refund = { ...refund, status: 'unknown', notes: String(body.notes), version: refund.version + 1 }; }
      else if (path.endsWith('/evidence')) { if (actor !== refund.maker_id) return send({}, 403); if (!['approved_external', 'unknown', 'evidence_rejected'].includes(refund.status)) return send({}, 409); const evidence = Buffer.from(String(body.evidence_base64), 'base64'); if (evidence.length > 131072) return send({}, 400); refund = { ...refund, status: 'evidence_pending', notes: String(body.notes), external_reference: String(body.external_reference), executed_at: String(body.executed_at), evidence_sha256: createHash('sha256').update(evidence).digest('hex'), evidence_version: (refund.evidence_version ?? 0) + 1, rejection_reason: null, version: refund.version + 1 }; history.push({ evidence_version: refund.evidence_version!, evidence_sha256: refund.evidence_sha256!, external_reference: refund.external_reference!, executed_at: refund.executed_at!, actor_id: actor, notes: refund.notes!, created_at: at, rejected_by: null, rejection_reason: null, rejected_at: null }); }
      else if (path.endsWith('/evidence-rejections')) { if (actor !== refund.checker_id || actor === refund.maker_id) return send({}, 403); if (body.evidence_sha256 !== refund.evidence_sha256 || refund.status !== 'evidence_pending') return send({}, 409); const row = history.find((item) => item.evidence_version === refund!.evidence_version); if (row) Object.assign(row, { rejected_by: actor, rejection_reason: String(body.reason), rejected_at: at }); refund = { ...refund, status: 'evidence_rejected', rejection_reason: String(body.reason), version: refund.version + 1 }; }
      else if (path.endsWith('/verify')) { if (actor !== refund.checker_id || actor === refund.maker_id) return send({}, 403); if (body.evidence_sha256 !== refund.evidence_sha256 || refund.status !== 'evidence_pending') return send({}, 409); refund = { ...refund, status: 'refunded', frozen_minor_hkd: 0, verified_by: actor, version: refund.version + 1 }; }
      else { unexpected.push(path); return send({}, 404); }
      return send(options.writeReply?.(refund) ?? refund, (options.unknownEvidence && path.endsWith('/evidence')) || (options.unknownRejection && path.endsWith('/evidence-rejections')) ? 503 : 200);
    }
    unexpected.push(path); return send({}, 404);
  });
  return { writes, unexpected, history, documents, historyReads, refund: () => refund };
}
async function login(page: Page, handle: string) {
  await page.getByLabel('账号', { exact: true }).fill(handle); await page.getByLabel('密码', { exact: true }).fill('fictional-password');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看订单', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查看订单', exact: true }).click();
  const panel = page.getByRole('region', { name: '外部全额退款', exact: true });
  await expect(panel.getByText('CNY 93.00', { exact: true })).toBeVisible();
  return panel;
}
async function confirm(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name, exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '确认提交', exact: true }).click(); await expect(dialog).toHaveCount(0);
}

test('full refund separates payer, original maker, and original checker through evidence verification', async ({ page }) => {
  const f = await fixture(page); await page.goto('wallet-payments');
  let panel = await login(page, 'payer');
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('Full refund after independent review');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click();
  expect(f.writes).toHaveLength(0);
  await confirm(page, '确认：申请全额退款');
  await expect(panel.getByRole('button', { name: '批准外部退款', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'checker');
  await panel.getByRole('button', { name: '批准外部退款', exact: true }).click();
  await confirm(page, '确认：批准外部退款');
  await expect(panel.getByRole('button', { name: '上传退款凭证', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Provider result not confirmed yet');
  await panel.getByRole('button', { name: '登记外部结果未知', exact: true }).click();
  await confirm(page, '确认：登记外部结果未知');
  await expect(panel.getByText('外部结果未知', { exact: true })).toBeVisible();
  await expect(panel.getByText('Provider result not confirmed yet', { exact: true })).toBeVisible();
  await panel.getByLabel('凭证文件（最多 128 KiB）').setInputFiles({ name: 'refund-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('external-proof') });
  const hash = createHash('sha256').update('external-proof').digest('hex');
  await expect(panel.locator('.pay-hash')).toContainText(hash);
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill('EXTERNAL-REFUND-001');
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-11-02T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('External full refund independently executed');
  await panel.getByRole('button', { name: '上传退款凭证', exact: true }).click();
  await confirm(page, '确认：上传退款凭证');
  await expect(panel.getByText('凭证待原复审人核验', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'other');
  await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toBeDisabled();
  await expect(panel.getByText('仅原批准此退款的独立 checker 可核验凭证。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'checker');
  await expect(panel.getByText('External full refund independently executed', { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent('download');
  await panel.getByRole('button', { name: '下载原凭证核对', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe(`refund-evidence-${refundId}.bin`);
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill('b'.repeat(64));
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('一致的 SHA-256');
  expect(f.writes).toHaveLength(4);
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(hash);
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click();
  await confirm(page, '确认：复核凭证并完成退款记账');
  await expect(panel.getByText('凭证已核验，退款记账完成', { exact: true })).toBeVisible();
  expect(f.refund()?.status).toBe('refunded'); expect(f.writes).toHaveLength(5);
  expect(f.writes.map((write) => write.body.version ?? 'create')).toEqual(['create', 1, 2, 3, 4]);
  expect(f.unexpected).toEqual([]);
});

test('an unknown create queries first and retries only the original request and payload', async ({ page }) => {
  const f = await fixture(page, { unknownCreate: true }); await page.goto('wallet-payments'); const panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('Original immutable reason');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click(); await confirm(page, '确认：申请全额退款');
  await expect(panel.getByRole('alert')).toContainText('结果尚未确认');
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '按原载荷重试', exact: true }).click();
  await confirm(page, '确认按原载荷重试：申请全额退款');
  await expect(panel.getByText('等待独立复审批准', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(2); expect(f.writes[1]?.body).toEqual(f.writes[0]?.body);
  expect(f.unexpected).toEqual([]);
});

test('reload retains only recovery identity and cannot reconstruct or replace an unknown refund', async ({ page }) => {
  const f = await fixture(page, { unknownCreate: true }); await page.goto('wallet-payments'); let panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('PRIVATE-REASON-NOT-PERSISTED');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click(); await confirm(page, '确认：申请全额退款');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('PRIVATE-REASON-NOT-PERSISTED'); expect(storage).not.toContain('refund-test-'); expect(storage).not.toContain('fictional-password');
  await page.reload(); panel = await login(page, 'maker');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  await expect(panel.getByText(/本次内存已没有完整原载荷/)).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

test('confirmed create recovery clears pending state without a second write after reload', async ({ page }) => {
  const f = await fixture(page, { unknownCreate: true, commitUnknown: true }); await page.goto('wallet-payments'); let panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('Original reason stays private');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click(); await confirm(page, '确认：申请全额退款');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await page.reload(); panel = await login(page, 'maker');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByText('等待独立复审批准', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

test('evidence byte limits, date bounds, and account switching protect the upload form', async ({ page }) => {
  const f = await fixture(page, { initial: seeded() }); await page.goto('wallet-payments'); let panel = await login(page, 'maker');
  const file = panel.getByLabel('凭证文件（最多 128 KiB）');
  await file.setInputFiles({ name: 'oversize.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(131073, 1) });
  await expect(panel.getByRole('alert')).toContainText('1–131,072 字节');
  expect(f.writes).toHaveLength(0);
  await file.setInputFiles({ name: 'bounded.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(131072, 1) });
  await expect(panel.getByText(/bounded.bin · 131072 bytes/)).toBeVisible();
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill('EXTERNAL-001');
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-10-01T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Independent provider proof');
  await panel.getByRole('button', { name: '上传退款凭证', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('原付款与退款批准之后');
  expect(f.writes).toHaveLength(0);
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'checker');
  await expect(panel.getByText(/bounded.bin/)).toHaveCount(0);
  await expect(panel.getByLabel('凭证文件（最多 128 KiB）')).toHaveValue('');
  await expect(panel.getByRole('textbox', { name: /^外部退款流水/ })).toHaveValue('');
  await expect(panel.getByRole('button', { name: '上传退款凭证', exact: true })).toBeDisabled();
  expect(f.unexpected).toEqual([]);
});

test('401 discards the full refund payload and permits only original-identity queries after sign-in', async ({ page }) => {
  const f = await fixture(page, { unknownCreate: true, unknownStatus: 401 }); await page.goto('wallet-payments');
  let panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('Same-owner recovery after session expiry');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click();
  await confirm(page, '确认：申请全额退款');
  await expect(page.getByRole('button', { name: '登录并验证角色', exact: true })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('');
  panel = await login(page, 'maker');
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  await expect(panel.getByText(/本次内存已没有完整原载荷/)).toBeVisible();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('Same-owner recovery after session expiry');
  expect(storage).not.toContain('refund-test-');
  expect(f.writes).toHaveLength(1); expect(f.refund()).toBeNull();
  expect(f.unexpected).toEqual([]);
});

test('explicit sign-out discards proof and notes while hash-only recovery confirms the original upload', async ({ page }) => {
  const f = await fixture(page, { initial: seeded(), unknownEvidence: true }); await page.goto('wallet-payments');
  let panel = await login(page, 'maker');
  const proof = 'PRIVATE-BANK-PROOF-NOT-RETAINED';
  const reference = 'PRIVATE-BANK-REFERENCE';
  const notes = 'PRIVATE-FINANCIAL-NOTES-NOT-RETAINED';
  await panel.getByLabel('凭证文件（最多 128 KiB）').setInputFiles({ name: 'private-bank-proof.txt', mimeType: 'text/plain', buffer: Buffer.from(proof) });
  await expect(panel.locator('.pay-hash')).toContainText(createHash('sha256').update(proof).digest('hex'));
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill(reference);
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-11-02T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill(notes);
  await panel.getByRole('button', { name: '上传退款凭证', exact: true }).click();
  await confirm(page, '确认：上传退款凭证');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'other');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click();
  panel = await login(page, 'maker');
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await expect(panel.getByText(/本次内存已没有完整原载荷/)).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  for (const privateValue of [proof, Buffer.from(proof).toString('base64'), reference, notes, 'refund-test-', 'fictional-password']) expect(storage).not.toContain(privateValue);
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByText('凭证待原复审人核验', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.refund()?.status).toBe('evidence_pending');
  expect(f.unexpected).toEqual([]);
});

test('only the original checker returns evidence and correction appends history without another refund', async ({ page }) => {
  const oldHash = createHash('sha256').update('old-proof').digest('hex');
  const f = await fixture(page, { initial: { ...seeded(), status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: oldHash, external_reference: 'SAME-EXTERNAL-REFUND', executed_at: '2026-11-02T04:00:00.000Z', notes: 'Original evidence notes' }, historyPageSize: 1 });
  await page.goto('wallet-payments'); let panel = await login(page, 'maker');
  await expect(panel.getByRole('button', { name: '退回凭证补正', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'other');
  await expect(panel.getByRole('button', { name: '退回凭证补正', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'checker');
  await panel.getByRole('button', { name: '退回凭证补正', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('请填写补正原因'); expect(f.writes).toHaveLength(0);
  await panel.getByRole('textbox', { name: /^补正原因/ }).fill('Please provide a readable original receipt');
  await panel.getByRole('button', { name: '退回凭证补正', exact: true }).click();
  const rejection = page.getByRole('dialog', { name: '确认：退回凭证补正', exact: true });
  await expect(rejection).toContainText(oldHash); await expect(rejection).toContainText('保留冻结与历史版本');
  await confirm(page, '确认：退回凭证补正');
  await expect(panel.getByText('凭证已退回，等待原发起人补正', { exact: true })).toBeVisible();
  await expect(panel.getByText(/仅补正凭证，不要再次执行外部退款/)).toBeVisible();
  expect(f.refund()?.frozen_minor_hkd).toBe(10000);
  await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '提交补正凭证', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'maker');
  const corrected = Buffer.from('readable-corrected-proof');
  const newHash = createHash('sha256').update(corrected).digest('hex');
  await panel.getByLabel('凭证文件（最多 128 KiB）').setInputFiles({ name: 'corrected-proof.txt', mimeType: 'text/plain', buffer: corrected });
  await expect(panel.locator('.pay-hash')).toContainText(newHash);
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill('SAME-EXTERNAL-REFUND');
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-11-02T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Corrected evidence of the same external refund');
  await panel.getByRole('button', { name: '提交补正凭证', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认：提交补正凭证', exact: true })).toContainText('不重新执行外部退款');
  await confirm(page, '确认：提交补正凭证');
  await expect(panel.getByText('凭证待原复审人核验', { exact: true })).toBeVisible();
  expect(f.refund()?.evidence_version).toBe(2); expect(f.refund()?.frozen_minor_hkd).toBe(10000);
  expect(f.history).toHaveLength(2); expect(f.history[0]?.rejection_reason).toBe('Please provide a readable original receipt');
  await panel.getByRole('button', { name: '查看凭证历史', exact: true }).click();
  const history = panel.getByRole('region', { name: '退款凭证历史', exact: true });
  await expect(history.getByRole('article', { name: '凭证版本 2', exact: true })).toBeVisible();
  await expect(history.getByText('Corrected evidence of the same external refund', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: '下一页凭证', exact: true }).click();
  await expect(history.getByRole('article', { name: '凭证版本 1', exact: true })).toBeVisible();
  await expect(history.getByText('Please provide a readable original receipt', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await history.getByRole('button', { name: '下载版本 1 附件', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`refund-evidence-${refundId}-v1.bin`);
  expect(new URL(f.documents.at(-1)!).searchParams.get('version')).toBe('1');
  await expect(history.locator('iframe, object, embed')).toHaveCount(0);
  await history.getByRole('button', { name: '上一页凭证', exact: true }).click();
  await expect(history.getByRole('article', { name: '凭证版本 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'checker');
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(oldHash); await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('一致的 SHA-256'); expect(f.writes).toHaveLength(2);
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(newHash);
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click(); await confirm(page, '确认：复核凭证并完成退款记账');
  await expect(panel.getByText('凭证已核验，退款记账完成', { exact: true })).toBeVisible();
  expect(f.refund()?.frozen_minor_hkd).toBe(0);
  expect(f.writes.map((write) => write.path.split('/').at(-1))).toEqual(['evidence-rejections', 'evidence', 'verify']);
  expect(f.writes[0]?.body).toEqual({ version: 3, evidence_sha256: oldHash, reason: 'Please provide a readable original receipt' });
  expect(f.writes[1]?.body.version).toBe(4); expect(f.writes[2]?.body.version).toBe(5);
  expect(f.unexpected).toEqual([]);
});

test('unknown rejection survives sign-out as version and hash identity and never repeats the rejection', async ({ page }) => {
  const hash = createHash('sha256').update('review-proof').digest('hex');
  const f = await fixture(page, { initial: { ...seeded(), status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: hash, external_reference: 'REVIEW-REF-001', executed_at: '2026-11-02T04:00:00.000Z', notes: 'Execution notes' }, unknownRejection: true });
  await page.goto('wallet-payments'); let panel = await login(page, 'checker');
  await panel.getByRole('textbox', { name: /^补正原因/ }).fill('PRIVATE-CORRECTION-REASON');
  await panel.getByRole('button', { name: '退回凭证补正', exact: true }).click(); await confirm(page, '确认：退回凭证补正');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'checker');
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); expect(storage).not.toContain('PRIVATE-CORRECTION-REASON');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByText('凭证已退回，等待原发起人补正', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.refund()?.frozen_minor_hkd).toBe(10000); expect(f.unexpected).toEqual([]);
});

test('an unchanged rejected version cannot confirm a lost correction even when hash and execution identity match', async ({ page }) => {
  const hash = createHash('sha256').update('same-proof').digest('hex');
  const execution = await page.evaluate(() => new Date('2026-11-02T12:00').toISOString());
  const f = await fixture(page, { initial: { ...seeded(), status: 'evidence_rejected', version: 4, evidence_version: 1, evidence_sha256: hash, external_reference: 'SAME-REFUND-001', executed_at: execution, notes: 'Original note', rejection_reason: 'Clarify the supporting explanation' }, unknownEvidence: true, commitEvidence: false });
  await page.goto('wallet-payments'); const panel = await login(page, 'maker');
  await panel.getByLabel('凭证文件（最多 128 KiB）').setInputFiles({ name: 'same-proof.txt', mimeType: 'text/plain', buffer: Buffer.from('same-proof') });
  await expect(panel.locator('.pay-hash')).toContainText(hash);
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill('SAME-REFUND-001');
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-11-02T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Clarified explanation with the same original receipt');
  await panel.getByRole('button', { name: '提交补正凭证', exact: true }).click(); await confirm(page, '确认：提交补正凭证');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '提交补正凭证', exact: true })).toBeDisabled();
  await expect(panel.getByText('凭证已退回，等待原发起人补正', { exact: true })).toBeVisible();
  expect(f.refund()?.version).toBe(4); expect(f.refund()?.evidence_version).toBe(1); expect(f.writes).toHaveLength(1);
  expect(f.writes[0]?.body.executed_at).toBe(execution); expect(f.unexpected).toEqual([]);
});

test('a checker recovers an unknown rejection from its exact historical version after the maker has corrected it', async ({ page }) => {
  const originalHash = createHash('sha256').update('original-unreadable-proof').digest('hex');
  const f = await fixture(page, { initial: { ...seeded(), status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: originalHash, external_reference: 'UNCHANGED-EXTERNAL-REFUND', executed_at: '2026-11-02T04:00:00.000Z', notes: 'Original receipt' }, unknownRejection: true, historyPageSize: 1 });
  await page.goto('wallet-payments'); let panel = await login(page, 'checker');
  await panel.getByRole('textbox', { name: /^补正原因/ }).fill('Provide a legible copy of the same external refund receipt');
  await panel.getByRole('button', { name: '退回凭证补正', exact: true }).click(); await confirm(page, '确认：退回凭证补正');
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  expect(f.refund()?.status).toBe('evidence_rejected');
  expect(f.writes[0]?.body).toEqual({ version: 3, evidence_sha256: originalHash, reason: 'Provide a legible copy of the same external refund receipt' });
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'maker');
  const corrected = Buffer.from('legible-copy-of-original-refund-proof');
  const correctedHash = createHash('sha256').update(corrected).digest('hex');
  await panel.getByLabel('凭证文件（最多 128 KiB）').setInputFiles({ name: 'legible-proof.txt', mimeType: 'text/plain', buffer: corrected });
  await expect(panel.locator('.pay-hash')).toContainText(correctedHash);
  await panel.getByRole('textbox', { name: /^外部退款流水/ }).fill('UNCHANGED-EXTERNAL-REFUND');
  await panel.getByLabel('实际执行时间（本机时区）').fill('2026-11-02T12:00');
  await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Only the receipt copy is corrected; no second external refund');
  await panel.getByRole('button', { name: '提交补正凭证', exact: true }).click(); await confirm(page, '确认：提交补正凭证');
  await expect(panel.getByText('凭证待原复审人核验', { exact: true })).toBeVisible();
  expect(f.refund()?.evidence_version).toBe(2); expect(f.refund()?.version).toBe(5);
  await page.getByRole('button', { name: '退出 / 切换账号', exact: true }).click(); panel = await login(page, 'checker');
  await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toBeEnabled();
  expect(f.historyReads).toHaveLength(2);
  expect(new URL(f.historyReads[0]!).searchParams.get('cursor')).toBeNull();
  expect(new URL(f.historyReads[1]!).searchParams.get('cursor')).toBe('2');
  expect(f.writes).toHaveLength(2);
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(correctedHash); await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click(); await confirm(page, '确认：复核凭证并完成退款记账');
  await expect(panel.getByText('凭证已核验，退款记账完成', { exact: true })).toBeVisible();
  expect(f.writes.map((write) => write.path.split('/').at(-1))).toEqual(['evidence-rejections', 'evidence', 'verify']);
  expect(f.unexpected).toEqual([]);
});


test('a successful create response with another request ID preserves the original recovery identity', async ({ page }) => {
  const f = await fixture(page, { writeReply: (refund) => ({ ...refund, client_request_id: other }) });
  await page.goto('wallet-payments'); const panel = await login(page, 'maker');
  await panel.getByRole('textbox', { name: /^退款原因/ }).fill('Original request must survive a mismatched receipt');
  await panel.getByRole('button', { name: '申请全额退款', exact: true }).click(); await confirm(page, '确认：申请全额退款');
  await expect(panel.getByRole('alert')).toContainText('结果尚未确认');
  await expect(panel.getByRole('button', { name: '申请全额退款', exact: true })).toBeDisabled();
  const references = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('q-payment-recovery-v2:')).flatMap(([, value]) => JSON.parse(value).items));
  expect(references).toHaveLength(1);
  expect(references[0].identity.client_request_id).toBe(f.writes[0]?.body.client_request_id);
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByText('等待独立复审批准', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

for (const mismatch of ['refund-id', 'state', 'evidence'] as const) {
  test(`a successful verification response with wrong ${mismatch} cannot discard the pending refund`, async ({ page }) => {
    const hash = createHash('sha256').update('verified-proof').digest('hex');
    const f = await fixture(page, {
      initial: { ...seeded(), status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: hash, external_reference: 'VERIFIED-ORIGINAL', executed_at: '2026-11-02T04:00:00.000Z', notes: 'Original receipt' },
      writeReply: (refund) => mismatch === 'refund-id' ? { ...refund, refund_id: other }
        : mismatch === 'state' ? { ...refund, status: 'evidence_pending', verified_by: null, frozen_minor_hkd: 10000 }
          : { ...refund, evidence_sha256: 'b'.repeat(64) },
    });
    await page.goto('wallet-payments'); const panel = await login(page, 'checker');
    await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(hash);
    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click();
    await confirm(page, '确认：复核凭证并完成退款记账');
    await expect(panel.getByRole('alert')).toContainText('结果尚未确认');
    await expect(panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true })).toBeDisabled();
    const references = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('q-payment-recovery-v2:')).flatMap(([, value]) => JSON.parse(value).items));
    expect(references).toHaveLength(1); expect(references[0].identity).toEqual({ version: 3, evidence_sha256: hash, evidence_version: 1 });
    await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
    await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
    await expect(panel.getByText('凭证已核验，退款记账完成', { exact: true })).toBeVisible();
    expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
  });
}

const recoveryStorage = `q-payment-recovery-v2:${encodeURIComponent('http://127.0.0.1:18789')}:${encodeURIComponent(maker)}`;
async function seedRecovery(page: Page, actor: string, kind: 'unknown' | 'verify', identity: Record<string, string | number>) {
  await page.addInitScript(({ actor, kind, identity, payment, refundId, at }) => {
    const origin = 'http://127.0.0.1:18789';
    const key = `q-payment-recovery-v2:${encodeURIComponent(origin)}:${encodeURIComponent(actor)}`;
    if (localStorage.getItem(key) !== null) return;
    localStorage.setItem(key, JSON.stringify({ version: 2, origin, owner: actor, items: [{
      key: `refund-${kind}:${payment}`, path: `/v1/payments/operator/refunds/${refundId}/${kind}`,
      recoveryPath: `/v1/payments/operator/refunds/${refundId}`, createdAt: at, identity,
    }] }));
  }, { actor, kind, identity, payment, refundId, at });
}

for (const amountField of ['pay_amount_minor_cny', 'credit_amount_minor_hkd'] as const) {
  test(`restored refund recovery rejects a GET with changed ${amountField} before updating context`, async ({ page }) => {
    let wrongAmount = true;
    const f = await fixture(page, {
      initial: seeded(), writeReply: (refund) => ({ ...refund, status: 'approved_external' }),
      refundReadReply: (refund) => wrongAmount ? { ...refund, [amountField]: refund[amountField] + 1 } : refund,
    });
    await page.goto('wallet-payments'); let panel = await login(page, 'maker');
    await panel.getByRole('textbox', { name: /^外部执行说明/ }).fill('Unknown provider result must retain its approved participants');
    await panel.getByRole('button', { name: '登记外部结果未知', exact: true }).click(); await confirm(page, '确认：登记外部结果未知');
    await expect(panel.getByRole('alert')).toContainText('结果尚未确认');
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), recoveryStorage);
    expect(saved.items[0].identity).toEqual({ version: 2, maker_id: maker, checker_id: checker });
    expect(f.writes[0]?.body).toEqual({ version: 2, notes: 'Unknown provider result must retain its approved participants' });
    await page.reload(); panel = await login(page, 'maker');
    await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
    await expect(panel.getByText('CNY 93.00', { exact: true })).toBeVisible();
    await expect(panel.getByText('HKD 100.00', { exact: true })).toHaveCount(2);
    await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
    wrongAmount = false;
    await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
    await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
    expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
  });
}

test('restored unknown recovery requires the original approved maker/checker and a newer version', async ({ page }) => {
  let replacement: Partial<Refund> = {};
  const f = await fixture(page, { initial: { ...seeded(), status: 'unknown', version: 3 }, refundReadReply: (refund) => ({ ...refund, ...replacement }) });
  await seedRecovery(page, maker, 'unknown', { version: 2, maker_id: maker, checker_id: checker });
  await page.goto('wallet-payments'); const panel = await login(page, 'maker');
  for (const mismatch of [{ maker_id: other }, { checker_id: other }, { approved_at: null }, { version: 2 }] satisfies Partial<Refund>[]) {
    replacement = mismatch;
    await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
    await expect(panel.getByText(/尚未确认原写入结果/)).toBeVisible();
    await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  }
  replacement = {};
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  expect(f.writes).toHaveLength(0); expect(f.unexpected).toEqual([]);
});

test('legacy unknown recovery without original participants remains readable but unconfirmed', async ({ page }) => {
  const f = await fixture(page, { initial: { ...seeded(), status: 'unknown', version: 3 } });
  await seedRecovery(page, maker, 'unknown', { version: 2 });
  await page.goto('wallet-payments'); const panel = await login(page, 'maker');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByText(/尚未确认原写入结果/)).toBeVisible();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  expect(f.writes).toHaveLength(0); expect(f.unexpected).toEqual([]);
});

test('verification binds the captured evidence version across POST and restored GET despite identical hashes', async ({ page }) => {
  const hash = createHash('sha256').update('same-version-proof').digest('hex');
  let wrongVersion = true;
  const f = await fixture(page, {
    initial: { ...seeded(), status: 'evidence_pending', version: 3, evidence_version: 1, evidence_sha256: hash, external_reference: 'ONE-EXTERNAL-REFUND', executed_at: at },
    writeReply: (refund) => ({ ...refund, evidence_version: 2 }),
    refundReadReply: (refund) => wrongVersion ? { ...refund, evidence_version: 2 } : refund,
  });
  await page.goto('wallet-payments'); let panel = await login(page, 'checker');
  await panel.getByRole('textbox', { name: '核对 SHA-256', exact: true }).fill(hash); await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '复核凭证并完成退款记账', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('当前凭证版本: 1', { exact: true })).toBeVisible();
  await confirm(page, '确认：复核凭证并完成退款记账');
  await expect(panel.getByRole('alert')).toContainText('结果尚未确认');
  expect(f.writes[0]?.body).toEqual({ version: 3, evidence_sha256: hash });
  await page.reload(); panel = await login(page, 'checker');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByText(/尚未确认原写入结果/)).toBeVisible();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  wrongVersion = false;
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toHaveCount(0);
  await expect(panel.getByText('凭证已核验，退款记账完成', { exact: true })).toBeVisible();
  expect(f.writes).toHaveLength(1); expect(f.unexpected).toEqual([]);
});

test('legacy verification without an evidence version remains queryable and cannot infer it from the current refund', async ({ page }) => {
  const hash = createHash('sha256').update('legacy-proof').digest('hex');
  const f = await fixture(page, { initial: { ...seeded(), status: 'refunded', version: 4, evidence_version: 1, evidence_sha256: hash, external_reference: 'LEGACY-EXTERNAL', executed_at: at, verified_by: checker, frozen_minor_hkd: 0 } });
  await seedRecovery(page, checker, 'verify', { version: 3, evidence_sha256: hash });
  await page.goto('wallet-payments'); const panel = await login(page, 'checker');
  await panel.getByRole('button', { name: '查询原退款记录', exact: true }).click();
  await expect(panel.getByText(/尚未确认原写入结果/)).toBeVisible();
  await expect(panel.getByRole('button', { name: '查询原退款记录', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '按原载荷重试', exact: true })).toBeDisabled();
  expect(f.writes).toHaveLength(0); expect(f.unexpected).toEqual([]);
});
