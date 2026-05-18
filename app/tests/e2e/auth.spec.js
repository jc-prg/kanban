'use strict';
/**
 * E2E — 3.1 Authentication flow
 *
 * Tests the raw auth UI.  No pre-authenticated storageState is used here —
 * every test begins with a fresh browser context (no session cookie).
 *
 * Scenarios: E-A-1 … E-A-4
 */
const { test, expect } = require('@playwright/test');

const PASSWORD       = process.env.APP_PASSWORD || 'kanban-pwd';
const WRONG_PASSWORD = 'definitely-not-the-password';

test.describe('3.1 Authentication', () => {

  // E-A-1 ---------------------------------------------------------------
  test('E-A-1: login form shown on first visit; correct password gives access', async ({ page }) => {
    await page.goto('/');

    // Login backdrop is the first thing the user sees
    await expect(page.locator('#loginBackdrop')).toBeVisible();

    // Enter correct password and submit
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginSubmitBtn');

    // Overview appears, login modal is gone
    await expect(page.locator('#overview')).toBeVisible();
    await expect(page.locator('#loginBackdrop')).toBeHidden();
  });

  // E-A-2 ---------------------------------------------------------------
  test('E-A-2: wrong password shows error message; form stays visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loginBackdrop')).toBeVisible();

    await page.fill('#loginPassword', WRONG_PASSWORD);
    await page.click('#loginSubmitBtn');

    // Error message appears and password field is still present
    await expect(page.locator('#loginError')).toBeVisible();
    await expect(page.locator('#loginPassword')).toBeVisible();

    // Overview must NOT be visible
    await expect(page.locator('#overview')).toBeHidden();
  });

  // E-A-3 ---------------------------------------------------------------
  test('E-A-3: session cookie persists across page reload', async ({ page }) => {
    // Log in
    await page.goto('/');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginSubmitBtn');
    await expect(page.locator('#overview')).toBeVisible();

    // Reload — the kanban-session cookie is still in the browser context
    await page.reload();

    await expect(page.locator('#loginBackdrop')).toBeHidden();
    await expect(page.locator('#overview')).toBeVisible();
  });

  // E-A-4 ---------------------------------------------------------------
  test('E-A-4: clearing session cookie shows login prompt on reload', async ({ page, context }) => {
    // Log in
    await page.goto('/');
    await page.fill('#loginPassword', PASSWORD);
    await page.click('#loginSubmitBtn');
    await expect(page.locator('#overview')).toBeVisible();

    // Drop all cookies — simulates "sign out" or cookie expiry
    await context.clearCookies();
    await page.reload();

    await expect(page.locator('#loginBackdrop')).toBeVisible();
    await expect(page.locator('#overview')).toBeHidden();
  });

});
