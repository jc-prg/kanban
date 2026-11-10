'use strict';
/**
 * E2E — 3.2 Boards on Today (the entry point; the old overview at / redirects there)
 *
 * All tests run with a pre-authenticated session (storageState from globalSetup).
 * beforeAll creates the boards needed; afterAll removes them. Only the Today config is
 * mocked (a layout with the Boards tile, no external widgets) — boards come from the real API.
 *
 * Scenarios: E-O-1 … E-O-4
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = process.env.E2E_BASE_URL;

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

const BOARD_LIST     = 'e2e-ov-list';    // E-O-1: verify board appears on Today
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
  // Today config: only the Boards tile; Today PUTs are never sent to the shared CouchDB
  async function mockTodayConfig(page) {
    await page.route('**/api/today/config', r => r.request().method() === 'GET'
      ? r.fulfill({ json: { showBar: false, refreshMinutes: 0, widgets: {}, disabled: [],
          layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'boards', col: 0, order: 0, size: 'container' }] } } } })
      : r.fulfill({ json: { ok: true } }));
    await page.route('**/api/dashboard/config', r => r.fulfill({ json: { calendarAccounts: [], mailAccounts: [] } }));
    await page.route('**/api/dashboard/mail-recent-folders', r => r.fulfill({ json: {} }));
  }

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 900 });
    await mockTodayConfig(page);
  });

  test('E-O-1: / redirects to Today, which lists boards as clickable links', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.locator('#today')).toBeVisible();

    const boardLink = page.locator(`.today-tile[data-tile="boards"] .today-board[href="/board/${BOARD_LIST}"]`).first();
    await expect(boardLink).toBeVisible();
    await boardLink.click();
    await expect(page).toHaveURL(new RegExp(`/board/${BOARD_LIST}$`));
  });

  test('E-O-2: creating a board from the Boards tile navigates to it', async ({ page }) => {
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="boards"]');
    await tile.locator('button[title="New board"]').click();
    await tile.locator('.today-newboard-input').fill(BOARD_CREATE);
    await tile.locator('.today-newboard button[type="submit"]').click();
    await expect(page).toHaveURL(new RegExp(`/board/${BOARD_CREATE}$`));
  });

  test('E-O-3: archived boards are hidden; the folder action lists them with the active ones', async ({ page }) => {
    await page.goto('/today');
    await page.evaluate(() => localStorage.removeItem('today-boards-archived'));
    await page.reload();
    const tile = page.locator('.today-tile[data-tile="boards"]');
    await expect(tile.locator(`.today-board[href="/board/${BOARD_LIST}"]`)).toBeVisible();
    await expect(tile.locator(`.today-board[href="/board/${BOARD_ARCHIVED}"]`)).toHaveCount(0);

    const toggle = tile.locator('button[title="Show archived boards"]');
    await toggle.click();
    const arch = tile.locator(`.today-boards .today-board--archived[href="/board/${BOARD_ARCHIVED}"]`);
    await expect(arch).toBeVisible();
    await expect(tile.locator('button[title="Hide archived boards"]')).toHaveAttribute('aria-pressed', 'true');

    // Kept per browser across reloads; the folder action hides them again
    await page.reload();
    await expect(arch).toBeVisible();
    await tile.locator('button[title="Hide archived boards"]').click();
    await expect(arch).toHaveCount(0);
  });

  test('E-O-4: old entry URLs redirect to Today and keep their query', async ({ request }) => {
    const loc = async p => (await request.get(p, { maxRedirects: 0 })).headers().location;
    expect(await loc('/')).toBe('/today');
    expect(await loc('/focus?mail=ma-1&folder=INBOX')).toBe('/today?mail=ma-1&folder=INBOX');
    expect(await loc('/dashboard')).toBe('/today');
    expect(await loc('/inbox?board=jobs')).toBe('/today?inbox&board=jobs');
  });

});
