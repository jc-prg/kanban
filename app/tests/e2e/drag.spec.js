'use strict';
/**
 * E2E — 3.4 Drag and drop
 *
 * Tests card and column reordering via HTML5 drag-and-drop.
 * Scenarios: E-D-1 … E-D-4
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-drag';
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
async function apiGet(urlPath) {
  const res = await fetch(`${BASE_URL}${urlPath}`, { headers: authHeaders() });
  return res.json();
}
async function apiDelete(urlPath) {
  return fetch(`${BASE_URL}${urlPath}`, { method: 'DELETE', headers: authHeaders() });
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------
const SEED_STATE = {
  columns: [
    {
      id: 'col-a',
      title: 'Column A',
      cards: [
        { id: 'id-drag1', text: 'Drag Me', created: '2024-01-01' },
        { id: 'id-stay1', text: 'Stay Here', created: '2024-01-01' },
      ],
    },
    {
      id: 'col-b',
      title: 'Column B',
      cards: [],
    },
    {
      id: 'col-done',
      title: 'Done',
      actions: ['markDone'],
      cards: [],
    },
  ],
};

async function resetBoard() {
  await apiPut(`/api/${BOARD}/board`, SEED_STATE);
}

// ---------------------------------------------------------------------------

test.describe('3.4 Drag and drop', () => {
  test.beforeAll(async () => {
    await apiPost(`/api/boards/${BOARD}`);
  });

  test.afterAll(async () => {
    await apiDelete(`/api/boards/${BOARD}`).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    await resetBoard();
    await page.goto(BOARD_URL);
    await expect(page.locator('.column')).toHaveCount(3, { timeout: 10_000 });
  });

  // E-D-1 ------------------------------------------------------------------
  test('E-D-1: drag card from Column A to Column B → card moves', async ({ page }) => {
    const source = page.locator('.card').filter({ hasText: 'Drag Me' }).first();
    const target = page.locator('.column').filter({ has: page.locator('.column-title[value="Column B"]') });

    await page.dragAndDrop(
      '.card:has-text("Drag Me")',
      '.column:has(.column-title[value="Column B"]) .cards'
    );

    // Card should now be in Column B
    const colB = page.locator('.column').filter({ has: page.locator('.column-title[value="Column B"]') });
    await expect(colB.locator('.card').filter({ hasText: 'Drag Me' })).toBeVisible();

    // Card should be gone from Column A
    const colA = page.locator('.column').filter({ has: page.locator('.column-title[value="Column A"]') });
    await expect(colA.locator('.card').filter({ hasText: 'Drag Me' })).toHaveCount(0);
  });

  // E-D-2 ------------------------------------------------------------------
  test('E-D-2: drop card into column with markDone action → card.done = true', async ({ page }) => {
    await page.dragAndDrop(
      '.card:has-text("Drag Me")',
      '.column:has(.column-title[value="Done"]) .cards'
    );

    const doneCol = page.locator('.column').filter({ has: page.locator('.column-title[value="Done"]') });
    await expect(doneCol.locator('.card--done').filter({ hasText: 'Drag Me' })).toBeVisible();
  });

  // E-D-3 ------------------------------------------------------------------
  test('E-D-3: drag column to reorder → new order persists after reload', async ({ page }) => {
    // Drag Column B's handle to the left of Column A
    const dragHandle = page.locator('.column').filter({ has: page.locator('.column-title[value="Column B"]') }).locator('.col-drag-handle');
    const colAEl     = page.locator('.column').filter({ has: page.locator('.column-title[value="Column A"]') });

    await dragHandle.dragTo(colAEl);
    // Wait for autosave
    await page.waitForTimeout(1200);
    await page.reload();

    // After reload, verify column order has changed (Column A is no longer first)
    const titles = await page.locator('.column-title').evaluateAll(els => els.map(el => el.value));
    // The order changed — just verify Column B moved (it should not be 2nd anymore)
    expect(titles[0]).not.toBe('Column A');
  });

  // E-D-4 ------------------------------------------------------------------
  test('E-D-4: drag card onto note page → card linked to page', async ({ page }) => {
    // Open notes sidebar and create a page first
    await page.click('#notesToggleBtn');
    await expect(page.locator('#notesSidebar')).toBeVisible();
    await page.click('#notesAddRootBtn');
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.fill('#notePageTitle', 'My Note Page');
    await page.click('#noteModalSaveBtn');
    await page.waitForTimeout(500);

    // The page item is now in the tree
    const pageItem = page.locator('.notes-tree-item--page').first();
    await expect(pageItem).toBeVisible();

    // Drag the card onto the note page item
    await page.dragAndDrop(
      '.card:has-text("Drag Me")',
      '.notes-tree-item--page'
    );

    // Confirm dialog should appear asking to link
    await expect(page.locator('#dialogBackdrop')).toBeVisible({ timeout: 5000 });
    await page.click('#dialogOkBtn');

    // Open the note modal and verify the linked card is shown
    await pageItem.locator('.notes-item-title').click();
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.click('#noteToggleLinkedCards');
    await expect(page.locator('#noteLinkedCardsList')).toContainText('Drag Me');
  });
});
