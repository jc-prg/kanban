'use strict';
/**
 * E2E — 3.5 Search
 *
 * Tests the Find dialog (Ctrl+F) with text, column, and page filters, plus events / mail (server-side, mocked).
 * Scenarios: E-S-1 … E-S-10
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
const BASE_URL   = process.env.E2E_BASE_URL;
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

/** Ctrl+F, then pick a category in the overview. */
async function openFind(page, mode = 'cards') {
  await page.keyboard.press('Control+f');
  await page.click(`#searchOverview [data-mode="${mode}"]`);
}

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
  test('E-S-1: Ctrl+F opens the Find dialog with the category overview; a pick shows its search', async ({ page }) => {
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchBackdrop')).toBeVisible();
    await expect(page.locator('#searchOverview')).toBeVisible();
    await expect(page.locator('#searchMain')).toBeHidden();
    await expect(page.locator('.search-scope')).toBeHidden();
    await page.click('#searchOverview [data-mode="cards"]');
    await expect(page.locator('#searchOverview')).toBeHidden();
    await expect(page.locator('#searchText')).toBeFocused();
    await expect(page.locator('#searchToggleCards')).toHaveClass(/active/);
  });

  // E-S-2 ------------------------------------------------------------------
  test('E-S-2: typing a query shows matching cards', async ({ page }) => {
    await openFind(page);
    await page.fill('#searchText', 'Unique Alpha');
    const results = page.locator('#searchResults .search-result-item');
    await expect(results).toHaveCount(1);
    await expect(results.first()).toContainText('Unique Alpha Card');
  });

  // E-S-3 ------------------------------------------------------------------
  test('E-S-3: clicking a result opens the edit modal for that card', async ({ page }) => {
    await openFind(page);
    await page.fill('#searchText', 'Beta Card');
    await expect(page.locator('#searchResults .search-result-item')).toHaveCount(1);

    // Click the result
    await page.click('#searchResults .search-result-item');
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Beta Card');
  });

  // E-S-4 ------------------------------------------------------------------
  test('E-S-4: unchecking a column hides its cards', async ({ page }) => {
    await openFind(page);
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

    // Cards first, then the header switch to Pages
    await openFind(page);
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

  // E-S-7 ------------------------------------------------------------------
  test('E-S-7: panel layout, overview, icon switch; Events: 3 characters, account, date range, result opens the detail panel', async ({ page }) => {
    const calls = [];
    // One handler for the whole search API (the last registered handler for a URL runs first)
    await page.route('**/api/today/search**', r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/api/today/search')) {
        return r.fulfill({ json: { types: ['cards', 'notes', 'events', 'mail'], mailAccounts: [{ id: 'ma-a', label: 'Work', color: '#0a0' }],
          calendarAccounts: [{ id: 'ca-e2e', label: 'Team', color: '#e11' }, { id: 'ca-2', label: 'Private', color: '#11e' }] } });
      }
      calls.push(`${url.pathname.split('/').pop()}?${url.searchParams}`);
      return r.fulfill({ json: { items: [
        { uid: 'ev-1', title: 'ACME kickoff', location: 'Room 4', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z', accountId: 'ca-e2e', label: 'Team', color: '#e11', webUrl: '' },
        { uid: 'ev-1', title: 'ACME kickoff', location: 'Room 4', start: '2026-03-09T09:00:00Z', end: '2026-03-09T10:00:00Z', accountId: 'ca-e2e', label: 'Team', color: '#e11', webUrl: '' },
      ], total: 2 } });
    });
    await page.route('**/api/dashboard/calendar/ca-e2e/event/**', r => r.fulfill({ json: { uid: 'ev-1', title: 'ACME kickoff', location: 'Room 4', start: '2026-03-02T09:00:00Z', end: '2026-03-02T10:00:00Z' } }));

    await page.keyboard.press('Control+f');
    const modal = page.locator('#searchBackdrop .search-modal');
    // Panel format: header bar with the title and a close icon; the overview lists all four categories
    await expect(modal).toHaveClass(/panel-modal/);
    await expect(modal.locator('.panel-modal-bar .panel-hdr-title')).toHaveText('Find');
    await expect(page.locator('#searchCloseBtn')).toBeHidden();
    const tiles = page.locator('#searchOverview .search-ov-btn');
    await expect(tiles.filter({ visible: true })).toHaveCount(4);
    expect(await tiles.evaluateAll(els => els.map(e => e.dataset.mode))).toEqual(['cards', 'pages', 'events', 'mail']);
    await expect(tiles.first().locator('svg')).toBeVisible();
    // 2 × 2, centred in the dialog
    const boxes = await tiles.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; }));
    expect(boxes[0][1]).toBe(boxes[1][1]);
    expect(boxes[2][1]).toBe(boxes[3][1]);
    expect(boxes[0][0]).toBe(boxes[2][0]);
    const ov = await page.locator('#searchOverview').boundingBox(), first = await tiles.first().boundingBox(), last = await tiles.last().boundingBox();
    expect(Math.abs((first.x - ov.x) - (ov.x + ov.width - last.x - last.width))).toBeLessThan(2);

    await page.click('#searchOverview [data-mode="events"]');
    // Header switch: icons only (label in the tooltip)
    await expect(page.locator('#searchToggleEvents')).toHaveClass(/active/);
    await expect(page.locator('#searchToggleEvents')).toHaveText('');
    await expect(page.locator('#searchToggleEvents')).toHaveAttribute('title', 'Events');
    await expect(page.locator('#searchToggleEvents svg')).toBeVisible();
    await expect(page.locator('#searchCardFilters')).toBeHidden();
    await expect(page.locator('#searchRangeFilters')).toBeVisible();
    await expect(page.locator('#searchFolderGroup')).toBeHidden();
    await expect(page.locator('#searchAccount option')).toHaveText(['All calendars', 'Team', 'Private']);
    // Account and From / To in one row
    const rowY = async id => Math.round((await page.locator(id).boundingBox()).y);
    expect(await rowY('#searchFrom')).toBe(await rowY('#searchAccount'));
    expect(await rowY('#searchTo')).toBe(await rowY('#searchAccount'));
    await page.fill('#searchText', 'ac');
    await expect(page.locator('#searchResults')).toContainText('at least 3 characters');
    await page.waitForTimeout(500);
    expect(calls).toEqual([]);

    await page.fill('#searchText', 'acme');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toBe('events?q=acme&full=1');
    await page.selectOption('#searchAccount', 'ca-e2e');
    await expect.poll(() => calls.at(-1)).toBe('events?q=acme&full=1&account=ca-e2e');
    await page.fill('#searchFrom', '2026-03-01');
    await page.fill('#searchTo', '2026-03-31');
    await expect.poll(() => calls.at(-1)).toBe('events?q=acme&full=1&from=2026-03-01&to=2026-03-31&account=ca-e2e');
    const results = page.locator('#searchResults .search-result-item');
    await expect(results).toHaveCount(2);   // every occurrence in the range
    await expect(results.first()).toContainText('ACME kickoff');
    await expect(results.first()).toContainText('Room 4');
    await expect(page.locator('#searchCount')).toHaveText('2 results');
    // Back to cards and again to events: the results are kept, nothing is fetched again
    const n = calls.length;
    await page.click('#searchToggleCards');
    await expect(page.locator('#searchAccountFilters')).toBeHidden();
    await page.click('#searchToggleEvents');
    await expect(results).toHaveCount(2);
    expect(calls.length).toBe(n);

    await results.first().click();
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    await expect(page.locator('#dashboardDetail')).toBeVisible();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('ACME kickoff');
    await page.click('#dashboardDetailClose');

    // Every Find starts with the overview; the close icon closes the dialog
    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchOverview')).toBeVisible();
    await modal.locator('.panel-modal-bar .dashboard-detail-close').click();
    await expect(page.locator('#searchBackdrop')).toBeHidden();
  });

  // E-S-8 ------------------------------------------------------------------
  test('E-S-8: Mail: all accounts (one request each), one account, one folder, message text and date range; result opens the mail', async ({ page }) => {
    const calls = [];
    await page.route('**/api/today/search**', r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/api/today/search')) {
        return r.fulfill({ json: { types: ['cards', 'notes', 'mail'], calendarAccounts: [], mailAccounts: [
          { id: 'ma-a', label: 'Work', color: '#0a0' }, { id: 'ma-b', label: 'Home', color: '#00a' }] } });
      }
      calls.push(url.searchParams.toString());
      const acc = url.searchParams.get('account');
      return r.fulfill({ json: { items: [{ id: acc === 'ma-a' ? '11' : '22', subject: `ACME from ${acc}`, from: 'HR <hr@acme.com>',
        date: acc === 'ma-a' ? '2026-11-10T10:00:00Z' : '2026-11-11T10:00:00Z', folder: url.searchParams.get('folder') || 'INBOX', unread: acc === 'ma-b' }], total: 1 } });
    });
    const folderCalls = [];
    await page.route('**/api/dashboard/mail/*/folders', r => {
      const acc = r.request().url().includes('/ma-a/') ? 'a' : 'b';
      folderCalls.push(acc);
      r.fulfill({ json: { folders: [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: null, noselect: false },
        { path: `Archive-${acc}`, name: `Archive-${acc}`, delimiter: '/', noselect: false },
        { path: `Archive-${acc}/2025`, name: '2025', delimiter: '/', noselect: false },
        { path: '[Gmail]', name: '[Gmail]', delimiter: '/', noselect: true },
      ] } });
    });
    let mailUrl = '';
    await page.route('**/api/dashboard/mail/ma-a/message/**', r => {
      mailUrl = r.request().url();
      r.fulfill({ json: { id: '11', subject: 'ACME from ma-a', from: 'hr@acme.com', to: 'me@x', date: '2026-11-10T10:00:00Z', text: 'Hello', attachments: [] } });
    });

    await page.keyboard.press('Control+f');
    await expect(page.locator('#searchOverview [data-mode="mail"]')).toBeVisible();
    await expect(page.locator('#searchOverview [data-mode="events"]')).toBeHidden();   // no calendar accounts
    await page.click('#searchOverview [data-mode="mail"]');
    await expect(page.locator('#searchToggleEvents')).toBeHidden();
    await expect(page.locator('#searchAccountFilters')).toBeVisible();
    await expect(page.locator('#searchRangeFilters')).toBeVisible();
    // Filters wrapping into two rows sit as close as the text field and the first row
    const gaps = await page.evaluate(() => {
      const r = id => document.getElementById(id).closest('.search-filter-group, .modal-field').getBoundingClientRect();
      return [Math.round(r('searchAccount').top - r('searchText').bottom), Math.round(r('searchFrom').top - r('searchAccount').bottom)];
    });
    expect(gaps[1]).toBeGreaterThan(0);
    expect(Math.abs(gaps[1] - gaps[0])).toBeLessThanOrEqual(2);
    // All accounts: the folder filter waits for an account
    await expect(page.locator('#searchAccount option')).toHaveText(['All accounts', 'Work', 'Home']);
    await expect(page.locator('#searchMailFolder')).toBeDisabled();

    await page.fill('#searchText', 'acme');
    await expect.poll(() => calls.length).toBe(2);
    expect(calls.sort()).toEqual(['q=acme&account=ma-a', 'q=acme&account=ma-b']);
    const results = page.locator('#searchResults .search-result-item');
    await expect(results).toHaveCount(2);
    await expect(results.first()).toContainText('ACME from ma-b');   // newest first
    await expect(results.first()).toHaveClass(/search-result--unread/);
    await expect(results.first()).toContainText('Home / INBOX');
    expect(folderCalls).toEqual([]);   // folders load only for a chosen account

    // One account: its folders (selectable ones, nested indented)
    calls.length = 0;
    await page.selectOption('#searchAccount', 'ma-a');
    await expect.poll(() => calls.at(-1)).toBe('q=acme&account=ma-a');
    await expect(results).toHaveCount(1);
    const sel = page.locator('#searchMailFolder');
    await expect(sel).toBeEnabled();
    await expect(sel.locator('option')).toHaveCount(4);
    expect(await sel.locator('option[value="[Gmail]"]').count()).toBe(0);
    expect(folderCalls).toEqual(['a']);

    await sel.selectOption('Archive-a/2025');
    await page.check('#searchMailFull');
    await page.fill('#searchFrom', '2026-01-01');
    await expect.poll(() => calls.at(-1)).toBe('q=acme&full=1&from=2026-01-01&account=ma-a&folder=Archive-a%2F2025');
    await expect(results).toHaveCount(1);
    // "From" after "To": no search
    const n = calls.length;
    await page.fill('#searchTo', '2025-12-31');
    await expect(page.locator('#searchResults')).toContainText('"From" is after "To"');
    expect(calls.length).toBe(n);
    await page.fill('#searchTo', '');
    await expect(results).toHaveCount(1);

    await results.first().click();
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    await expect(page.locator('#dashboardDetail')).toBeVisible();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('ACME from ma-a');
    expect(new URL(mailUrl).searchParams.get('folder')).toBe('Archive-a/2025');
  });

  // E-S-10 -----------------------------------------------------------------
  test('E-S-10: a single mail / calendar account is selected directly; its folders can be picked', async ({ page }) => {
    const calls = [];
    await page.route('**/api/today/search**', r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/api/today/search')) {
        return r.fulfill({ json: { types: ['cards', 'notes', 'events', 'mail'],
          mailAccounts: [{ id: 'ma-only', label: 'Work' }], calendarAccounts: [{ id: 'ca-only', label: 'Team' }] } });
      }
      calls.push(`${url.pathname.split('/').pop()}?${url.searchParams}`);
      return r.fulfill({ json: { items: [], total: 0 } });
    });
    await page.route('**/api/dashboard/mail/ma-only/folders', r => r.fulfill({ json: { folders: [
      { path: 'INBOX', name: 'INBOX', delimiter: '/' }, { path: 'Archive', name: 'Archive', delimiter: '/' }] } }));

    await openFind(page, 'mail');
    const acc = page.locator('#searchAccount'), folder = page.locator('#searchMailFolder');
    await expect(acc).toBeEnabled();
    await expect(acc.locator('option')).toHaveText(['Work']);
    await expect(acc).toHaveValue('ma-only');
    await expect(folder).toBeEnabled();
    await expect(folder.locator('option')).toHaveText(['All folders', 'INBOX', 'Archive']);
    await folder.selectOption('Archive');
    await page.fill('#searchText', 'acme');
    await expect.poll(() => calls.at(-1)).toBe('mail?q=acme&account=ma-only&folder=Archive');

    await page.click('#searchToggleEvents');
    await expect(acc).toBeEnabled();
    await expect(acc.locator('option')).toHaveText(['Team']);
    await expect.poll(() => calls.at(-1)).toBe('events?q=acme&full=1&account=ca-only');
  });

  // E-S-9 ------------------------------------------------------------------
  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('E-S-9: filters below the text field take at most two rows; the column list opens as a popup', async ({ page }) => {
      await page.route('**/api/today/search**', r => r.fulfill({ json: { types: ['cards', 'notes', 'events', 'mail'],
        mailAccounts: [{ id: 'ma-a', label: 'Work' }, { id: 'ma-b', label: 'Home' }], calendarAccounts: [{ id: 'ca-1', label: 'Team' }, { id: 'ca-2', label: 'Private' }] } }));
      await page.goto(BOARD_URL);
      await expect(page.locator('.column')).toHaveCount(2, { timeout: 10_000 });
      await page.click('#headerMenuBtn');
      await page.click('#menuFindCard');
      await page.click('#searchOverview [data-mode="cards"]');
      // Rows = distinct bottoms of the visible filter controls (rows align at the bottom); none sticks out of the dialog
      const rows = sel => page.evaluate(sel => {
        const els = [...document.querySelectorAll(sel)].filter(e => e.offsetParent && e.getBoundingClientRect().width);
        const modal = document.querySelector('#searchBackdrop .search-modal').getBoundingClientRect();
        return { rows: new Set(els.map(e => Math.round(e.getBoundingClientRect().bottom / 6))).size,
          inside: els.every(e => e.getBoundingClientRect().right <= modal.right + 1) };
      }, sel);
      const controls = '#searchMain :is(#searchCardFilters, #searchAccountFilters) :is(select, input[type="date"], .search-check-label, .priority-row, .search-col-btn)';
      expect(await rows(controls)).toEqual({ rows: 2, inside: true });
      await expect(page.locator('#searchColumnList')).toBeHidden();
      await page.click('#searchColBtn');
      await expect(page.locator('#searchColumnList')).toBeVisible();
      await page.locator('#searchColumnList label').filter({ hasText: 'Beta' }).locator('input').uncheck();
      await expect(page.locator('#searchColBtn')).toHaveText('1 of 2');
      await page.click('#searchText');
      await expect(page.locator('#searchColumnList')).toBeHidden();

      for (const mode of ['events', 'mail']) {
        await page.click(`#searchToggle${mode === 'mail' ? 'Mail' : 'Events'}`);
        expect(await rows(controls), mode).toEqual({ rows: 2, inside: true });
      }
    });
  });
});
