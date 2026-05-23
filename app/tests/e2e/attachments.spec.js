'use strict';
/**
 * E2E — 3.7 Attachment uploads
 *
 * Tests upload behaviour for card attachments and note page attachments:
 * file listing, automatic markdown reference insertion, and the upload
 * indicator (label text changes to "Uploading…" while in-flight).
 *
 * Scenarios: E-AT-1 … E-AT-5
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-attach';
const BOARD_URL  = `/${BOARD}`;

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
// Seed data
// ---------------------------------------------------------------------------
const SEED_BOARD = {
  columns: [
    {
      id: 'col-at1',
      title: 'Work',
      cards: [
        { id: 'id-atcard', text: 'Upload Test Card', created: '2024-01-01' },
      ],
    },
  ],
};

const SEED_NOTES = {
  schemaVersion: 2,
  items: [
    {
      type: 'page', id: 'n-atpg1', title: 'Upload Test Page',
      description: '', link: '', linkedCards: [],
    },
  ],
};

async function resetBoard() {
  await apiPut(`/api/${BOARD}/board`, SEED_BOARD);
  await apiPut(`/api/${BOARD}/notes`, SEED_NOTES);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open the edit modal for a card by clicking it and wait for the modal. */
async function openCardEditModal(page, cardText) {
  await page.locator('.card').filter({ hasText: cardText }).first().click();
  await expect(page.locator('#modal')).toBeVisible();
  // Attachments section is auto-expanded at 1280px viewport width (wide=true)
  await expect(page.locator('#cardAttachmentsSection')).toBeVisible();
}

/** Open the notes sidebar. */
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
  // Attachments section is auto-expanded at 1280px viewport width
  await expect(page.locator('#noteAttachmentsSection')).toBeVisible();
}

// ---------------------------------------------------------------------------

test.describe('3.7 Attachment uploads', () => {
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

  // E-AT-1 -----------------------------------------------------------------
  test('E-AT-1: card upload → file listed in attachment list', async ({ page }) => {
    await openCardEditModal(page, 'Upload Test Card');

    await page.locator('#cardAttachInput').setInputFiles({
      name: 'card-doc.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('card attachment content'),
    });

    await expect(page.locator('#cardAttachList')).toContainText('card-doc.txt', { timeout: 8000 });
  });

  // E-AT-2 -----------------------------------------------------------------
  test('E-AT-2: card upload → markdown reference auto-inserted in description', async ({ page }) => {
    await openCardEditModal(page, 'Upload Test Card');

    await page.locator('#cardAttachInput').setInputFiles({
      name: 'report.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('report content'),
    });

    // Wait for the upload to complete (file appears in list)
    await expect(page.locator('#cardAttachList')).toContainText('report.txt', { timeout: 8000 });

    // Description textarea should contain an auto-inserted markdown link
    const desc = await page.locator('#cardDesc').inputValue();
    expect(desc).toContain('report.txt');
    expect(desc).toContain('attachment:report.txt');
  });

  // E-AT-3 -----------------------------------------------------------------
  test('E-AT-3: card upload shows "Uploading…" label during upload, restores afterwards', async ({ page }) => {
    await openCardEditModal(page, 'Upload Test Card');

    // Intercept only the POST upload request and hold it; let GET requests through
    let resolveUpload;
    const uploadHeld = new Promise(r => { resolveUpload = r; });
    await page.route(`**/api/${BOARD}/cards/attachments/**`, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await uploadHeld;
      await route.continue();
    });

    // Trigger upload — change event fires synchronously; fetch is held by route
    await page.locator('#cardAttachInput').setInputFiles({
      name: 'indicator.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });

    // Label should show the uploading state while the request is in-flight
    await expect(page.locator('label[for="cardAttachInput"]')).toHaveText('Uploading…');

    // Release the held request — label must restore once the upload completes
    resolveUpload();
    await expect(page.locator('label[for="cardAttachInput"]')).toHaveText('+ Upload');
  });

  // E-AT-4 -----------------------------------------------------------------
  test('E-AT-4: note page upload → markdown reference auto-inserted in description', async ({ page }) => {
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');

    await page.locator('#noteAttachInput').setInputFiles({
      name: 'note-photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('PNG'),
    });

    // openNoteModal resets #notePageDesc to page.description (''); toHaveValue only
    // passes once _appendAttachMd has set it during the upload — making this a direct,
    // race-free assertion that the auto-insertion happened.
    await expect(page.locator('#notePageDesc')).toHaveValue(
      /!\[note-photo\.png\]\(_attachments\//, { timeout: 8000 }
    );
    // Also confirm the file appears in the attachment list
    await expect(page.locator('#noteAttachList')).toContainText('note-photo.png', { timeout: 8000 });
  });

  // E-AT-5 -----------------------------------------------------------------
  test('E-AT-5: note page upload shows "Uploading…" label during upload, restores afterwards', async ({ page }) => {
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');

    // Intercept only the POST upload request and hold it; let GET requests through
    let resolveUpload;
    const uploadHeld = new Promise(r => { resolveUpload = r; });
    await page.route(`**/api/${BOARD}/notes/attachments/**`, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await uploadHeld;
      await route.continue();
    });

    await page.locator('#noteAttachInput').setInputFiles({
      name: 'indicator.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('x'),
    });

    // Label should show the uploading state while the request is in-flight
    await expect(page.locator('label[for="noteAttachInput"]')).toHaveText('Uploading…');

    // Release the held request — label must restore once the upload completes
    resolveUpload();
    await expect(page.locator('label[for="noteAttachInput"]')).toHaveText('+ Upload');
  });

  // E-AT-6 -----------------------------------------------------------------
  test('E-AT-6: card modal paste image → uploaded and markdown inserted in description', async ({ page }) => {
    await openCardEditModal(page, 'Upload Test Card');

    // Dispatch a synthetic paste event carrying a 1×1 PNG onto the card modal
    await page.evaluate(() => {
      const png = new Uint8Array([
        137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
        8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,215,99,248,207,
        192,0,0,0,2,0,1,226,33,188,51,0,0,0,0,73,69,78,68,174,66,96,130,
      ]);
      const file = new File([png], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      document.getElementById('modal').dispatchEvent(event);
    });

    // File should appear in the attachment list with a pasted-<timestamp>.png name
    await expect(page.locator('#cardAttachList')).toContainText(/pasted-\d+\.png/, { timeout: 8000 });
    // An image markdown reference should be auto-inserted in the description
    const desc = await page.locator('#cardDesc').inputValue();
    expect(desc).toMatch(/!\[pasted-\d+\.png\]\(attachment:pasted-\d+\.png\)/);
  });

  // E-AT-7 -----------------------------------------------------------------
  test('E-AT-7: note page modal paste image → uploaded and markdown inserted in description', async ({ page }) => {
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');

    // Dispatch a synthetic paste event carrying a 1×1 PNG onto the note modal
    await page.evaluate(() => {
      const png = new Uint8Array([
        137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
        8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,215,99,248,207,
        192,0,0,0,2,0,1,226,33,188,51,0,0,0,0,73,69,78,68,174,66,96,130,
      ]);
      const file = new File([png], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
      document.getElementById('noteModal').dispatchEvent(event);
    });

    // File should appear in the attachment list with a pasted-<timestamp>.png name
    await expect(page.locator('#noteAttachList')).toContainText(/pasted-\d+\.png/, { timeout: 8000 });
    // An image markdown reference should be auto-inserted in the description
    await expect(page.locator('#notePageDesc')).toHaveValue(
      /!\[pasted-\d+\.png\]\(_attachments\/n-atpg1_pasted-\d+\.png\)/,
      { timeout: 8000 }
    );
  });
});
