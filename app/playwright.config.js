'use strict';
// Load env vars from the project .env so APP_PASSWORD etc. are available
// in global-setup and test files without manual export.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { defineConfig } = require('@playwright/test');

// E2E runs against its own server on a separate port so the tests neither depend on
// nor touch the running instance. 2FA is disabled for that server only (empty
// TWO_FA_EMAIL — dotenv never overrides an existing variable), so the production
// code has no test bypass. Spec files read the URL from E2E_BASE_URL.
const E2E_PORT = process.env.E2E_PORT || '3100';
process.env.E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.js',

  // Fail fast — no retries during development
  retries: 0,
  workers: 1,

  timeout: 30_000,
  expect: { timeout: 8_000 },

  reporter: [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Take screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Dedicated test server (needs CouchDB up, e.g. via `docker compose up -d couchdb`).
  webServer: {
    command: 'node backend/server.js',
    url: process.env.E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: E2E_PORT, TWO_FA_EMAIL: '' },
  },

  projects: [
    // Use the system-installed Chrome (avoids NixOS dynamic-linker issues with
    // the Playwright-bundled Chromium headless shell).
    {
      name: 'chrome',
      use: {
        browserName: 'chromium',
        launchOptions: { executablePath: process.env.CHROME_PATH || '/run/current-system/sw/bin/google-chrome-stable' },
      },
    },
  ],
});
