import { randomUUID } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const apiPort = '3317';
const webPort = '4173';
const origin = `http://127.0.0.1:${webPort}`;
if (!process.env.TEAMVAULT_TEST_DATABASE_URL) {
  throw new Error('Set TEAMVAULT_TEST_DATABASE_URL to the dedicated local test database before browser tests.');
}
// Always generate the cleanup namespace locally; never let an inherited value
// cause teardown to match fixtures from another run.
process.env.TEAMVAULT_E2E_RUN_ID = randomUUID();

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.js',
  globalTeardown: './e2e/global-teardown.cjs',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: origin,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/start-api.cjs',
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TEAMVAULT_E2E_API_PORT: apiPort, TEAMVAULT_E2E_WEB_ORIGIN: origin },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      url: origin,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: apiPort, TEAMVAULT_API_ORIGIN: `http://127.0.0.1:${apiPort}` },
    },
  ],
});
