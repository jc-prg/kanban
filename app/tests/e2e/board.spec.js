'use strict';
/**
 * E2E — 3.3 Column & card CRUD
 *
 * Each test resets the board to a known seed state before running.
 * Scenarios: E-B-1 … E-B-10
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-board';
const BOARD_URL  = `/${BOARD}`;

test.use({ storageState: AUTH_STATE });

// ---------------------------------------------------------------------------
// Authenticated API helpers
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
// Board seed helpers
// ---------------------------------------------------------------------------
const SEED_STATE = {
  columns: [
    {
      id: 'col-todo',
      title: 'To Do',
      cards: [
        { id: 'id-card1', text: 'First Card',   created: '2024-01-01' },
        { id: 'id-card2', text: 'Second Card',  created: '2024-01-01', endDate: '2020-01-01' },
        { id: 'id-lab1',  text: '# Section Label', created: '2024-01-01' },
      ],
    },
  ],
};

async function resetBoard() {
  await apiPut(`/api/${BOARD}/board`, SEED_STATE);
}

// ---------------------------------------------------------------------------

test.describe('3.3 Column & card CRUD', () => {
  test.beforeAll(async () => {
    await apiPost(`/api/boards/${BOARD}`);
  });

  test.afterAll(async () => {
    await apiDelete(`/api/boards/${BOARD}`).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    await resetBoard();
    await page.goto(BOARD_URL);
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });
  });

  // E-B-1 ------------------------------------------------------------------
  test('E-B-1: add column via button → column appears with title input', async ({ page }) => {
    await page.click('.add-column-btn');
    await expect(page.locator('.column')).toHaveCount(2);
    const newCol = page.locator('.column').nth(1);
    await expect(newCol.locator('.column-title')).toBeVisible();
  });

  // E-B-2 ------------------------------------------------------------------
  test('E-B-2: rename column → title persists after reload', async ({ page }) => {
    const titleInput = page.locator('.column-title').first();
    await titleInput.fill('Renamed Column');
    await titleInput.blur();
    // Wait for autosave debounce + network round-trip
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.locator('.column-title').first()).toHaveValue('Renamed Column');
  });

  // E-B-3 ------------------------------------------------------------------
  test('E-B-3: delete column via context menu → column removed', async ({ page }) => {
    await page.click('.col-btn');
    await expect(page.locator('#colContextMenu')).toBeVisible();
    await page.hover('#colCtxSettings');
    await page.click('#colCtxDelete');
    await expect(page.locator('#dialogBackdrop')).toBeVisible();
    await page.click('#dialogOkBtn');
    await expect(page.locator('.column')).toHaveCount(0);
  });

  // E-B-4 ------------------------------------------------------------------
  test('E-B-4: add card via + button → fill title → card visible', async ({ page }) => {
    await page.click('.add-card-btn');
    await expect(page.locator('#modal')).toBeVisible();
    await page.fill('#cardText', 'New Test Card');
    await page.click('#modalSubmitBtn');
    await expect(page.locator('#modal')).toBeHidden();
    await expect(page.locator('.card').filter({ hasText: 'New Test Card' })).toBeVisible();
  });

  // E-B-5 ------------------------------------------------------------------
  test('E-B-5: edit card → change title and description → card updated', async ({ page }) => {
    const card = page.locator('.card').filter({ hasText: 'First Card' }).first();
    await card.click();
    await expect(page.locator('#modal')).toBeVisible();
    await page.fill('#cardText', 'Edited Card');
    await page.evaluate(() => window.setEditorValue('cardDesc', '**bold text**'));
    await page.click('#modalSubmitBtn');
    await expect(page.locator('#modal')).toBeHidden();
    await expect(page.locator('.card').filter({ hasText: 'Edited Card' })).toBeVisible();
  });

  // E-B-6 ------------------------------------------------------------------
  test('E-B-6: delete card via context menu → card removed', async ({ page }) => {
    const card = page.locator('.card').filter({ hasText: 'First Card' }).first();
    await card.click({ button: 'right' });
    await expect(page.locator('#contextMenu')).toBeVisible();
    await page.click('#ctxDelete');
    await expect(page.locator('#dialogBackdrop')).toBeVisible();
    await page.click('#dialogOkBtn');
    await expect(page.locator('.card').filter({ hasText: 'First Card' })).toHaveCount(0);
  });

  // E-B-7 ------------------------------------------------------------------
  test('E-B-7: card with # prefix renders as label with no edit button', async ({ page }) => {
    const label = page.locator('.card--label');
    await expect(label).toBeVisible();
    await expect(label.locator('.more-btn')).toHaveCount(0);
  });

  // E-B-8 ------------------------------------------------------------------
  test('E-B-8: card with past endDate shows overdue indicator', async ({ page }) => {
    await expect(page.locator('.card--overdue').filter({ hasText: 'Second Card' })).toBeVisible();
  });

  // E-B-9 ------------------------------------------------------------------
  test('E-B-9: mark card as done → card shows done style and checkmark', async ({ page }) => {
    const card = page.locator('.card').filter({ hasText: 'First Card' }).first();
    await card.click({ button: 'right' });
    await expect(page.locator('#contextMenu')).toBeVisible();
    await page.click('#ctxDone');
    await expect(page.locator('.card--done').filter({ hasText: 'First Card' })).toBeVisible();
    await expect(page.locator('.card--done .card-done-mark').first()).toBeVisible();
  });

  // E-B-10 -----------------------------------------------------------------
  test('E-B-10: 31+ cards shows load-more button; clicking it reveals all', async ({ page }) => {
    const cards = Array.from({ length: 35 }, (_, i) => ({
      id: `id-lm${String(i).padStart(2, '0')}`,
      text: `Load More Card ${i + 1}`,
      created: '2024-01-01',
    }));
    await apiPut(`/api/${BOARD}/board`, {
      columns: [{ id: 'col-big', title: 'Big Column', cards }],
    });
    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1);
    await expect(page.locator('.load-more-btn')).toBeVisible();
    await page.click('.load-more-btn');
    await expect(page.locator('.load-more-btn')).toBeHidden();
  });
});
