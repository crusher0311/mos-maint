import { test, expect, type Page } from '@playwright/test';

const key = 'mos-workflow-appearance';
const root = (page: Page) => page.locator('html');
const selector = (page: Page) => page.getByRole('combobox', { name: 'Appearance', exact: true });
const background = (page: Page, query: string) => page.locator(query).first().evaluate(el => getComputedStyle(el).backgroundColor);

test('System follows OS, explicit choices persist independently of OS and direct preview navigation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(selector(page)).toHaveValue('system');
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'dark');
  await expect(page.locator('#workflow-appearance-help')).toHaveText('System · Dark');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'light');
  await selector(page).selectOption('dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'dark');
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe('dark');
  await page.reload();
  await expect(selector(page)).toHaveValue('dark');
  await page.goto('/preview/workflow/ShopWorkflow');
  await expect(selector(page)).toHaveValue('dark');
  await expect(page.getByTestId('dispatch-view')).toBeVisible();
  await selector(page).selectOption('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'light');
  await selector(page).selectOption('system');
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'dark');
  await page.reload();
  await expect(selector(page)).toHaveValue('system');
});

for (const route of ['/', '/preview/workflow/ShopWorkflow']) {
  test(`correct theme before application JS executes at ${route}`, async ({ page }) => {
    await page.addInitScript(key => localStorage.setItem(key, 'dark'), key);
    // Block the React entry/bundles, not the classic prepaint initializer.
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/src/main.tsx') || (path.endsWith('.js') && !path.endsWith('/appearance-init.js'))) return route.abort();
      return route.continue();
    });
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(root(page)).toHaveAttribute('data-workflow-theme', 'dark');
    expect(await page.locator('#root').innerHTML()).toBe('');
    expect(await root(page).evaluate(el => (el as HTMLElement).style.colorScheme)).toBe('dark');
  });
}

test('invalid or unavailable storage falls back safely; changes still work in memory', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, 'getItem', { value() { throw new Error('Storage denied'); } });
    Object.defineProperty(Storage.prototype, 'setItem', { value() { throw new Error('Storage denied'); } });
  });
  await page.goto('/');
  await expect(selector(page)).toHaveValue('system');
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'dark');
  await selector(page).selectOption('light');
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'light');
  await page.getByTestId('nav-branding').click();
  await expect(page.getByTestId('branding-storage-error')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'light');
  expect(errors).toEqual([]);
});

test('invalid preference and cross-tab updates use only the workflow key', async ({ page }) => {
  await page.addInitScript(key => localStorage.setItem(key, 'invalid'), key);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(selector(page)).toHaveValue('system');
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-site-appearance', newValue: 'dark' })));
  await expect(root(page)).toHaveAttribute('data-workflow-theme', 'light');
  await page.evaluate(key => window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'dark' })), key);
  await expect(selector(page)).toHaveValue('dark');
  await page.evaluate(key => window.dispatchEvent(new StorageEvent('storage', { key, newValue: null })), key);
  await expect(selector(page)).toHaveValue('system');
});

for (const mode of ['light', 'dark'] as const) {
  test(`${mode}: all views, nested dialogs, draft preservation, mobile keyboard and light print`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await selector(page).selectOption(mode);
    const expectedSurface = mode === 'dark' ? 'rgb(32, 45, 39)' : 'rgb(250, 251, 245)';
    expect(await background(page, '.board')).toBe(expectedSurface);
    await page.getByTestId('vehicle-v1').click();
    expect(await background(page, '.dialog')).toBe(expectedSurface);
    await page.getByTestId('pause-j1').click();
    expect(await background(page, '.dialog.compact')).toBe(expectedSurface);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    for (const [nav, view] of [['nav-vehicles', 'vehicles-view'], ['nav-my-work', 'my-work-view'], ['nav-experience', 'experience-view'], ['nav-branding', 'branding-view']]) {
      await page.getByTestId(nav).click();
      await expect(page.getByTestId(view)).toBeVisible();
      await expect(root(page)).toHaveAttribute('data-workflow-theme', mode);
    }
    expect(await background(page, '.preview-panel')).toBe(expectedSurface);
    const contrasts = await page.locator('.preview-work-row .tag, .sidebar, nav button.active, .btn.primary').evaluateAll(elements => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
      };
      return elements.map(element => {
        const style = getComputedStyle(element);
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
    });
    for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.getByTestId('brand-name').fill('Copper Ridge Service');
    await selector(page).selectOption(mode === 'dark' ? 'light' : 'dark');
    await expect(page.getByTestId('brand-name')).toHaveValue('Copper Ridge Service');
    await expect(page.getByTestId('branding-status')).toContainText('Draft changes');
    await selector(page).selectOption(mode);
    await page.getByTestId('reset-branding').click();
    expect(await background(page, '.dialog.compact')).toBe(expectedSurface);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(selector(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await selector(page).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(selector(page)).toHaveValue('dark');
    expect(await selector(page).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.emulateMedia({ media: 'print' });
    expect(await background(page, '.preview-panel')).toBe('rgb(250, 251, 245)');
    await expect(page.locator('.appearance-control')).toBeHidden();
    expect(await page.locator('html').evaluate(el => getComputedStyle(el).colorScheme)).toBe('light');
    expect(errors).toEqual([]);
  });
}

test('branding overrides, inherited identity, logo and both reset paths remain independent', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  await page.goto('/');
  await selector(page).selectOption('dark');
  await page.getByTestId('advance-clock').click();
  await page.getByTestId('nav-branding').click();
  await page.getByTestId('brand-primary').fill('#ffffff');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPQCHf7DwADNQHFFZA4cgAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('brand-logo').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByTestId('remove-brand-logo')).toBeVisible();
  await page.getByTestId('apply-branding').click();
  await page.getByTestId('brand-scope').selectOption('location');
  await page.getByTestId('brand-inherit').uncheck();
  await page.getByTestId('brand-primary').fill('#173a65');
  await page.getByTestId('apply-branding').click();
  const saved = await page.evaluate(() => localStorage.getItem('detect-dog:branding:v1'));
  await selector(page).selectOption('light');
  await selector(page).selectOption('dark');
  expect(await page.evaluate(() => localStorage.getItem('detect-dog:branding:v1'))).toBe(saved);
  expect(await page.locator('.dd').evaluate(el => (el as HTMLElement).style.getPropertyValue('--forest'))).toBe('#173a65');
  await page.getByTestId('brand-inherit').check();
  await page.getByTestId('apply-branding').click();
  const logo = page.locator('.sidebar .brand-logo');
  await expect(logo).toBeVisible();
  const src = await logo.getAttribute('src');
  await selector(page).selectOption('light');
  expect(await logo.getAttribute('src')).toBe(src);
  expect(await logo.evaluate(el => getComputedStyle(el).filter)).toBe('none');
  await page.getByTestId('reset-branding').click();
  await page.getByTestId('confirm-reset-branding').click();
  await expect(selector(page)).toHaveValue('light');
  await page.getByTestId('nav-dispatch').click();
  await expect(page.getByTestId('shop-clock')).toHaveText('10:30');
  await selector(page).selectOption('dark');
  const branding = await page.evaluate(() => localStorage.getItem('detect-dog:branding:v1'));
  await page.getByTestId('reset-demo').click();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('shop-clock')).toHaveText('10:15');
  await expect(selector(page)).toHaveValue('dark');
  expect(await page.evaluate(() => localStorage.getItem('detect-dog:branding:v1'))).toBe(branding);
  await page.getByTestId('demo-dataset').selectOption('fictional');
  await page.getByTestId('confirm-action').click();
  await expect(selector(page)).toHaveValue('dark');
  expect(requests).toEqual([]);
});
