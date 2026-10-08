import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: {
    baseURL: process.env.DEMO_TEST_URL || 'http://127.0.0.1:24087',
    viewport: {width:1440,height:1000},
    launchOptions: { executablePath: process.env.DEMO_CHROMIUM_PATH || undefined },
  },
  workers: 1,
});
