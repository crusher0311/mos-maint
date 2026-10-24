import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';

const components = readdirSync(new URL('../../src/components/mockups/workflow/', import.meta.url))
  .filter(name => name.endsWith('.tsx')).map(name => name.replace(/\.tsx$/, ''));

test('retirement covers root, workspace fallback and every former component URL without loading demo state', async ({ page, baseURL }) => {
  const errors: string[] = [];
  const forbidden: string[] = [];
  const origins = [new URL(baseURL!).origin, 'http://127.0.0.1:5000'];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const req = route.request();
    if (!origins.includes(new URL(req.url()).origin) || req.method() !== 'GET' ||
        /\/api\/|\/components\/mockups\/|ArchivedDemo|appearance-init/.test(req.url())) {
      forbidden.push(req.url());
      return route.abort();
    }
    return route.continue();
  });
  await page.addInitScript(() => {
    localStorage.setItem('mos-workflow-appearance', 'dark');
    (window as unknown as { archiveStorage: string }).archiveStorage = JSON.stringify(localStorage);
  });
  for (const origin of origins) {
    for (const path of ['/', ...components.map(name => `/preview/workflow/${name}`), '/preview/workflow/ShopWorkflow?restore=true']) {
      const url = origin + path;
      await page.goto(url);
      await expect(page.getByRole('heading', { name: 'Workflow demo retired' })).toBeVisible();
      await expect(page.locator('button, select, input, a')).toHaveCount(0);
      expect(page.url()).toBe(url);
      expect(await page.evaluate(() => JSON.stringify(localStorage) ===
        (window as unknown as { archiveStorage: string }).archiveStorage)).toBe(true);
    }
  }
  expect(forbidden).toEqual([]);
  expect(errors).toEqual([]);
  const generated = readFileSync(new URL('../../src/.generated/mockup-components.ts', import.meta.url), 'utf8');
  expect(generated).not.toContain('import(');
});

test('retirement leaves the separate tire demo interactive at its existing preview path', async ({ page }) => {
  const url = process.env.TIRE_TEST_URL || 'http://127.0.0.1:26170/tire-dvi/';
  const forbidden: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const req = route.request();
    if (new URL(req.url()).origin !== new URL(url).origin || req.method() !== 'GET' || /\/api\//.test(req.url())) {
      forbidden.push(req.url());
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Workflow demo retired' })).toHaveCount(0);
  await page.getByTestId('complete-inspection').click();
  await expect(page.getByTestId('completion-errors')).toContainText('Left front');
  await page.getByTestId('sample-findings').click();
  await page.getByTestId('confirm-sample').click();
  await expect(page.getByLabel('Left front inner tread (/32 in)', { exact: true })).not.toHaveValue('');
  expect(forbidden).toEqual([]);
  expect(errors).toEqual([]);
});
