'use strict';
/**
 * Playwright global setup — runs once before all E2E tests.
 *
 * Logs in via the UI and saves the session cookie to .auth-state.json so
 * individual test files can reuse it with `test.use({ storageState })`.
 */
const { chromium } = require('@playwright/test');
const path = require('path');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL    = 'http://localhost:3000';
const PASSWORD    = process.env.APP_PASSWORD || 'kanban-pwd';

module.exports = async function globalSetup() {
  const executablePath = process.env.CHROME_PATH || '/run/current-system/sw/bin/google-chrome-stable';
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page    = await context.newPage();

  await page.goto('/');
  await page.locator('#loginBackdrop').waitFor({ state: 'visible' });
  await page.fill('#loginPassword', PASSWORD);
  await page.click('#loginSubmitBtn');
  await page.locator('#overview').waitFor({ state: 'visible', timeout: 10_000 });

  // Persist cookies so test files can skip the login flow
  await context.storageState({ path: AUTH_STATE });
  await browser.close();
};
