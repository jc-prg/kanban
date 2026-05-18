'use strict';
// Load env vars from the project .env so APP_PASSWORD etc. are available
// in global-setup and test files without manual export.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { defineConfig } = require('@playwright/test');

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
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 1280, height: 720 },
    // Take screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Reuse the server started by `docker compose up` or `npm start`.
  // If no server is running, Playwright starts one (requires CouchDB to be up).
  webServer: {
    command: 'node backend/server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 15_000,
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
