import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]],
  use: {
    baseURL: process.env.Q_ADMIN_TEST_URL ?? 'http://127.0.0.1:4173/q-admin/',
    trace: 'retain-on-failure',
    launchOptions: !process.env.CI && process.env.Q_ADMIN_BROWSER_PATH ? { executablePath: process.env.Q_ADMIN_BROWSER_PATH } : undefined,
  },
  webServer: process.env.Q_ADMIN_TEST_URL ? undefined : {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/q-admin/',
    reuseExistingServer: !process.env.CI,
  },
});
