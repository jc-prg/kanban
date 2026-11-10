'use strict';
/**
 * E2E — Today page (/today)
 *
 * All data endpoints are mocked with page.route (no CalDAV / IMAP / Open-Meteo / CV-App, and no
 * writes to the shared CouchDB — PUT /api/today/config is captured in the test).
 *
 * Scenarios: E-T-1 … E-T-12
 */
const { test, expect } = require('@playwright/test');
const path = require('path');

const AUTH_STATE = path.join(__dirname, '.auth-state.json');
test.use({ storageState: AUTH_STATE });

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const TODAY = ymd(now);
const at = (h, m = 0) => { const d = new Date(now); d.setHours(h, m, 0, 0); return d.toISOString(); };

const LAYOUTS = {
  lg: {
    columns: [{ width: 2 }, { width: 1 }],
    tiles: [
      { id: 'agenda',    col: 0, order: 0, size: '1/1' },
      { id: 'attention', col: 1, order: 0, size: 'container' },
      { id: 'cvapp',     col: 1, order: 1, size: '1/3' },
      { id: 'progress',  col: 1, order: 2, size: 'container' },
    ],
  },
};

const item = (id, text, extra = {}) => ({ board: 'e2e-today', column: 'TODO', card: { id, text, description: false, link: '', unread: false, ...extra } });

async function mockApis(page, state) {
  await page.route('**/api/today/config', async r => {
    if (r.request().method() === 'PUT') {
      state.put = JSON.parse(r.request().postData());
      state.layouts = { ...state.layouts, ...state.put.layouts };
      return r.fulfill({ json: { ok: true, config: { showBar: true, widgets: {}, layouts: state.layouts } } });
    }
    return r.fulfill({ json: { showBar: true, widgets: { cvapp: { apiUrl: 'http://cv', publicUrl: 'https://cv.example/', hasApiKey: true } }, layouts: state.layouts } });
  });
  await page.route('**/api/today/widgets/cards?**', r => r.fulfill({ json: {
    date: TODAY,
    overdue: [item('id-od1', 'Overdue report', { endDate: '2020-01-01' })],
    dueToday: [item('id-due1', 'Send offer', { endDate: TODAY, priority: 1 })],
    startsToday: [], dueTomorrow: [], unread: [],
    dueWeek: [item('id-soon1', 'Prepare slides', { endDate: ymd(new Date(now.getTime() + 86400000)) }),
              item('id-later', 'Later task', { endDate: ymd(new Date(now.getTime() + 5 * 86400000)) })],
    startsWeek: [],
    counts: { overdue: 1, dueToday: 1, startsToday: 0, dueTomorrow: 0, unread: 0 },
  } }));
  await page.route('**/api/today/widgets/weather', r => r.fulfill({ status: 400, json: { error: 'No weather location configured' } }));
  await page.route('**/api/today/widgets/cvapp', r => r.fulfill({ json: {
    total: 1, appUrl: 'https://cv.example/', statuses: [{ status: 'Versendet', count: 1 }],
    active: [{ id: 'a1', title: 'Engineering Manager', company: 'ACME', status: 'Versendet', statusNote: 'waiting for feedback', progress: '', appliedAt: TODAY, fitScore: 3, url: 'https://cv.example/#/applications?id=a1' }],
    recent: [{ id: 'a2', title: 'Old role', company: 'Foo', status: 'Absage', statusNote: '', progress: '', fitScore: null, url: 'https://cv.example/#/applications?id=a2' }],
  } }));
  await page.route('**/api/dashboard/config', r => r.fulfill({ json: { calendarAccounts: [{ id: 'ca-e2e', label: 'Work', type: 'caldav', color: '#7c6af7' }], mailAccounts: [], cardSources: [], autoRefreshMs: 0 } }));
  await page.route('**/api/dashboard/mail-recent-folders', r => r.fulfill({ json: {} }));
  await page.route('**/api/dashboard/mail', r => r.fulfill({ json: [] }));
  await page.route('**/api/dashboard/calendar/ca-e2e?**', r => r.fulfill({ json: { type: 'caldav', events: [
    { uid: 'ev1', title: 'Planning meeting', start: at(9), end: at(10) },
  ] } }));
  await page.route('**/api/achievements/today?**', r => r.fulfill({ json: { done: 2, moved: 3, created: 1, inboxCreated: 0 } }));
}

// Board (and its notes) edited in place from Today: GETs served from `data`, writes captured in `state`
async function mockBoard(page, name, data, state) {
  state.patches ||= {}; state.notesWrites ||= {};
  await page.route(`**/api/${name}/board`, r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: data.board, headers: { ETag: '"1-a"' } });
    (state.patches[name] ||= []).push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: { ok: true }, headers: { ETag: '"2-b"' } });
  });
  await page.route(`**/api/${name}/notes`, r => {
    if (r.request().method() === 'GET') return r.fulfill({ json: data.notes || { schemaVersion: 2, items: [] }, headers: { ETag: '"1-n"' } });
    (state.notesWrites[name] ||= []).push({ method: r.request().method(), body: r.request().postData() });
    return r.fulfill({ json: { ok: true }, headers: { ETag: '"2-n"' } });
  });
  for (const sub of ['webdav-config', 'webhook-config']) await page.route(`**/api/${name}/${sub}`, r => r.fulfill({ json: { enabled: false } }));
  await page.route(`**/api/${name}/recurring-tasks`, r => r.fulfill({ json: [] }));
  await page.route(`**/api/${name}/cards/attachments**`, r => r.fulfill({ json: [] }));
  await page.route(`**/api/${name}/notes/attachments/**`, r => r.fulfill({ json: [] }));
}

const BOARD_TODAY = { board: { columns: [{ id: 'c-todo', title: 'TODO', cards: [{ id: 'id-due1', text: 'Send offer', endDate: TODAY, priority: 1 }] }] } };

const columnsOf = page => page.evaluate(() =>
  [...document.querySelectorAll('#todayGrid .today-col')].map(c => [...c.querySelectorAll('.today-tile')].map(t => `${t.dataset.tile}:${t.dataset.size}`)));

test.describe('Today page', () => {
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1300, height: 900 }); });

  test('E-T-1 renders the layout; agenda and attention items open the detail panel', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await page.goto('/today');
    await expect(page.locator('.today-tile[data-tile="agenda"] .today-ev-row')).toContainText('Planning meeting');
    expect(await columnsOf(page)).toEqual([
      ['agenda:1/1'],
      ['attention:container', 'cvapp:1/3', 'progress:container'],
    ]);
    // Due card in the agenda
    await expect(page.locator('.today-tile[data-tile="agenda"] .today-kcard', { hasText: 'Send offer' })).toBeVisible();

    // Attention order; "due soon" = next 2 days only (the card due in 5 days is not listed)
    expect(await page.locator('details.today-att').evaluateAll(els => els.map(e => e.dataset.key))).toEqual(['overdue', 'due', 'soon']);
    const soon = page.locator('details.today-att[data-key="soon"]');
    await expect(soon.locator('.today-att-count')).toHaveText('1');
    await soon.locator('summary').click();
    await expect(soon.locator('.today-kcard .card-text')).toHaveText('Prepare slides');

    // Attention: expand "overdue" and open the card
    const overdue = page.locator('details.today-att[data-key="overdue"]');
    await expect(overdue.locator('summary')).toContainText('1');
    await overdue.locator('summary').click();
    await expect(overdue.locator('.today-kcard .card-date--overdue')).toBeVisible();
    await expect(overdue.locator('.today-kcard .dashboard-recent-context')).toHaveText('e2e-today · TODO');
    await overdue.locator('.today-kcard .card-text').click();
    await expect(page.locator('#dashboardDetail')).toBeVisible();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Overdue report');
    await page.click('#dashboardDetailClose');

    // Done circle on a kanban-style card marks it done (PATCH of the board)
    await page.route('**/api/e2e-today/board', r => r.request().method() === 'GET'
      ? r.fulfill({ json: { columns: [{ id: 'c', title: 'TODO', cards: [{ id: 'id-od1', text: 'Overdue report', endDate: '2020-01-01' }] }] } })
      : (state.patched = JSON.parse(r.request().postData()), r.fulfill({ json: { ok: true } })));
    await overdue.locator('.today-kcard [data-act="done"]').click();
    await expect.poll(() => state.patched?.updatedColumns?.[0]?.cards?.[0]?.done).toBe(true);

    // Applications: active list by default, status details behind (i), "Recent" toggles the list
    const cv = page.locator('.today-tile[data-tile="cvapp"]');
    await expect(cv.locator('.today-app-row')).toContainText('Engineering Manager');
    await expect(cv.locator('.today-cv-sent')).toBeVisible();
    await expect(cv.locator('.today-app-info')).toBeHidden();
    await cv.locator('.today-info-btn').click();
    await expect(cv.locator('.today-app-info')).toContainText('waiting for feedback');
    await cv.locator('.today-tile-btn--text').click();
    await expect(cv.locator('.today-app-row')).toContainText('Old role');
    await cv.locator('.today-tile-btn--text').click();

    // Unconfigured weather does not break the page (bar without weather)
    await expect(page.locator('#todayBar')).toContainText('CW');
  });

  test('E-T-2 edit mode: move a tile to another column, resize it, save and reload', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(LAYOUTS)) };
    await mockApis(page, state);
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();

    await page.click('#todayEditBtn');
    await expect(page.locator('#todayEditBar')).toContainText('Large');
    await page.selectOption('.today-tile[data-tile="agenda"] .today-tile-size', '2/3');

    const handle = page.locator('.today-tile[data-tile="cvapp"] .today-tile-handle');
    const agenda = page.locator('.today-tile[data-tile="agenda"]');
    const hb = await handle.boundingBox();
    const ab = await agenda.boundingBox();
    await page.mouse.move(hb.x + 4, hb.y + 4);
    await page.mouse.down();
    await page.mouse.move(ab.x + 80, ab.y + ab.height - 10, { steps: 6 });
    await page.mouse.up();
    expect((await columnsOf(page))[0]).toEqual(['agenda:2/3', 'cvapp:1/3']);

    await page.click('[data-edit="save"]');
    await expect(page.locator('#todayEditBar')).toBeHidden();
    expect(state.put.layouts.lg.tiles.find(t => t.id === 'cvapp')).toMatchObject({ col: 0, size: '1/3' });

    await page.reload();
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();
    expect(await columnsOf(page)).toEqual([
      ['agenda:2/3', 'cvapp:1/3'],
      ['attention:container', 'progress:container'],
    ]);
  });

  test('E-T-6 edit mode follows the screen size: each size keeps its draft, Save writes all changed ones', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(LAYOUTS)) };
    await mockApis(page, state);
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();

    await page.click('#todayEditBtn');
    await expect(page.locator('.today-edit-badge')).toContainText('Large');
    await page.selectOption('.today-tile[data-tile="cvapp"] .today-tile-size', '1/2');

    // Wider window → the extra-large layout (derived from lg) is edited now
    await page.setViewportSize({ width: 1700, height: 900 });
    await expect(page.locator('select.today-edit-bp')).toHaveValue('xl');
    await expect(page.locator('.today-edit-status')).toHaveText('derived from lg');
    await expect(page.locator('.today-edit-pending')).toHaveText('also changed: lg');
    await page.selectOption('.today-tile[data-tile="attention"] .today-tile-size', '1/3');

    // Back → the lg draft is still there
    await page.setViewportSize({ width: 1300, height: 900 });
    await expect(page.locator('.today-edit-badge')).toContainText('Large');
    await expect(page.locator('.today-edit-pending')).toHaveText('also changed: xl');
    expect((await columnsOf(page))[1]).toContain('cvapp:1/2');

    await page.click('[data-edit="save"]');
    await expect(page.locator('#todayEditBar')).toBeHidden();
    expect(Object.keys(state.put.layouts).sort()).toEqual(['lg', 'xl']);
    expect(state.put.layouts.lg.tiles.find(t => t.id === 'cvapp').size).toBe('1/2');
    expect(state.put.layouts.xl.tiles.find(t => t.id === 'attention').size).toBe('1/3');
  });

  test('E-T-7 extra-large screen: the size drop-down previews and edits smaller sizes', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(LAYOUTS)) };
    await mockApis(page, state);
    await page.setViewportSize({ width: 1700, height: 900 });
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();

    await page.click('#todayEditBtn');
    await expect(page.locator('select.today-edit-bp')).toHaveValue('xl');

    // Small (phone): grid narrowed to the phone width, one column
    await page.selectOption('select.today-edit-bp', 'sm');
    await expect(page.locator('#today')).toHaveClass(/today--preview/);
    await expect.poll(async () => (await columnsOf(page)).length).toBe(1);
    expect((await page.locator('#todayGrid').boundingBox()).width).toBeLessThanOrEqual(400);
    await page.selectOption('.today-tile[data-tile="progress"] .today-tile-size', '1/3');

    // Large: two columns at 1400 px; the phone change is listed
    await page.selectOption('select.today-edit-bp', 'lg');
    await expect.poll(async () => (await columnsOf(page)).length).toBe(2);
    await expect(page.locator('select.today-edit-bp option[value="sm"]')).toContainText('changed');

    await page.click('[data-edit="save"]');
    await expect(page.locator('#todayEditBar')).toBeHidden();
    await expect(page.locator('#today')).not.toHaveClass(/today--preview/);
    expect(state.put.layouts.sm.tiles.find(t => t.id === 'progress').size).toBe('1/3');
    expect(state.put.layouts.sm.columns).toHaveLength(1);
  });

  test('E-T-3 smaller viewport: the layout is derived and reflows to one column', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();
    await page.setViewportSize({ width: 600, height: 900 });
    await expect.poll(async () => (await columnsOf(page)).length).toBe(1);
    // Tall fractions become "fit content" on one column; small ones stay
    expect((await columnsOf(page))[0]).toEqual(['agenda:container', 'attention:container', 'cvapp:1/3', 'progress:container']);
  });

  test('E-T-5 mail actions in "Needs attention": mark as read and delete update the list at once', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    const mails = [
      { id: '11', subject: 'First unread', from: 'a@example.org', date: at(8), unread: true },
      { id: '12', subject: 'Second unread', from: 'b@example.org', date: at(7), unread: true },
    ];
    let mailGets = 0;
    await page.route('**/api/dashboard/mail', r => { mailGets++; r.fulfill({ json: [{ accountId: 'ma-e2e', label: 'Mail', messages: mails.filter(m => m.unread && !m.gone) }] }); });
    await page.route('**/api/dashboard/mail/ma-e2e/message/*', r => {
      const id = r.request().url().split('/').pop().split('?')[0];
      const m = mails.find(x => x.id === id);
      if (r.request().method() === 'PATCH') m.unread = false;
      if (r.request().method() === 'DELETE') m.gone = true;
      r.fulfill({ json: { ok: true } });
    });
    await page.goto('/today');
    const mail = page.locator('details.today-att[data-key="mail"]');
    await expect(mail.locator('.today-att-count')).toHaveText('2');
    await mail.locator('summary').click();

    // Mark as read via the context menu
    await mail.locator('.today-mail-row', { hasText: 'First unread' }).click({ button: 'right' });
    await page.click('#mailCtxToggleRead');
    await expect(mail.locator('.today-mail-row', { hasText: 'First unread' })).toHaveCount(0);
    await expect(mail.locator('.today-att-count')).toHaveText('1');

    // Delete via the context menu: the last unread mail goes, so does the row
    await mail.locator('.today-mail-row', { hasText: 'Second unread' }).click({ button: 'right' });
    await page.click('#mailCtxDelete');
    await page.click('#dialogOkBtn');   // "Move this message to trash?"
    await expect(page.locator('details.today-att[data-key="mail"]')).toHaveCount(0);
    await expect.poll(() => mailGets).toBeGreaterThan(1);   // reloaded from the server afterwards
  });

  test('E-T-4 calendar view opens over Today; back returns to Today', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();
    await page.click('#dashboardCalBtn');
    await expect(page.locator('#calView')).toBeVisible();
    await expect(page.locator('#today')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('cal')).toBeTruthy();
    await page.goBack();
    await expect(page.locator('#today')).toBeVisible();
    await expect(page.locator('#calView')).toBeHidden();
  });

  test('E-T-8 card "Edit" from the context menu opens the dialog on Today; Save patches that board', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-kcard', { hasText: 'Send offer' }).click({ button: 'right' });
    await page.click('#ctxEdit');

    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Send offer');
    expect(new URL(page.url()).pathname).toBe('/today');
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.locator('#board .column')).toHaveCount(0);   // the board is not rendered
    await expect(page.locator('#modalGoBoardBtn')).toBeVisible();
    await expect(page.locator('#modalGoBoardBtn')).toHaveAttribute('href', '/board/e2e-today#card:id-due1');

    await page.fill('#cardText', 'Send offer (v2)');
    await page.click('#modalSubmitBtn');
    await expect(page.locator('#modal')).toBeHidden();
    await expect.poll(() => state.patches['e2e-today']?.at(-1)?.updatedColumns?.[0]?.cards?.[0]?.text).toBe('Send offer (v2)');
    expect(new URL(page.url()).pathname).toBe('/today');
  });

  test('E-T-9 detail panel "Edit" opens the dialog in place; "Go to board" asks about changes, then opens the board', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-kcard', { hasText: 'Send offer' }).click();
    await expect(page.locator('#dashboardDetail')).toBeVisible();
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#dashboardDetail')).toBeHidden();
    await expect(page.locator('#modal')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/today');

    // Unsaved change: Go to board asks first; cancelling keeps the dialog on Today
    await page.fill('#cardText', 'Changed');
    await page.click('#modalGoBoardBtn');
    await expect(page.locator('#dialogBackdrop')).toBeVisible();
    await page.click('#dialogCancelBtn');
    await expect(page.locator('#modal')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/today');

    // Discard → the board opens with the same card dialog
    await page.click('#modalGoBoardBtn');
    await page.click('#dialogOkBtn');
    await expect(page).toHaveURL(/\/board\/e2e-today#card:id-due1$/);
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Send offer');
    expect(state.patches['e2e-today'] || []).toEqual([]);   // nothing was saved
  });

  test('E-T-10 cards of two boards edited one after the other are saved to their own board', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await page.route('**/api/today/widgets/cards?**', r => r.fulfill({ json: {
      date: TODAY, overdue: [], startsToday: [], dueTomorrow: [], unread: [], dueWeek: [], startsWeek: [],
      dueToday: [item('id-due1', 'Send offer', { endDate: TODAY }), { ...item('id-oth1', 'Call Bob', { endDate: TODAY }), board: 'e2e-other' }],
      counts: { overdue: 0, dueToday: 2, startsToday: 0, dueTomorrow: 0, unread: 0 },
    } }));
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await mockBoard(page, 'e2e-other', { board: { columns: [{ id: 'c-x', title: 'DOING', cards: [{ id: 'id-oth1', text: 'Call Bob', endDate: TODAY }] }] } }, state);
    await page.goto('/today');
    const agenda = page.locator('.today-tile[data-tile="agenda"]');

    await agenda.locator('.today-kcard', { hasText: 'Send offer' }).click({ button: 'right' });
    await page.click('#ctxEdit');
    await page.fill('#cardText', 'Send offer A');
    await page.click('#modalSubmitBtn');
    await expect(page.locator('#modal')).toBeHidden();

    await agenda.locator('.today-kcard', { hasText: 'Call Bob' }).click({ button: 'right' });
    await page.click('#ctxEdit');
    await expect(page.locator('#cardText')).toHaveValue('Call Bob');
    await expect(page.locator('#modalGoBoardBtn')).toHaveAttribute('href', '/board/e2e-other#card:id-oth1');
    await page.fill('#cardText', 'Call Bob B');
    await page.click('#modalSubmitBtn');

    await expect.poll(() => state.patches['e2e-other']?.at(-1)?.updatedColumns?.[0]?.cards?.[0]?.text).toBe('Call Bob B');
    expect(state.patches['e2e-today'].at(-1).updatedColumns[0].cards[0].text).toBe('Send offer A');
    expect(JSON.stringify(state.patches['e2e-today'])).not.toContain('Call Bob');
  });

  test('E-T-11 a note page in the Notes tile opens the note dialog on Today; Save writes that board\'s notes', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'notes', col: 0, order: 0, size: '1/1' }] } } };
    await mockApis(page, state);
    await page.route('**/api/today/widgets/notes', r => r.fulfill({ json: {
      total: 1, boards: [{ board: 'e2e-today', pages: 1, webdav: false, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes' }] }],
    } }));
    await mockBoard(page, 'e2e-today', { ...BOARD_TODAY, notes: { schemaVersion: 2, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes', description: 'hello' }] } }, state);
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="notes"]');
    await tile.locator('.today-nboard > summary').click();
    await tile.locator('.today-npage', { hasText: 'Meeting notes' }).click();

    await expect(page.locator('#noteModal')).toBeVisible();
    await expect(page.locator('#notePageTitle')).toHaveValue('Meeting notes');
    expect(new URL(page.url()).pathname).toBe('/today');
    expect(new URL(page.url()).hash).toBe('');
    await expect(page.locator('#noteModalGoBoardBtn')).toBeVisible();
    await expect(page.locator('#notesSidebar')).not.toHaveClass(/notes-sidebar--open/);

    await page.fill('#notePageTitle', 'Meeting notes (edited)');
    await page.click('#noteModalSaveBtn');
    await expect(page.locator('#noteModal')).toBeHidden();
    await expect.poll(() => (state.notesWrites['e2e-today'] || []).map(w => w.body).join('')).toContain('Meeting notes (edited)');
  });

  test('E-T-12 Find on Today searches all boards; a result opens the card dialog in place', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await page.route('**/api/boards', r => r.fulfill({ json: [{ name: 'e2e-today', columnBadges: [] }] }));
    await page.route('**/api/e2e-today/all-columns', r => r.fulfill({ json: { TODO: [{ id: 'id-due1', text: 'Send offer' }] } }));
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();
    await page.click('#headerMenuBtn');
    await page.click('#menuFindCard');
    await page.fill('#searchText', 'send off');
    const hit = page.locator('#searchResults .search-result-item', { hasText: 'Send offer' });
    await expect(hit).toContainText('e2e-today › TODO');
    await hit.click();
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Send offer');
    expect(new URL(page.url()).pathname).toBe('/today');
  });
  test('E-T-13 Quick access: shown entries + "Show more"; settings form adds a link (emoji) and saves it', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [
      { id: 'agenda', col: 0, order: 0, size: '1/1' }, { id: 'quickaccess', col: 1, order: 0, size: 'container' },
    ] } } };
    await mockApis(page, state);
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    let quickaccess = { visible: 2, size: 'm', items: [
      { id: 'qa-1', url: 'https://one.example/', title: 'One', icon: { type: 'image', file: 'qa-0123456789abcdef.png' } },
      { id: 'qa-2', url: 'https://two.example/', title: 'Two', icon: { type: 'emoji', value: '📈' } },
      { id: 'qa-3', url: 'https://three.example/', icon: { type: 'image', file: 'qa-fedcba9876543210.png' } },   // missing file
    ] };
    const cfg = () => ({ showBar: true, refreshMinutes: 0, widgets: { quickaccess }, layouts: state.layouts });
    // One handler for GET + PUT (registered last → runs before mockApis' handler)
    await page.route('**/api/today/config', async r => {
      if (r.request().method() === 'PUT') {
        state.put = JSON.parse(r.request().postData());
        quickaccess = state.put.widgets?.quickaccess || quickaccess;
        return r.fulfill({ json: { ok: true, config: cfg() } });
      }
      return r.fulfill({ json: cfg() });
    });
    await page.route('**/api/today/quickaccess/icon/*', r => r.request().url().includes('0123456789abcdef')
      ? r.fulfill({ body: PNG, contentType: 'image/png' })
      : r.fulfill({ status: 404, json: { error: 'Icon not found' } }));
    await page.goto('/today');

    const tile = page.locator('.today-tile[data-tile="quickaccess"]');
    await expect(tile.locator('.today-qa-item:visible')).toHaveCount(2);
    await expect(tile.locator('[data-qa="qa-1"]')).toHaveAttribute('href', 'https://one.example/');
    await expect(tile.locator('[data-qa="qa-1"]')).toHaveAttribute('target', '_blank');
    await expect(tile.locator('[data-qa="qa-2"] .today-qa-emoji')).toHaveText('📈');
    await tile.locator('.today-qa-toggle').click();
    await expect(tile.locator('.today-qa-item:visible')).toHaveCount(3);
    await expect(tile.locator('[data-qa="qa-3"] .today-qa-title')).toHaveText('three.example');   // host as title
    await expect(tile.locator('[data-qa="qa-3"] .today-qa-letter')).toHaveText('T');              // broken icon → letter
    await expect(tile.locator('.today-qa-toggle')).toHaveText('Show less');

    // Gear action → Settings → Dashboard with the Quick access row expanded
    await tile.locator('.today-tile-btn').click();
    const row = page.locator('.today-wrow[data-widget="quickaccess"]');
    await expect(row).toHaveClass(/today-wrow--open/);
    await expect(row.locator('.today-qa-row')).toHaveCount(3);
    await page.click('#todayQaAddBtn');
    await page.fill('#todayQaUrl', 'https://nas.example:5000/');
    await page.fill('#todayQaTitle', 'NAS');
    await page.check('input[name="todayQaIconType"][value="emoji"]');
    await page.click('#todayQaEmojiBtn');
    await page.locator('#todayQaEmojiPop [data-mv-emoji]').first().click();
    await page.click('#todayQaSaveBtn');
    await expect(page.locator('#todayQaForm')).toBeHidden();
    const added = state.put.widgets.quickaccess.items.at(-1);
    expect(added).toMatchObject({ url: 'https://nas.example:5000/', title: 'NAS', icon: { type: 'emoji' } });
    expect(added.id).toMatch(/^qa-[a-z0-9]+$/);
    expect(state.put.widgets.quickaccess).toMatchObject({ visible: 2, size: 'm' });
    await expect(row.locator('.today-qa-row')).toHaveCount(4);
  });
});
