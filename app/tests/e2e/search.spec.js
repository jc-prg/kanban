'use strict';
/**
 * E2E — 3.5 Search
 *
 * Tests the find-card dialog (Ctrl+F) with text, column, and page filters.
 * Scenarios: E-S-1 … E-S-6
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-search';
const BOARD_URL  = `/board/${BOARD}`;

test.use({ storageState: AUTH_STATE });

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function authHeaders(extra = {}) {
  const state  = JSON.parse(fs.readFileSync(AUTH_STATE, 'utf8'));
  const cookie = state.cookies.find(c => c.name === 'kanban-session');
  return { Cookie: cookie ? `kanban-session=${cookie.value}` : '', ...extra };
}
async function apiPost(urlPath, body) {
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function apiPut(urlPath, body) {
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
}
async function apiDelete(urlPath) {
  return fetch(`${BASE_URL}${urlPath}`, { method: 'DELETE', headers: authHeaders() });
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const SEED_STATE = {
  columns: [
    {
      id: 'col-alpha',
      title: 'Alpha',
      cards: [
        { id: 'id-s1', text: 'Unique Alpha Card',  created: '2024-01-01' },
        { id: 'id-s2', text: 'Shared Word Card',   created: '2024-01-01' },
      ],
    },
    {
      id: 'col-beta',
      title: 'Beta',
      cards: [
        { id: 'id-s3', text: 'Beta Card',          created: '2024-01-01' },
        { id: 'id-s4', text: 'Another Shared Card', created: '2024-01-01' },
      ],
    },
  ],
};

async function resetBoard() {
  await apiPut(`/api/${BOARD}/board`, SEED_STATE);
}

// ---------------------------------------------------------------------------

test.describe('3.5 Search', () => {
  test.beforeAll(async () => {
    await apiPost(`/api/boards/${BOARD}`);
  });

  test.afterAll(async () => {
    await apiDelete(`/api/boards/${BOARD}`).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    await resetBoard();
    await page.goto(BOARD_URL);
    await expect(page.locator('.column')).toHaveCount(2, { timeout: 10_000 });
  });

  // E-S-1 ------------------------------------------------------------------
  test('E-S-1: Ctrl+F opens search dialog', async ({ page }) => {
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchBackdrop')).toBeVisible();
    await expect(page.locator('#searchText')).toBeFocused();
  });

  // E-S-2 ------------------------------------------------------------------
  test('E-S-2: typing a query shows matching cards', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchBackdrop')).toBeVisible();

    await page.fill('#searchText', 'Unique Alpha');
    const results = page.locator('#searchResults .search-result-item');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('Unique Alpha Card');
  });

  // E-S-3 ------------------------------------------------------------------
  test('E-S-3: clicking a result opens the edit modal for that card', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await page.fill('#searchText', 'Beta Card');
    await expect(page.locator('#searchResults .search-result-item')).toHaveCount(1);

    // Click the result
    await page.click('#searchResults .search-result-item');
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Beta Card');
  });

  // E-S-4 ------------------------------------------------------------------
  test('E-S-4: unchecking a column hides its cards', async ({ page }) => {
    await page.keyboard.press('Control+f');
    // With empty query all cards are shown
    await page.fill('#searchText', 'Card');
    const allResults = page.locator('#searchResults .search-result-item');
    await expect(allResults.first()).toBeVisible();
    expect(await allResults.count()).toBeGreaterThan(1);

    // Uncheck the Beta column
    const betaCheckbox = page.locator('#searchColumnList label').filter({ hasText: 'Beta' }).locator('input[type="checkbox"]');
    await betaCheckbox.uncheck();

    // Beta column cards should be hidden from results
    await expect(page.locator('#searchResults .search-result-item').filter({ hasText: 'Beta Card' })).toHaveCount(0);
    // Alpha column cards still visible
    await expect(page.locator('#searchResults .search-result-item').filter({ hasText: 'Unique Alpha Card' })).toBeVisible();
  });

  // E-S-5 ------------------------------------------------------------------
  test('E-S-5: toggle to Pages mode shows note page results', async ({ page }) => {
    // Create a note page via the API so there is something to find
    await apiPut(`/api/${BOARD}/notes`, {
      schemaVersion: 2,
      items: [
        { type: 'page', id: 'n-srch01', title: 'Searchable Note', description: '', link: '', linkedCards: [] },
      ],
    });

    // Reload so afterAuth → loadNotes() picks up the newly seeded note
    await page.reload();
    await expect(page.locator('.column')).toHaveCount(2, { timeout: 10_000 });

    await page.keyboard.press('Control+f');
    // Switch to Pages mode
    await page.click('#searchTogglePages');

    await page.fill('#searchText', 'Searchable');
    const results = page.locator('#searchResults .search-result-item');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('Searchable Note');
  });

  // E-S-6 ------------------------------------------------------------------
  test('E-S-6: Escape closes the search dialog', async ({ page }) => {
    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchBackdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#searchBackdrop')).toBeHidden();
  });
});
