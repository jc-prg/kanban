'use strict';
/**
 * E2E — 3.8 Print view
 *
 * Verifies that the print-root DOM is correctly populated and that images
 * embedded in card/note descriptions are resolved to blob: URLs before
 * window.print() is called.
 *
 * window.print() is replaced with a no-op via addInitScript; a flag
 * window._printCalled tracks when the full async print flow completes.
 *
 * Scenarios: E-PR-1 … E-PR-4
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-print';
const BOARD_URL  = `/${BOARD}`;

// A real 1×1 PNG (smallest valid PNG binary)
const MINIMAL_PNG = Buffer.from([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, // PNG signature
  0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52, // IHDR chunk length + type
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01, // width=1, height=1
  0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53, // bit depth, color type, ...
  0xde,0x00,0x00,0x00,0x0c,0x49,0x44,0x41, // IDAT chunk
  0x54,0x08,0xd7,0x63,0xf8,0xcf,0xc0,0x00,
  0x00,0x00,0x02,0x00,0x01,0xe2,0x21,0xbc,
  0x33,0x00,0x00,0x00,0x00,0x49,0x45,0x4e, // IEND chunk
  0x44,0xae,0x42,0x60,0x82,
]);

const IMG_NAME = 'print-test.png';
const CARD_ID  = 'id-printcard';
const NOTE_ID  = 'n-printpg1';

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

/** Upload a file to a card's attachment slot via multipart POST. */
async function uploadCardAttachment(cardId, filename, buffer, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  return fetch(`${BASE_URL}/api/${BOARD}/cards/attachments/${cardId}`, {
    method: 'POST',
    headers: authHeaders(), // no Content-Type — let fetch set multipart boundary
    body: form,
  });
}

/** Upload a file to a note page's attachment slot via multipart POST. */
async function uploadNoteAttachment(pageId, filename, buffer, mimeType) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  return fetch(`${BASE_URL}/api/${BOARD}/notes/attachments/${pageId}`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------
const SEED_BOARD_PLAIN = {
  columns: [{
    id: 'col-pr1',
    title: 'Work',
    cards: [{ id: CARD_ID, text: 'Print Test Card', created: '2024-01-01' }],
  }],
};

const SEED_BOARD_WITH_IMG = {
  columns: [{
    id: 'col-pr1',
    title: 'Work',
    cards: [{
      id: CARD_ID,
      text: 'Print Test Card',
      created: '2024-01-01',
      description: `![${IMG_NAME}](attachment:${IMG_NAME})`,
    }],
  }],
};

const SEED_NOTES_PLAIN = {
  schemaVersion: 2,
  items: [{
    type: 'page', id: NOTE_ID, title: 'Print Test Note',
    description: '', link: '', linkedCards: [],
  }],
};

const SEED_NOTES_WITH_IMG = {
  schemaVersion: 2,
  items: [{
    type: 'page', id: NOTE_ID, title: 'Print Test Note',
    description: `![${IMG_NAME}](_attachments/${NOTE_ID}_${IMG_NAME})`,
    link: '', linkedCards: [],
  }],
};

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Open the edit modal for a card by clicking its text. */
async function openCardEditModal(page, cardText) {
  await page.locator('.card').filter({ hasText: cardText }).first().click();
  await expect(page.locator('#modal')).toBeVisible();
}

/** Open the notes sidebar if not already open. */
async function openSidebar(page) {
  const sidebar = page.locator('#notesSidebar');
  const isOpen = await sidebar.evaluate(el => el.classList.contains('notes-sidebar--open'));
  if (!isOpen) {
    await page.locator('#notesToggleBtn').click();
    await expect(sidebar).toHaveClass(/notes-sidebar--open/, { timeout: 5000 });
  }
  await expect(page.locator('#notesTreeBody')).toBeVisible();
}

/** Open a note page modal by clicking its tree item title. */
async function openNotePage(page, title) {
  await page.locator('.notes-tree-item--page').filter({ hasText: title })
    .locator('.notes-item-title').click();
  await expect(page.locator('#noteModal')).toBeVisible();
}

/** Wait until window._printCalled is true (set by our init-script shim). */
async function waitForPrint(page, timeout = 10_000) {
  await page.waitForFunction(() => window._printCalled === true, { timeout });
}

// ---------------------------------------------------------------------------

test.describe('3.8 Print view', () => {
  test.beforeAll(async () => {
    await apiPost(`/api/boards/${BOARD}`);
  });

  test.afterAll(async () => {
    await apiDelete(`/api/boards/${BOARD}`).catch(() => {});
  });

  test.beforeEach(async ({ page }) => {
    await apiPut(`/api/${BOARD}/board`, SEED_BOARD_PLAIN);
    await apiPut(`/api/${BOARD}/notes`, SEED_NOTES_PLAIN);
    // Intercept window.print before any page script runs
    await page.addInitScript(() => {
      window._printCalled = false;
      window.print = () => { window._printCalled = true; };
    });
    await page.goto(BOARD_URL);
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });
  });

  // E-PR-1 ------------------------------------------------------------------
  test('E-PR-1: card print — #print-root contains title and footer rows', async ({ page }) => {
    await openCardEditModal(page, 'Print Test Card');
    await page.locator('#modalPrintBtn').click();
    await waitForPrint(page);

    // Title
    const title = await page.evaluate(() =>
      document.querySelector('#print-root .print-title')?.textContent
    );
    expect(title).toBe('Print Test Card');

    // Footer must contain ID, URL and Status rows
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#print-root .print-footer-label')]
        .map(el => el.textContent)
    );
    expect(labels).toContain('ID');
    expect(labels).toContain('URL');
    expect(labels).toContain('Status');

    // Status is the last footer row
    expect(labels.at(-1)).toBe('Status');

    // Status value matches DD.MM.YYYY HH:MM
    const statusValue = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#print-root .print-footer-row')];
      const last = rows.at(-1);
      return last?.querySelector('.print-footer-value')?.textContent ?? '';
    });
    expect(statusValue).toMatch(/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
  });

  // E-PR-2 ------------------------------------------------------------------
  test('E-PR-2: card print — embedded image src resolved to blob: URL', async ({ page }) => {
    // Seed card with an image in its description and upload the actual file
    await apiPut(`/api/${BOARD}/board`, SEED_BOARD_WITH_IMG);
    await uploadCardAttachment(CARD_ID, IMG_NAME, MINIMAL_PNG, 'image/png');

    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });

    await openCardEditModal(page, 'Print Test Card');
    await page.locator('#modalPrintBtn').click();
    await waitForPrint(page);

    // The img inside #print-root must have a blob: src (not 'attachment:…')
    const imgSrc = await page.evaluate(() =>
      document.querySelector('#print-root img')?.src ?? ''
    );
    expect(imgSrc).toMatch(/^blob:/);
  });

  // E-PR-3 ------------------------------------------------------------------
  test('E-PR-3: note print — #print-root contains title and footer rows', async ({ page }) => {
    await openSidebar(page);
    await openNotePage(page, 'Print Test Note');
    await page.locator('#noteModalPrintBtn').click();
    await waitForPrint(page);

    // Title
    const title = await page.evaluate(() =>
      document.querySelector('#print-root .print-title')?.textContent
    );
    expect(title).toBe('Print Test Note');

    // Footer labels
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('#print-root .print-footer-label')]
        .map(el => el.textContent)
    );
    expect(labels).toContain('ID');
    expect(labels).toContain('URL');
    expect(labels).toContain('Status');
    expect(labels.at(-1)).toBe('Status');
  });

  // E-PR-4 ------------------------------------------------------------------
  test('E-PR-4: note print — embedded image src resolved to blob: URL', async ({ page }) => {
    // Seed note with an image in its description and upload the actual file
    await apiPut(`/api/${BOARD}/notes`, SEED_NOTES_WITH_IMG);
    await uploadNoteAttachment(NOTE_ID, IMG_NAME, MINIMAL_PNG, 'image/png');

    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });

    await openSidebar(page);
    await openNotePage(page, 'Print Test Note');
    await page.locator('#noteModalPrintBtn').click();
    await waitForPrint(page);

    // The img inside #print-root must have a blob: src (not '_attachments/…')
    const imgSrc = await page.evaluate(() =>
      document.querySelector('#print-root img')?.src ?? ''
    );
    expect(imgSrc).toMatch(/^blob:/);
  });
});
