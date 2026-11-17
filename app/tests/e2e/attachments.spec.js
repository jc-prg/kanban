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
const BASE_URL   = process.env.E2E_BASE_URL;
const BOARD      = 'e2e-attach';
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
    // files go into the "---" list at the end; an image (no edit cursor yet) above that list
    expect(desc).toMatch(/(^|\n)---\n- \[report\.txt\]\(attachment:report\.txt\)$/);

    await page.locator('#cardAttachInput').setInputFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('2') });
    await expect(page.locator('#cardAttachList')).toContainText('second.txt', { timeout: 8000 });
    await page.locator('#cardAttachInput').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from('PNG') });
    await expect(page.locator('#cardAttachList')).toContainText('pic.png', { timeout: 8000 });
    const desc2 = await page.locator('#cardDesc').inputValue();
    expect(desc2).toMatch(/!\[pic\.png\]\(attachment:pic\.png\)\n\n---\n- \[report\.txt\]\(attachment:report\.txt\)\n- \[second\.txt\]\(attachment:second\.txt\)$/);
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
    await expect(page.locator('label[for="cardAttachInput"]')).toHaveText('Uploading');   // + animated dots (CSS)

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
    await expect(page.locator('label[for="noteAttachInput"]')).toHaveText('Uploading');   // + animated dots (CSS)

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

  // E-AT-8 -----------------------------------------------------------------
  test('E-AT-8: WebDAV list with scopes → the page\'s own files under "Attachments", the folder\'s others under "Attachments (Folder)"; insert uses the file\'s link', async ({ page }) => {
    await page.route(`**/api/${BOARD}/notes/attachments/n-atpg1`, r => r.request().method() === 'GET'
      ? r.fulfill({ json: [
          { name: 'mine.png', size: 10, link: '_attachments/mine.png', scope: 'page' },
          { name: 'other doc.pdf', size: 2048, link: '_attachments/other%20doc.pdf', scope: 'folder' },
        ] })
      : r.continue());
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');
    await expect(page.locator('#noteAttachList .note-attach-item')).toHaveCount(1);
    await expect(page.locator('#noteAttachList')).toContainText('mine.png');
    await expect(page.locator('#noteAttachFolderField')).toBeVisible();
    await expect(page.locator('#noteAttachFolderField > label')).toHaveText('Attachments (Folder)');
    await expect(page.locator('#noteAttachFolderList .note-attach-item')).toHaveCount(1);
    await expect(page.locator('#noteAttachFolderList')).toContainText('other doc.pdf');
    await expect(page.locator('#noteToggleAttachments')).toContainText('1');   // count = the page's own
    // Insert link of a folder file: its real link
    await page.locator('#noteAttachFolderList [data-act="insert"]').click();
    await expect(page.locator('#notePageDesc')).toHaveValue(/\[other doc\.pdf\]\(_attachments\/other%20doc\.pdf\)/);
  });

  test('E-AT-9: board without WebDAV (no scopes) → no folder section', async ({ page }) => {
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');
    await expect(page.locator('#noteAttachFolderField')).toBeHidden();
  });

  // ---- WebDAV boards (notes module switched to WebDAV mode, notes routes mocked) ----
  const PNG = Buffer.from([
    137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,
    8,2,0,0,0,144,119,83,222,0,0,0,12,73,68,65,84,8,215,99,248,207,
    192,0,0,0,2,0,1,226,33,188,51,0,0,0,0,73,69,78,68,174,66,96,130,
  ]);
  const webdavMode = page => page.waitForFunction(() => !!window._notesModule)
    .then(() => page.evaluate(() => window._notesModule.updateWebdavEnabled(true)));

  test('E-AT-10: WebDAV save fails (file locked) → message with only OK, "Locked since" in local time; the note stays open with the changes', async ({ page }) => {
    await page.route(`**/api/${BOARD}/notes/pages/n-atpg1/content`, r => r.fulfill({ json: { id: 'n-atpg1', title: 'Upload Test Page', content: 'Old', link: '', linkedCards: [], etag: 'e1' } }));
    await page.route(`**/api/${BOARD}/notes/pages/n-atpg1`, r => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 423, json: { error: '"Upload Test Page" is locked on the server by Text (Nextcloud app lock), without expiry.', lock: { owner: 'Text', app: true, since: '2026-11-17T09:13:35.000Z' } } })
      : r.continue());
    await webdavMode(page);
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');
    await page.evaluate(() => { document.getElementById('notePageTitle').value = 'Changed title'; });
    await page.locator('#noteModalSaveBtn').click();
    await expect(page.locator('#dialogBackdrop')).toBeVisible();
    await expect(page.locator('#dialogMsg')).toContainText('locked on the server by Text');
    await expect(page.locator('#dialogMsg')).toContainText('Locked since');
    await expect(page.locator('#dialogMsg')).toContainText('Your changes are still in the editor.');
    await expect(page.locator('#dialogCancelBtn')).toBeHidden();
    await page.locator('#dialogOkBtn').click();
    await expect(page.locator('#dialogBackdrop')).toBeHidden();
    await expect(page.locator('#noteModal')).toBeVisible();
    await expect(page.locator('#notePageTitle')).toHaveValue('Changed title');
  });

  test('E-AT-11: WebDAV, page not saved yet → dropping a file asks to save first (Cancel / Save now); Save now saves, then uploads', async ({ page }) => {
    const calls = [];
    await page.route(`**/api/${BOARD}/notes/pages`, async r => {
      calls.push('create');
      const { page: pg } = r.request().postDataJSON();
      await r.fulfill({ json: { ok: true, notes: { schemaVersion: 2, items: [{ ...pg, type: 'page' }, ...SEED_NOTES.items] }, page: { id: pg.id, etag: 'e1', wdPath: `${pg.title}.md` } } });
    });
    await page.route(`**/api/${BOARD}/notes/attachments/**`, r => {
      if (r.request().method() === 'POST') { calls.push('upload'); return r.fulfill({ json: { name: 'drop.png', size: 3, link: '_attachments/drop.png', etag: 'e2' } }); }
      return r.fulfill({ json: [] });
    });
    await webdavMode(page);
    await openSidebar(page);
    await page.locator('#notesAddRootBtn').click();
    await expect(page.locator('#noteModal')).toBeVisible();
    const drop = () => page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['PNG'], 'drop.png', { type: 'image/png' }));
      const m = document.getElementById('noteModal');
      m.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      m.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await drop();
    await expect(page.locator('#dialogMsg')).toContainText('Save the page first');
    await expect(page.locator('#dialogOkBtn')).toHaveText('Save now');
    await page.locator('#dialogCancelBtn').click();
    expect(calls).toEqual([]);
    await expect(page.locator('#noteModal')).toBeVisible();
    await drop();
    await page.locator('#dialogOkBtn').click();
    await expect.poll(() => calls).toEqual(['create', 'upload']);
    await expect(page.locator('#noteModal')).toBeVisible();
  });

  test('E-AT-12: "+ Upload" while uploading: accent like Save, "Uploading" with animated dots; back afterwards', async ({ page }) => {
    let release;
    const gate = new Promise(r => { release = r; });
    await page.route(`**/api/${BOARD}/notes/attachments/n-atpg1`, async r => {
      if (r.request().method() !== 'POST') return r.continue();
      await gate;
      await r.fulfill({ json: { name: 'slow.txt', size: 4 } });
    });
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');
    await page.locator('#noteAttachInput').setInputFiles({ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('slow') });
    const label = page.locator('label[for="noteAttachInput"]');
    await expect(label).toHaveText('Uploading');
    await expect(label).toHaveClass(/btn-accent/);
    // Text and background like the Save button
    const look = el => el.evaluate(e => { const s = getComputedStyle(e); return { color: s.color, bg: s.backgroundColor }; });
    const save = await look(page.locator('#noteModalSaveBtn'));
    await expect.poll(() => look(label)).toEqual(save);   // after .btn's colour transition
    await expect(label.locator('.loading-dots')).toHaveCount(1);
    const anim = await label.locator('.loading-dots').evaluate(el => getComputedStyle(el, '::after').animationName);
    expect(anim).toBe('loading-dots');
    release();
    await expect(label).toHaveText('+ Upload');
    await expect(label).not.toHaveClass(/btn-accent/);
  });

  test('E-AT-13: attachment images show a loading placeholder (no broken icon) until loaded, are cached across re-renders; broken only when loading fails', async ({ page }) => {
    await apiPut(`/api/${BOARD}/notes`, { schemaVersion: 2, items: [{ ...SEED_NOTES.items[0],
      description: '![pic](_attachments/n-atpg1_pic.png)\n\n![gone](_attachments/n-atpg1_gone.png)' }] });
    await page.reload();
    let release, fetches = 0;
    const gate = new Promise(r => { release = r; });
    await page.route(`**/api/${BOARD}/notes/attachments/n-atpg1/pic.png`, async r => { fetches++; await gate; await r.fulfill({ body: PNG, contentType: 'image/png' }); });
    await page.route(`**/api/${BOARD}/notes/attachments/n-atpg1/gone.png`, r => r.fulfill({ status: 404, json: { error: 'Not found' } }));
    await openSidebar(page);
    await openNotePage(page, 'Upload Test Page');
    const pic = page.locator('#noteModal .cm-preview img[alt="pic"]');
    await expect(pic).toHaveClass(/att-img--loading/);
    expect(await pic.getAttribute('src')).toMatch(/^data:image\/gif/);   // placeholder, not the unloadable path
    await expect(page.locator('#noteModal .cm-preview img[alt="gone"]')).toHaveClass(/att-img--broken/);
    release();
    await expect(pic).not.toHaveClass(/att-img--loading/);
    expect(await pic.getAttribute('src')).toMatch(/^blob:/);
    expect(await pic.evaluate(el => el.naturalWidth)).toBe(1);
    // Re-render (close and reopen): served from the cache, no second request
    await page.locator('#noteModalBarClose').click();
    await expect(page.locator('#noteModal')).toBeHidden();
    await openNotePage(page, 'Upload Test Page');
    await expect(pic).toHaveAttribute('src', /^blob:/);
    expect(fetches).toBe(1);
  });
});
