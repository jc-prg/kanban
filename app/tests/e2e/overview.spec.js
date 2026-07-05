'use strict';
/**
 * E2E — 3.2 Board overview
 *
 * All tests run with a pre-authenticated session (storageState from globalSetup).
 * beforeAll creates the boards needed; afterAll removes them.
 *
 * Scenarios: E-O-1 … E-O-3
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';

// Use the session cookie saved by global-setup
test.use({ storageState: AUTH_STATE });

// ---------------------------------------------------------------------------
// Authenticated API helpers (used in beforeAll / afterAll, outside page context)
// ---------------------------------------------------------------------------

function authHeaders(extraHeaders = {}) {
  const state  = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  const cookie = state.cookies.find(c => c.name === 'kanban-session');
  const cookieHeader = cookie ? `kanban-session=${cookie.value}` : '';
  return { Cookie: cookieHeader, ...extraHeaders };
}

async function apiPost(urlPath, body) {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function apiPatch(urlPath, body) {
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

async function apiDelete(urlPath) {
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
}

// ---------------------------------------------------------------------------
// Unique board names for this test file
// ---------------------------------------------------------------------------

const BOARD_LIST     = 'e2e-ov-list';    // E-O-1: verify board appears in overview
const BOARD_CREATE   = 'e2e-ov-create';  // E-O-2: create via UI
const BOARD_ARCHIVED = 'e2e-ov-arch';    // E-O-3: archived board visibility

// ---------------------------------------------------------------------------

test.describe('3.2 Board Overview', () => {

  test.beforeAll(async () => {
    // Seed boards (ignore 409 if they already exist from a previous run)
    await apiPost(`/api/boards/${BOARD_LIST}`);
    await apiPost(`/api/boards/${BOARD_ARCHIVED}`);
    // Archive the third board so E-O-3 has something to test
    await apiPatch(`/api/${BOARD_ARCHIVED}/board`, { settings: { archived: true } });
  });

  test.afterAll(async () => {
    // Best-effort cleanup — tests should leave no side-effects
    await apiDelete(`/api/boards/${BOARD_LIST}`).catch(() => {});
    await apiDelete(`/api/boards/${BOARD_CREATE}`).catch(() => {});
    await apiDelete(`/api/boards/${BOARD_ARCHIVED}`).catch(() => {});
  });

  // E-O-1 ---------------------------------------------------------------
  test('E-O-1: overview lists boards as clickable links', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#overview')).toBeVisible();

    // The board we seeded should appear in the active grid
    const boardLink = page.locator(`#boardGrid .board-card[href="/board/${BOARD_LIST}"]`);
    await expect(boardLink).toBeVisible();

    // It should contain the board name
    await expect(boardLink.locator('.board-card-name')).toHaveText(BOARD_LIST);
  });

  // E-O-2 ---------------------------------------------------------------
  test('E-O-2: creating a board from the overview navigates to it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#overview')).toBeVisible();

    await page.fill('#newBoardInput', BOARD_CREATE);
    await page.click('#newBoardBtn');

    // App navigates to /<boardname>
    await page.waitForURL(`**/${BOARD_CREATE}`);
    await expect(page).toHaveURL(new RegExp(`/${BOARD_CREATE}$`));

    // Board area is shown; overview is hidden
    await expect(page.locator('#overview')).toBeHidden();
  });

  // E-O-3 ---------------------------------------------------------------
  test('E-O-3: archived board is hidden from active grid and shown when toggled', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#overview')).toBeVisible();

    // Archived board must NOT appear in the active grid
    await expect(
      page.locator(`#boardGrid .board-card[href="/board/${BOARD_ARCHIVED}"]`)
    ).toBeHidden();

    // The archived section header should be visible (there is at least one archived board)
    await expect(page.locator('#archivedSection')).toBeVisible();

    // Archived grid starts collapsed
    await expect(page.locator('#archivedGrid')).toBeHidden();

    // Click the toggle
    await page.click('#archivedSectionBtn');

    // Archived grid expands and the board is visible
    await expect(page.locator('#archivedGrid')).toBeVisible();
    await expect(
      page.locator(`#archivedGrid .board-card[href="/board/${BOARD_ARCHIVED}"]`)
    ).toBeVisible();
  });

});
