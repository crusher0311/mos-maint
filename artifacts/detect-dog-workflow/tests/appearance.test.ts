import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { APPEARANCE_KEY, parseAppearance, persistAppearance, readAppearance, resolveAppearance, systemAppearance } from '../src/appearance';
import { brandingTheme, createDefaultBranding, resolveBranding } from '../src/components/mockups/workflow/_shared/branding';
import { applyAction, createDemoState } from '../src/components/mockups/workflow/_shared/model';

const bootstrap = readFileSync(new URL('../public/appearance-init.js', import.meta.url), 'utf8');

test('prepaint and runtime agree for every preference, invalid storage and both OS modes', () => {
  for (const stored of [null, 'light', 'dark', 'system', 'invalid', '"dark"', '']) {
    for (const systemDark of [false, true]) {
      const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
      const reads: string[] = [];
      runInNewContext(bootstrap, {
        window: {
          localStorage: { getItem: (key: string) => { reads.push(key); return stored; } },
          matchMedia: () => ({ matches: systemDark }),
        },
        document: { documentElement: root },
      });
      const expected = resolveAppearance(parseAppearance(stored), systemDark);
      assert.equal(root.dataset.workflowTheme, expected);
      assert.equal(root.style.colorScheme, expected);
      assert.equal(root.style.backgroundColor, expected === 'dark' ? '#17221e' : '#f1f2e9');
      assert.deepEqual(reads, [APPEARANCE_KEY]);
    }
  }
});

test('bootstrap tolerates inaccessible storage and absent device preference APIs', () => {
  const root = { dataset: {} as Record<string, string>, style: {} };
  runInNewContext(bootstrap, {
    window: { get localStorage() { throw new Error('denied'); } },
    document: { documentElement: root },
  });
  assert.equal(root.dataset.workflowTheme, 'light');
});

test('runtime persistence is defensive, isolated and defaults to System', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, string>([['unrelated-site-appearance', 'light']]);
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
    } });
    assert.equal(readAppearance(), 'system');
    persistAppearance('dark');
    assert.equal(readAppearance(), 'dark');
    assert.equal(values.get('unrelated-site-appearance'), 'light');
    assert.equal(values.size, 2);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      get localStorage() { throw new Error('denied'); },
    } });
    assert.equal(readAppearance(), 'system');
    assert.doesNotThrow(() => persistAppearance('light'));
    assert.equal(systemAppearance(), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('appearance surface separation preserves identity, overrides, inheritance and workflow reset', () => {
  const brand = createDefaultBranding();
  brand.enterprise.primary = '#ffffff';
  brand.locations.ytd = { ...brand.locations.ytd, inherit: false, primary: '#173a65' };
  const before = structuredClone(brand);
  const tokens = brandingTheme(brand) as Record<string, unknown>;
  assert.equal(tokens['--forest'], '#173a65');
  for (const surface of ['--paper', '--surface', '--mint', '--line', '--quiet']) {
    assert.equal(tokens[surface], undefined, `${surface} must remain appearance-controlled`);
  }
  assert.equal(tokens['--primary-foreground'], '#ffffff');
  assert.equal(resolveBranding(brand, 'example').primary, '#ffffff');
  const seed = createDemoState();
  const changed = applyAction(seed, { type: 'advance' });
  assert.equal(changed.ok, true);
  assert.deepEqual(applyAction(changed.state, { type: 'reset' }).state, seed);
  assert.deepEqual(brand, before);
});

test('retirement does not initialize appearance; archived entry retains its provider and styles', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /appearance-init\.js/);
  const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /AppearanceProvider|ArchivedDemo/);
  const archive = readFileSync(new URL('../src/ArchivedDemo.tsx', import.meta.url), 'utf8');
  assert.match(archive, /<AppearanceProvider><ShopWorkflow \/><\/AppearanceProvider>/);
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.match(css, /@media screen\s*\{\s*:root\[data-workflow-theme="dark"\]/);
});
