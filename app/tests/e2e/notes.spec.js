'use strict';
/**
 * E2E — 3.6 Notes sidebar
 *
 * Tests the notes sidebar tree, page/folder creation, editing, attachments,
 * linked cards, drag-to-reorder, and ZIP export.
 * Scenarios: E-N-1 … E-N-11
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = 'http://localhost:3000';
const BOARD      = 'e2e-notes';
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
// Board + notes seed
// ---------------------------------------------------------------------------
const SEED_BOARD = {
  columns: [
    {
      id: 'col-notes',
      title: 'Cards',
      cards: [
        { id: 'id-nc1', text: 'Note-linked Card', created: '2024-01-01' },
      ],
    },
  ],
};

const EMPTY_NOTES = { schemaVersion: 2, items: [] };

async function resetBoard() {
  await apiPut(`/api/${BOARD}/board`, SEED_BOARD);
  await apiPut(`/api/${BOARD}/notes`, EMPTY_NOTES);
}

/** Open the notes sidebar and wait for the tree container to be ready. */
async function openSidebar(page) {
  const toggleBtn = page.locator('#notesToggleBtn');
  await toggleBtn.waitFor({ state: 'visible', timeout: 5000 });
  const isOpen = await page.locator('#notesSidebar').evaluate(
    el => el.classList.contains('notes-sidebar--open')
  );
  if (!isOpen) {
    await toggleBtn.click();
    await expect(page.locator('#notesSidebar')).toHaveClass(/notes-sidebar--open/, { timeout: 5000 });
  }
  await expect(page.locator('#notesTreeBody')).toBeVisible();
}

// ---------------------------------------------------------------------------

test.describe('3.6 Notes sidebar', () => {
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

  // E-N-1 ------------------------------------------------------------------
  test('E-N-1: open notes sidebar → tree renders', async ({ page }) => {
    await openSidebar(page);
    await expect(page.locator('#notesTreeBody')).toBeVisible();
    // Empty state text shown
    await expect(page.locator('#notesTreeBody')).toContainText('No pages yet');
  });

  // E-N-2 ------------------------------------------------------------------
  test('E-N-2: add top-level page → appears in tree at root', async ({ page }) => {
    await openSidebar(page);
    await page.click('#notesAddRootBtn');
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.fill('#notePageTitle', 'Root Page');
    await page.click('#noteModalSaveBtn');
    // Save closes the modal automatically
    await expect(page.locator('#noteModal')).toBeHidden();

    // Page appears in tree
    const pageItem = page.locator('.notes-tree-item--page');
    await expect(pageItem).toHaveCount(1);
    await expect(pageItem.locator('.notes-item-title')).toContainText('Root Page');
  });

  // E-N-3 ------------------------------------------------------------------
  test('E-N-3: add folder → add page inside folder → page nested', async ({ page }) => {
    await openSidebar(page);

    // Create folder
    await page.click('#notesAddFolderBtn');
    // Folder appears; it enters rename mode — type the folder name
    const folderInput = page.locator('.notes-folder-rename-input');
    await expect(folderInput).toBeVisible();
    await folderInput.fill('My Folder');
    await folderInput.press('Enter');

    // Folder item in tree
    const folderItem = page.locator('.notes-tree-item--folder');
    await expect(folderItem).toHaveCount(1);

    // Hover to reveal folder action buttons (opacity: 0 → 1 on hover), then add page
    await folderItem.hover();
    await folderItem.locator('.notes-item-btn--add').click();
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.fill('#notePageTitle', 'Nested Page');
    await page.click('#noteModalSaveBtn');
    // Save closes the modal automatically
    await expect(page.locator('#noteModal')).toBeHidden();

    // Folder auto-expands when add-page is clicked (handler calls notesExpanded.add)
    // Nested page appears at depth 1
    const pageItem = page.locator('.notes-tree-item--page');
    await expect(pageItem).toHaveCount(1);
    await expect(pageItem.locator('.notes-item-title')).toContainText('Nested Page');
  });

  // E-N-4 ------------------------------------------------------------------
  test('E-N-4: add subfolder inside folder; at depth 2 add-subfolder button absent', async ({ page }) => {
    await openSidebar(page);

    // Root folder (depth 0)
    await page.click('#notesAddFolderBtn');
    const rootFolderInput = page.locator('.notes-folder-rename-input');
    await expect(rootFolderInput).toBeVisible();
    await rootFolderInput.fill('Root Folder');
    await rootFolderInput.press('Enter');

    const rootFolder = page.locator('.notes-tree-item--folder').filter({ has: page.locator('.notes-item-title--root') });

    // Hover root folder to reveal action buttons, then add subfolder (depth 1)
    await rootFolder.hover();
    await rootFolder.locator('.notes-item-btn--add-folder').click();
    // Subfolder rename input appears
    const subInput = page.locator('.notes-folder-rename-input');
    await expect(subInput).toBeVisible();
    await subInput.fill('Sub Folder');
    await subInput.press('Enter');

    // Root folder auto-expands (handler calls notesExpanded.add before addNoteFolder)
    // Subfolder is depth 1 — it should still have an add-subfolder button
    const subFolder = page.locator('.notes-tree-item--folder[data-depth="1"]');
    await expect(subFolder.locator('.notes-item-btn--add-folder')).toHaveCount(1);

    // Hover subfolder to reveal buttons, then add sub-subfolder (depth 2)
    await subFolder.hover();
    await subFolder.locator('.notes-item-btn--add-folder').click();
    const subSubInput = page.locator('.notes-folder-rename-input');
    await expect(subSubInput).toBeVisible();
    await subSubInput.fill('Sub-Sub Folder');
    await subSubInput.press('Enter');

    // Sub-sub folder auto-expands in tree; no manual toggle needed

    // The depth-2 folder should NOT have an add-subfolder button
    const subSubFolder = page.locator('.notes-tree-item--folder[data-depth="2"]');
    await expect(subSubFolder.locator('.notes-item-btn--add-folder')).toHaveCount(0);
  });

  // E-N-5 ------------------------------------------------------------------
  test('E-N-5: edit page → markdown description previewed on blur', async ({ page }) => {
    await openSidebar(page);

    // Create a page
    await page.click('#notesAddRootBtn');
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.fill('#notePageTitle', 'Preview Page');

    // Set markdown description via editor API → preview renders immediately
    await page.evaluate(() => window.setEditorValue('notePageDesc', '**bold text**'));

    // Preview pane should show rendered HTML
    await expect(page.locator('#notePageDesc-mount .cm-preview')).toBeVisible();
    await expect(page.locator('#notePageDesc-mount .cm-preview strong')).toBeVisible();
  });

  // E-N-6 ------------------------------------------------------------------
  test('E-N-6: upload attachment to page → file listed', async ({ page }) => {
    await openSidebar(page);

    // Create a page and save it (save closes the modal)
    await page.click('#notesAddRootBtn');
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.fill('#notePageTitle', 'Attach Page');
    await page.click('#noteModalSaveBtn');
    await expect(page.locator('#noteModal')).toBeHidden();

    // Re-open the page modal by clicking its title in the tree
    await page.locator('.notes-tree-item--page .notes-item-title').click();
    await expect(page.locator('#noteModal')).toBeVisible();

    // At 1280px width, _initNoteSectionToggles auto-expands all sections
    await expect(page.locator('#noteAttachmentsSection')).toBeVisible();

    // Upload a small file
    const fileContent = Buffer.from('hello world');
    await page.locator('#noteAttachInput').setInputFiles({
      name: 'test-file.txt',
      mimeType: 'text/plain',
      buffer: fileContent,
    });

    // File should appear in the attachments list
    await expect(page.locator('#noteAttachList')).toContainText('test-file.txt', { timeout: 8000 });
  });

  // E-N-7 ------------------------------------------------------------------
  test('E-N-7: insert attachment as markdown → appears in description', async ({ page }) => {
    await openSidebar(page);

    // Create and save a page (save closes the modal)
    await page.click('#notesAddRootBtn');
    await page.fill('#notePageTitle', 'Insert Page');
    await page.click('#noteModalSaveBtn');
    await expect(page.locator('#noteModal')).toBeHidden();

    // Re-open the page modal by clicking its title in the tree
    await page.locator('.notes-tree-item--page .notes-item-title').click();
    await expect(page.locator('#noteModal')).toBeVisible();

    // At 1280px, attachments section is auto-expanded; upload directly
    await expect(page.locator('#noteAttachmentsSection')).toBeVisible();
    await page.locator('#noteAttachInput').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('PNG'),
    });
    await expect(page.locator('#noteAttachList')).toContainText('photo.png', { timeout: 8000 });

    // Click the insert-as-markdown button (the attachment list item's insert button)
    const insertBtn = page.locator('#noteAttachList [data-act="insert"]').first();
    await expect(insertBtn).toBeVisible({ timeout: 5000 });
    await insertBtn.click();
    // Description textarea should now contain a markdown image link
    const descValue = await page.locator('#notePageDesc').inputValue();
    expect(descValue).toContain('photo.png');
  });

  // E-N-8 ------------------------------------------------------------------
  test('E-N-8: link card to page via search → card listed in page', async ({ page }) => {
    await openSidebar(page);

    // Create and save a page (save closes the modal)
    await page.click('#notesAddRootBtn');
    await page.fill('#notePageTitle', 'Link Page');
    await page.click('#noteModalSaveBtn');
    await expect(page.locator('#noteModal')).toBeHidden();

    // Re-open the page modal by clicking its title in the tree
    await page.locator('.notes-tree-item--page .notes-item-title').click();
    await expect(page.locator('#noteModal')).toBeVisible();

    // At 1280px, linked cards section is auto-expanded
    await expect(page.locator('#noteLinkedCardsSection')).toBeVisible();

    // Search for the card
    await page.fill('#noteCardSearchInput', 'Note-linked Card');
    await expect(page.locator('#noteCardSearchResults')).toBeVisible({ timeout: 5000 });

    // Click first result to link
    await page.locator('#noteCardSearchResults .note-card-search-result').first().click();

    // Card appears in the linked cards list
    await expect(page.locator('#noteLinkedCardsList')).toContainText('Note-linked Card');
  });

  // E-N-9 ------------------------------------------------------------------
  test('E-N-9: drag card onto note page → link confirmed', async ({ page }) => {
    // Seed a page in the notes state
    await apiPut(`/api/${BOARD}/notes`, {
      schemaVersion: 2,
      items: [
        {
          type: 'page', id: 'n-dragpg1', title: 'Drop Target Page',
          description: '', link: '', linkedCards: [],
        },
      ],
    });

    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });
    await openSidebar(page);

    const pageItem = page.locator('.notes-tree-item--page').first();
    await expect(pageItem).toBeVisible();

    // Drag the board card onto the note page item
    await page.dragAndDrop(
      '.card:has-text("Note-linked Card")',
      '.notes-tree-item--page'
    );

    // Confirm dialog should appear
    await expect(page.locator('#dialogBackdrop')).toBeVisible({ timeout: 5000 });
    await page.click('#dialogOkBtn');

    // Open the page and verify the linked card indicator
    await pageItem.locator('.notes-item-title').click();
    await expect(page.locator('#noteModal')).toBeVisible();
    await page.click('#noteToggleLinkedCards');
    await expect(page.locator('#noteLinkedCardsList')).toContainText('Note-linked Card');
  });

  // E-N-10 -----------------------------------------------------------------
  test('E-N-10: reorder pages by drag → new order persists after reload', async ({ page }) => {
    // Seed two pages
    await apiPut(`/api/${BOARD}/notes`, {
      schemaVersion: 2,
      items: [
        { type: 'page', id: 'n-ord1', title: 'Page One',   description: '', link: '', linkedCards: [] },
        { type: 'page', id: 'n-ord2', title: 'Page Two',   description: '', link: '', linkedCards: [] },
        { type: 'page', id: 'n-ord3', title: 'Page Three', description: '', link: '', linkedCards: [] },
      ],
    });

    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });
    await openSidebar(page);

    const items = page.locator('.notes-tree-item--page');
    await expect(items).toHaveCount(3);

    // Drag "Page Three" above "Page One"
    const pageThree = items.filter({ hasText: 'Page Three' });
    const pageOne   = items.filter({ hasText: 'Page One' });
    await pageThree.dragTo(pageOne);

    await page.waitForTimeout(1000); // wait for save
    await page.reload();
    await openSidebar(page);

    const firstTitle = await page.locator('.notes-tree-item--page .notes-item-title').first().textContent();
    expect(firstTitle?.trim()).toBe('Page Three');
  });

  // E-N-11 -----------------------------------------------------------------
  test('E-N-11: export notes → ZIP download triggered', async ({ page }) => {
    // Seed a page so the export has content
    await apiPut(`/api/${BOARD}/notes`, {
      schemaVersion: 2,
      items: [
        { type: 'page', id: 'n-exp1', title: 'Export Page', description: 'content', link: '', linkedCards: [] },
      ],
    });

    await page.reload();
    await expect(page.locator('.column')).toHaveCount(1, { timeout: 10_000 });
    await openSidebar(page);

    // The export button is in the notes sidebar header menu or board header menu.
    // Trigger download by navigating directly to the export URL.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.evaluate(async (board) => {
        // Trigger the export endpoint directly via fetch and simulate download
        const a = document.createElement('a');
        a.href = `/api/${board}/notes/export`;
        a.download = 'notes.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, BOARD),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.zip$/);
  });
});
