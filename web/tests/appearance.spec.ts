import { expect, test, type Page, type Locator } from '@playwright/test';

const apiOrigin = 'http://127.0.0.1:18789';
const maker = '22222222-2222-4222-8222-222222222222';
const payer = '11111111-1111-4111-8111-111111111111';
const payment = '44444444-4444-4444-8444-444444444444';
const at = '2026-11-06T02:00:00.000Z';

async function fixture(page: Page) {
  let failOrders = false;
  const unexpected: string[] = [];
  const order = {
    payment_id: payment, account_id: payer, channel: 'alipay', pay_currency: 'CNY', credit_currency: 'HKD',
    status: 'awaiting_credit_approval', queue: 'first_review', credit_amount_minor_hkd: 10000,
    pay_amount_minor_cny: 9300, fee_minor_cny: 100, evidence_version: 2, created_at: at, updated_at: at,
    error_code: null, refund_status: null,
  };
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body), headers });
    if (url.origin !== apiOrigin) {
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.startsWith('/q-admin/') && request.method() === 'GET' && !['fetch', 'xhr'].includes(request.resourceType())) return route.continue();
      unexpected.push(request.url()); return route.abort();
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/v1/auth/login' && request.method() === 'POST') return send({ token: 'appearance-fixture-only', user: { id: maker } });
    if (url.pathname === '/v1/auth/logout' && request.method() === 'POST') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/v1/payments/operator/me') return send({ user_id: maker, roles: ['maker'], server_time: at });
    if (url.pathname === '/v1/payments/operator/orders') return failOrders ? send({ error: { code: 'UNAVAILABLE' } }, 503) : send({ items: [order], next_cursor: null });
    if (url.pathname === `/v1/payments/operator/orders/${payment}`) return send({ order, merchant_order_no: 'QA-APPEARANCE-ORDER', provider_trade_no: 'QA-APPEARANCE-TRADE', provider_paid_at: at, verified_at: at, evidence_sha256: 'a'.repeat(64), proposal: null, approval: null, refund: null, audit: [] });
    if (url.pathname === '/v1/payments/operator/settlements' || url.pathname === '/v1/payments/operator/audit') return send({ items: [], next_cursor: null });
    if (url.pathname === '/v1/payments/fx/status') return send({
      mode: 'manual', state: 'unconfigured', generation: null, policy_fingerprint: '', current: null, candidate: null,
      last_checked_at: null, last_success_at: null, last_error_code: null, hold_reason: null,
      next_attempt_at: null, last_http_status: null, refresh_in_progress: false,
      alerts: { within_24h: false, within_6h: false, stale: true, held: false }, server_time: at,
    });
    unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  return { unexpected, setOrderFailure: (value: boolean) => { failOrders = value; } };
}

async function login(page: Page) {
  await page.getByLabel('账号', { exact: true }).fill('qa-appearance');
  await page.getByLabel('密码', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: '登录并验证角色', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出 / 切换账号', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看订单', exact: true })).toBeVisible();
}

async function checkColorsAndContrast(page: Page) {
  const result = await page.evaluate(() => {
    type Color = [number, number, number, number];
    const parse = (value: string): Color | null => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) return null;
      const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return parts.length >= 3 ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : null;
    };
    const blend = (front: Color, back: Color): Color => [
      front[0] * front[3] + back[0] * (1 - front[3]),
      front[1] * front[3] + back[1] * (1 - front[3]),
      front[2] * front[3] + back[2] * (1 - front[3]), 1,
    ];
    const allowed = (color: Color) => color[3] === 0 || (color[0] === 0 && Math.abs(color[1] - color[2]) < .1) || (color[1] === 0 && color[2] === 0);
    const visible = (element: Element) => {
      if (!element.getClientRects().length) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const identify = (element: Element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${String(element.getAttribute('class') ?? '').replaceAll(' ', '.')}`;
    const paletteErrors: string[] = [];
    const contrastErrors: string[] = [];
    let colorChecks = 0;
    let textChecks = 0;
    const properties = ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color', 'caret-color', 'fill', 'stroke', 'box-shadow', 'text-shadow', 'background-image', 'accent-color'];
    const inspect = (element: Element, pseudo?: string) => {
      const style = getComputedStyle(element, pseudo);
      for (const property of properties) {
        for (const raw of style.getPropertyValue(property).match(/rgba?\([^)]+\)/g) ?? []) {
          const color = parse(raw);
          if (!color) continue;
          colorChecks++;
          if (!allowed(color)) paletteErrors.push(`${identify(element)}${pseudo ?? ''} ${property}: ${raw}`);
        }
      }
    };
    const luminance = (color: Color) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      inspect(element);
      inspect(element, '::selection');
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (style.content !== 'none' && style.content !== 'normal' && style.display !== 'none') inspect(element, pseudo);
      }
      if (element.matches('input[placeholder], textarea[placeholder]')) inspect(element, '::placeholder');
      if (element.matches('input[type=file]')) inspect(element, '::file-selector-button');
      if (element.matches('li, summary')) inspect(element, '::marker');
      if (element.matches('dialog[open]')) inspect(element, '::backdrop');
      if (element.matches('.table-scroll') || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) {
        for (const pseudo of ['::-webkit-scrollbar', '::-webkit-scrollbar-thumb', '::-webkit-scrollbar-corner']) inspect(element, pseudo);
      }
      if (element.matches(':disabled') || element.closest('fieldset:disabled') || element.getAttribute('aria-hidden') === 'true') continue;
      const hasText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
      const textInput = element.matches('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select');
      if (!hasText && !textInput) continue;
      let background: Color = [0, 0, 0, 1];
      const ancestry: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) ancestry.unshift(node);
      for (const node of ancestry) {
        const fill = parse(getComputedStyle(node).backgroundColor);
        if (fill) background = blend(fill, background);
      }
      const foreground = parse(getComputedStyle(element).color);
      if (!foreground) continue;
      const rendered = blend(foreground, background);
      const values = [luminance(rendered), luminance(background)].sort((a, b) => a - b);
      const contrast = (values[1] + .05) / (values[0] + .05);
      textChecks++;
      if (contrast < 4.5) contrastErrors.push(`${identify(element)} ${contrast.toFixed(2)}: ${element.textContent?.trim().slice(0, 45)}`);
    }
    return { paletteErrors: [...new Set(paletteErrors)], contrastErrors, colorChecks, textChecks };
  });
  expect(result.colorChecks).toBeGreaterThan(100);
  expect(result.textChecks).toBeGreaterThan(8);
  expect(result.paletteErrors, 'Visible elements and generated content use only black, cyan and red families').toEqual([]);
  expect(result.contrastErrors, 'All sampled enabled text meets 4.5:1 after alpha compositing').toEqual([]);
}

async function checkOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ body: document.body.scrollWidth, root: document.documentElement.scrollWidth, width: innerWidth }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.root).toBeLessThanOrEqual(dimensions.width);
}
async function checkFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  const focus = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return { visible: element.matches(':focus-visible'), width: parseFloat(style.outlineWidth), style: style.outlineStyle, color: style.outlineColor, top: bounds.top, bottom: bounds.bottom, viewport: innerHeight };
  });
  expect(focus.visible).toBe(true);
  expect(focus.width).toBeGreaterThanOrEqual(2);
  expect(focus.style).not.toBe('none');
  expect(focus.color).toBe('rgb(0, 255, 255)');
  expect(focus.bottom).toBeGreaterThan(0);
  expect(focus.top).toBeLessThan(focus.viewport);
}
async function noDemoUi(page: Page) {
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'operations');
  await expect(page.locator('img, video, canvas, .metrics, .demo-banner')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /外观主题|Theme|演示操作者|Demo operator/ })).toHaveCount(0);
  await expect(page.getByText(/演示原型|虚构演示数据|Fictional demo data|Interactive demo/)).toHaveCount(0);
}

test('operations colors, text contrast and error states use the three-color system', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: '使用 Q 账号登录', exact: true })).toBeVisible();
  await noDemoUi(page); await checkColorsAndContrast(page);
  await login(page);
  await noDemoUi(page); await checkColorsAndContrast(page);
  await page.screenshot({ path: 'test-results/operators-desktop.png', fullPage: true });
  f.setOrderFailure(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(page.getByRole('alert')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await checkColorsAndContrast(page);
  expect(f.unexpected).toEqual([]);
});

test('375px operations routes remain usable in both languages without page overflow', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('./');
  await checkOverflow(page); await login(page);
  for (const locale of ['zh', 'en']) {
    if (locale === 'en') await page.getByRole('button', { name: '切换语言', exact: true }).click();
    await expect(page.getByRole('heading', { name: locale === 'zh' ? '管理工作台' : 'Operations', exact: true })).toBeVisible();
    const routes = locale === 'zh' ? ['支付审核与退款', '结算与储备凭证', '汇率状态', '支付操作记录'] : ['Reviews & refunds', 'Settlement & reserve evidence', 'FX status', 'Payment audit'];
    for (const name of routes) {
      const navigation = page.getByRole('navigation', { name: locale === 'zh' ? '管理导航' : 'Operations navigation', exact: true });
      const link = navigation.getByRole('link', { name, exact: true });
      await link.click(); await expect(link).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('main [aria-busy=true]')).toHaveCount(0);
      await noDemoUi(page); await checkOverflow(page); await checkColorsAndContrast(page);
    }
  }
  await page.getByRole('link', { name: 'Reviews & refunds', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View order', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Payment evidence and dual review', exact: true })).toBeVisible();
  await checkOverflow(page); await checkColorsAndContrast(page);
  await page.screenshot({ path: 'test-results/operators-mobile.png', fullPage: true });
  expect(f.unexpected).toEqual([]);
});

test('keyboard entry, visible focus and confirmation dialog preserve navigation', async ({ page }) => {
  const f = await fixture(page);
  await page.goto('./');
  await expect(page.locator('.skip-link')).toHaveCSS('clip-path', 'inset(50%)');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: '跳至主要内容', exact: true });
  await checkFocus(skip);
  await expect(skip).toHaveCSS('clip-path', 'none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  const handle = page.getByLabel('账号', { exact: true });
  await handle.focus(); await checkFocus(handle);
  await handle.fill('qa-appearance'); await page.keyboard.press('Tab');
  const password = page.getByLabel('密码', { exact: true });
  await checkFocus(password); await password.fill('fixture-only-password');
  await page.keyboard.press('Tab');
  const submit = page.getByRole('button', { name: '登录并验证角色', exact: true });
  await checkFocus(submit); await page.keyboard.press('Enter');
  const order = page.getByRole('button', { name: '查看订单', exact: true });
  await expect(order).toBeVisible(); await order.focus(); await page.keyboard.press('Enter');
  const firstReview = page.getByRole('button', { name: '提交初审', exact: true });
  await expect(firstReview).toBeEnabled(); await firstReview.focus(); await checkFocus(firstReview); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '确认初审', exact: true });
  await expect(dialog).toBeVisible(); await checkColorsAndContrast(page);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0); await checkFocus(firstReview);
  expect(f.unexpected).toEqual([]);
});
