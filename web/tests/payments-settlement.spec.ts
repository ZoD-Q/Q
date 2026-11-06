import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

const maker = '22222222-2222-4222-8222-222222222222';
const checker = '33333333-3333-4333-8333-333333333333';
const batch = '44444444-4444-4444-8444-444444444444';
const at = '2026-11-05T02:00:00Z';
const mapping = Buffer.from(JSON.stringify({ currency: 'CNY', rows: [{ merchant_order_no: 'order-1', provider_trade_no: 'trade-1', gross_minor: 10000, channel_fee_minor: 100, net_minor: 9900 }] }));
const original = Buffer.from('%PDF-1.7\noriginal document fixture');
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const prefix = '/v1/payments/operator/settlements';

async function fixture(page: Page, options: { unknownImport?: boolean; missingRecovery?: boolean; wrongRecovery?: boolean; recheck?: 'success' | 'unknown' | 'wrong_actor' | 'unchanged'; pagedChecks?: boolean } = {}) {
  let actor = maker; let imports = 0; let verifications = 0; let recoveries = 0; let rechecks = 0;
  let record = { settlement_id: batch, client_request_id: '55555555-5555-4555-8555-555555555555', kind: 'order_reconciliation', source: 'Existing source', currency: 'CNY', status: 'awaiting_verification', mapping_sha256: hash(mapping), evidence_sha256: hash(original), source_document_media_type: 'application/pdf', bank_reference: null as string | null, bank_amount_minor: null as number | null, check_version: 1, record_count: 1, matched_count: 1, differences: [] as { row: number; code: string }[], maker_id: maker, checker_id: null as string | null, created_at: at, verified_at: null as string | null, source_validation: 'operator_supplied' };
  if (options.recheck) record = { ...record, status: 'discrepancy', matched_count: 0, differences: [{ row: 1, code: 'WALLET_NOT_CREDITED' }] };
  let checks = [{ check_version: 1, matched_count: record.matched_count, differences: record.differences, actor_id: maker, created_at: at }];
  if (options.pagedChecks) { record.check_version = 3; checks = [3, 2, 1].map((version) => ({ ...checks[0]!, check_version: version })); }
  await page.route('http://127.0.0.1:18789/v1/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value), headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST' } });
    if (path === '/v1/auth/login') { actor = request.postDataJSON().handle === 'checker' ? checker : maker; return send({ token: `fixture-${actor}`, user: { id: actor } }); }
    if (path === '/v1/auth/logout') return route.fulfill({ status: 204 });
    if (path.endsWith('/operator/me')) return send({ user_id: actor, roles: ['maker', 'checker'], server_time: at });
    if (path.endsWith('/operator/orders')) return send({ items: [], next_cursor: null });
    if (path === prefix && request.method() === 'GET') return send({ items: [record], next_cursor: null });
    if (path === prefix && request.method() === 'POST') {
      imports++; const body = request.postDataJSON();
      const normalized = JSON.parse(Buffer.from(body.evidence_base64, 'base64').toString('utf8'));
      record = { ...record, source: body.source, client_request_id: body.client_request_id, maker_id: actor, kind: body.kind, currency: normalized.currency, record_count: normalized.rows.length, matched_count: normalized.rows.length, bank_reference: body.bank_reference, bank_amount_minor: body.bank_amount_minor,
        mapping_sha256: hash(Buffer.from(body.evidence_base64, 'base64')), evidence_sha256: hash(Buffer.from(body.source_document_base64, 'base64')) };
      return send(record, options.unknownImport ? 503 : 200);
    }
    if (path.startsWith(`${prefix}/by-client-key/`)) { recoveries++; return send(options.wrongRecovery ? { ...record, client_request_id: '66666666-6666-4666-8666-666666666666' } : record, options.missingRecovery ? 404 : 200); }
    if (path === `${prefix}/${batch}/rechecks`) {
      rechecks++; expect(request.postDataJSON()).toEqual({});
      if (options.recheck !== 'unchanged') {
        record = { ...record, check_version: record.check_version + 1, status: 'awaiting_verification', matched_count: 1, differences: [] };
        checks.unshift({ check_version: record.check_version, matched_count: 1, differences: [], actor_id: options.recheck === 'wrong_actor' ? checker : actor, created_at: at });
      }
      return send(record, options.recheck === 'success' ? 200 : 503);
    }
    if (path === `${prefix}/${batch}/checks`) {
      const cursor = new URL(request.url()).searchParams.get('cursor');
      return send({ items: options.pagedChecks ? (cursor ? checks.filter((entry) => entry.check_version < Number(cursor)) : checks.slice(0, 2)) : checks, next_cursor: options.pagedChecks && !cursor ? '2' : null });
    }
    if (path === `${prefix}/${batch}`) return send(record);
    if (path === `${prefix}/${batch}/verify`) { verifications++; record = { ...record, status: 'operator_verified', checker_id: actor, verified_at: at }; return send(record); }
    if (path.endsWith('/document')) return route.fulfill({ status: 200, body: original, contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="evidence.pdf"' } });
    return send({}, 404);
  });
  return { imports: () => imports, verifications: () => verifications, recoveries: () => recoveries, rechecks: () => rechecks };
}
async function login(page: Page, user = 'maker') {
  await page.getByLabel('账号', { exact: true }).fill(user);
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await page.getByRole('link', { name: '结算与储备凭证', exact: true }).click();
  await expect(page.getByRole('heading', { name: '结算与原始凭证', exact: true })).toBeVisible();
}
async function importEvidence(page: Page, normalized = mapping) {
  await page.getByLabel('资料来源名称', { exact: true }).fill('Uploaded evidence');
  await page.getByLabel('规范化 JSON 文件', { exact: true }).setInputFiles({ name: 'mapping.json', mimeType: 'application/json', buffer: normalized });
  await page.getByLabel('原始凭证文件', { exact: true }).setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: original });
  await page.getByRole('button', { name: '校验文件并核对导入', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认导入资料', exact: true });
  await expect(confirm).toContainText(hash(normalized)); await expect(confirm).toContainText(hash(original));
  await confirm.getByRole('button', { name: '确认提交', exact: true }).click();
}

test('settlement import hashes both files and cannot attest its own evidence', async ({ page }) => {
  const state = await fixture(page); await page.goto('wallet-payments'); await login(page); await importEvidence(page);
  const detail = page.locator('.pay-detail');
  await expect(detail).toContainText('Uploaded evidence');
  await expect(detail).toContainText('不能复核自己导入的材料');
  await expect(detail.getByRole('button', { name: '核对后提交人工核材', exact: true })).toBeDisabled();
  expect(state.imports()).toBe(1); expect(state.verifications()).toBe(0);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain(original.toString('base64')); expect(storage).not.toContain(mapping.toString('base64')); expect(storage).not.toContain('fixture-password');
  const download = page.waitForEvent('download');
  await detail.getByRole('button', { name: '下载原始凭证', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`source-${batch}.pdf`);
  expect(await page.locator('iframe,object,embed').count()).toBe(0);
});

test('a separate checker confirms manual evidence without bank API or FX success claims', async ({ page }) => {
  const state = await fixture(page); await page.goto('wallet-payments'); await login(page, 'checker');
  await page.getByRole('button', { name: 'Existing source', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '核对后提交人工核材', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认人工核材', exact: true });
  await expect(confirm).toContainText('不自动调用银行'); await expect(confirm).toContainText(hash(mapping));
  await confirm.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.locator('.pay-detail')).toContainText('人工核材完成');
  expect(state.verifications()).toBe(1); expect(state.imports()).toBe(0);
});

test('unknown imports recover the original key through GET without duplicate writes', async ({ page }) => {
  const state = await fixture(page, { unknownImport: true }); await page.goto('wallet-payments'); await login(page); await importEvidence(page);
  await expect(page.getByRole('alert')).toContainText('结果待确认');
  await expect(page.getByRole('button', { name: '校验文件并核对导入', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '手动重试原请求', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '查询原记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询原记录', exact: true })).toHaveCount(0);
  expect(state.recoveries()).toBe(1); expect(state.imports()).toBe(1);
});

test('a missing recovery endpoint retains the request and reload never persists file payloads', async ({ page }) => {
  const state = await fixture(page, { unknownImport: true, missingRecovery: true }); await page.goto('wallet-payments'); await login(page); await importEvidence(page);
  await page.getByRole('button', { name: '查询原记录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('404 不证明未执行');
  await expect(page.getByRole('button', { name: '校验文件并核对导入', exact: true })).toBeDisabled();
  expect(state.imports()).toBe(1);
  await page.reload(); await login(page);
  await expect(page.getByRole('button', { name: '手动重试原请求', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '查询原记录', exact: true })).toBeVisible();
});

test('a mismatched recovery receipt never clears the original import', async ({ page }) => {
  const state = await fixture(page, { unknownImport: true, wrongRecovery: true }); await page.goto('wallet-payments'); await login(page); await importEvidence(page);
  await page.getByRole('button', { name: '查询原记录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '查询原记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '校验文件并核对导入', exact: true })).toBeDisabled();
  expect(state.imports()).toBe(1);
});

test('malformed normalization is rejected locally before any import POST', async ({ page }) => {
  const state = await fixture(page); await page.goto('wallet-payments'); await login(page);
  await page.getByLabel('资料来源名称', { exact: true }).fill('Bad evidence');
  await page.getByLabel('规范化 JSON 文件', { exact: true }).setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"currency":"CNY","currency":"HKD","rows":[]}') });
  await page.getByLabel('原始凭证文件', { exact: true }).setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: original });
  await page.getByRole('button', { name: '校验文件并核对导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('文件未通过校验'); expect(state.imports()).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('mixed payment and refund evidence accepts zero and negative CNY bank totals without claiming a new refund', async ({ page }) => {
  const state = await fixture(page); await page.goto('wallet-payments'); await login(page);
  await page.getByRole('combobox', { name: '批次类型', exact: true }).selectOption('bank_settlement');
  await expect(page.getByRole('combobox', { name: '批次类型', exact: true })).toHaveValue('bank_settlement');
  await page.getByRole('button', { name: '校验文件并核对导入', exact: true }).scrollIntoViewIfNeeded();
  for (const [fee, net, total] of [[-100, -9900, '0'], [-75, -9925, '-25']] as const) {
    await page.getByLabel('银行参考编号', { exact: true }).fill(`bank-net-${total}`);
    await page.getByLabel('银行金额（整数最小单位）', { exact: true }).fill(total);
    const normalized = Buffer.from(JSON.stringify({ currency: 'CNY', rows: [
      { merchant_order_no: 'order-1', provider_trade_no: 'trade-1', gross_minor: 10000, channel_fee_minor: 100, net_minor: 9900 },
      { entry_kind: 'refund', refund_external_reference: 'original-refund', merchant_order_no: 'order-1', provider_trade_no: 'trade-1', gross_minor: -10000, channel_fee_minor: fee, net_minor: net },
    ] }));
    await importEvidence(page, normalized);
    await expect(page.locator('.pay-detail')).toContainText(`bank-net-${total}`);
    await expect(page.locator('.pay-detail').getByText('银行金额（分）', { exact: true }).locator('..').locator('dd')).toHaveText(total);
    await expect(page.locator('.pay-detail')).toContainText('等待独立复核');
  }
  expect(state.imports()).toBe(2); expect(state.verifications()).toBe(0);
});

test('a refund row missing its original external reference cannot be submitted', async ({ page }) => {
  const state = await fixture(page); await page.goto('wallet-payments'); await login(page);
  await page.getByLabel('资料来源名称', { exact: true }).fill('Refund source');
  await page.getByLabel('规范化 JSON 文件', { exact: true }).setInputFiles({ name: 'refund.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ currency: 'CNY', rows: [
    { entry_kind: 'refund', merchant_order_no: 'order-1', provider_trade_no: 'trade-1', gross_minor: -10000, channel_fee_minor: -100, net_minor: -9900 },
  ] })) });
  await page.getByLabel('原始凭证文件', { exact: true }).setInputFiles({ name: 'original.pdf', mimeType: 'application/pdf', buffer: original });
  await page.getByRole('button', { name: '校验文件并核对导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('文件未通过校验');
  expect(state.imports()).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('rechecking original material appends history and requires fresh independent attestation', async ({ page }) => {
  const state = await fixture(page, { recheck: 'success' }); await page.goto('wallet-payments'); await login(page, 'checker');
  await page.getByRole('button', { name: 'Existing source', exact: true }).click();
  const detail = page.locator('.pay-detail');
  await expect(detail).toContainText('存在对账差异');
  await detail.getByRole('button', { name: '按原材料重新核对', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认按原材料重核', exact: true });
  await expect(confirm).toContainText(hash(mapping)); await expect(confirm).toContainText(hash(original));
  await confirm.getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(detail).toContainText('等待独立复核');
  await expect(detail.getByRole('checkbox')).toBeDisabled();
  await expect(detail).toContainText('WALLET_NOT_CREDITED'); // Original check remains in history.
  await detail.getByRole('button', { name: '刷新批次与核对历史', exact: true }).click();
  await detail.getByRole('checkbox').check();
  await detail.getByRole('button', { name: '核对后提交人工核材', exact: true }).click();
  await page.getByRole('dialog', { name: '确认人工核材', exact: true }).getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(detail).toContainText('人工核材完成');
  await expect(detail.getByRole('button', { name: '按原材料重新核对', exact: true })).toHaveCount(0);
  expect(state.rechecks()).toBe(1); expect(state.verifications()).toBe(1); expect(state.imports()).toBe(0);
});

test('unknown recheck only recovers through matching later check history and never offers POST retry', async ({ page }) => {
  const state = await fixture(page, { recheck: 'unknown' }); await page.goto('wallet-payments'); await login(page);
  await page.getByRole('button', { name: 'Existing source', exact: true }).click();
  await page.getByRole('button', { name: '按原材料重新核对', exact: true }).click();
  await page.getByRole('dialog', { name: '确认按原材料重核', exact: true }).getByRole('button', { name: '确认提交', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('结果待确认');
  await expect(page.getByRole('button', { name: '手动重试原请求', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '查询原记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询原记录', exact: true })).toHaveCount(0);
  expect(state.rechecks()).toBe(1);
});

for (const outcome of ['wrong_actor', 'unchanged'] as const) test(`recheck recovery keeps the original request when history is ${outcome}`, async ({ page }) => {
  const state = await fixture(page, { recheck: outcome }); await page.goto('wallet-payments'); await login(page);
  await page.getByRole('button', { name: 'Existing source', exact: true }).click();
  await page.getByRole('button', { name: '按原材料重新核对', exact: true }).click();
  await page.getByRole('dialog', { name: '确认按原材料重核', exact: true }).getByRole('button', { name: '确认提交', exact: true }).click();
  await page.getByRole('button', { name: '查询原记录', exact: true }).click();
  await expect(page.getByRole('button', { name: '查询原记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '手动重试原请求', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '按原材料重新核对', exact: true })).toBeDisabled();
  expect(state.rechecks()).toBe(1);
});

test('check history follows its calculation-version cursor without changing source evidence', async ({ page }) => {
  const state = await fixture(page, { pagedChecks: true }); await page.goto('wallet-payments'); await login(page);
  await page.getByRole('button', { name: 'Existing source', exact: true }).click();
  const history = page.locator('.pay-detail section').filter({ has: page.getByRole('heading', { name: '核对历史', exact: true }) });
  await expect(history.getByText('版本 3', { exact: true })).toBeVisible();
  await expect(history.getByText('版本 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '更多核对历史', exact: true }).click();
  await expect(history.getByText('版本 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '更多核对历史', exact: true })).toHaveCount(0);
  expect(state.rechecks()).toBe(0); expect(state.imports()).toBe(0);
});
