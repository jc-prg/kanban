'use strict';
/**
 * E2E — Today page (/today)
 *
 * All data endpoints are mocked with page.route (no CalDAV / IMAP / Open-Meteo / CV-App, and no
 * writes to the shared CouchDB — PUT /api/today/config is captured in the test).
 *
 * Scenarios: E-T-1 … E-T-18
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
      if (state.put.widgets) state.widgets = state.put.widgets;
      return r.fulfill({ json: { ok: true, config: { showBar: true, widgets: state.widgets || {}, layouts: state.layouts } } });
    }
    return r.fulfill({ json: { showBar: true, widgets: state.widgets || { cvapp: { apiUrl: 'http://cv', publicUrl: 'https://cv.example/', hasApiKey: true } }, layouts: state.layouts } });
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


// Stickies tile: /api/stickies served from `state.stickies`, writes captured in `state.stickyWrites`
const STICKIES = () => [
  { id: 's-000000000003', text: 'First idea', color: '#fde68a', category: 'note', created: '2026-11-12T09:00:00.000Z', updated: '2026-11-12T09:00:00.000Z' },
  { id: 's-000000000002', text: `${'A very long thought that goes on and on. '.repeat(12).trim()} Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterungsersatzteilbeschaffungsantragsformularausfüllhilfe`, color: '#93c5fd', category: 'other', created: '2026-11-11T09:00:00.000Z', updated: '2026-11-11T09:00:00.000Z' },
  { id: 's-000000000001', text: 'Simplicity is the ultimate sophistication', source: 'Leonardo da Vinci, https://en.wikipedia.org/wiki/Leonardo_da_Vinci_and_a_very_long_path', color: '#f9a8d4', category: 'quote', created: '2026-11-10T09:00:00.000Z', updated: '2026-11-10T09:00:00.000Z' },
];
const STICKY_LAYOUTS = {
  lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [
    { id: 'agenda',   col: 0, order: 0, size: '1/1' },
    { id: 'stickies', col: 1, order: 0, size: 'container' },
  ] },
  sm: { columns: [{ width: 1 }], tiles: [{ id: 'stickies', col: 0, order: 0, size: 'container' }] },
};

async function mockStickies(page, state) {
  state.stickies = STICKIES();
  state.stickyWrites = [];
  await page.route('**/api/stickies**', r => {
    const req = r.request(), method = req.method();
    if (method === 'GET') return r.fulfill({ json: { items: state.stickies, categories: ['note', 'quote', 'intervention', 'other'] } });
    const id = new URL(req.url()).pathname.split('/').pop();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    state.stickyWrites.push({ method, id, body });
    const ts = new Date().toISOString();
    if (method === 'POST') {
      const n = state.stickyWrites.filter(w => w.method === 'POST').length;
      const item = { id: n === 1 ? 's-0000000000ff' : `s-00000000a${n.toString(16).padStart(3, '0')}`, color: '#86efac', category: 'note', ...body, created: ts, updated: ts };
      state.stickies.unshift(item);
      return r.fulfill({ status: 201, json: { item } });
    }
    if (method === 'PUT') {
      const item = { ...state.stickies.find(x => x.id === id), ...body, updated: ts };
      state.stickies = state.stickies.map(x => (x.id === id ? item : x));
      return r.fulfill({ json: { item } });
    }
    state.stickies = state.stickies.filter(x => x.id !== id);
    return r.fulfill({ json: { ok: true } });
  });
}

const setSlider = (page, v) => page.locator('.today-stk-slider').evaluate((el, v) => {
  el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, v);

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
    await expect(page.locator('#todayBtn')).toBeHidden();
    await page.click('#dashboardCalBtn');
    await expect(page.locator('#calView')).toBeVisible();
    await expect(page.locator('#today')).toBeHidden();
    expect(new URL(page.url()).searchParams.get('cal')).toBeTruthy();
    // A view of its own: its icon gives way to the dashboard icon
    await expect(page.locator('#dashboardCalBtn')).toBeHidden();
    await expect(page.locator('#todayBtn')).toBeVisible();
    await expect(page.locator('#dashboardMailBtn')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#today')).toBeVisible();
    await expect(page.locator('#calView')).toBeHidden();
    await expect(page.locator('#todayBtn')).toBeHidden();
    await expect(page.locator('#dashboardCalBtn')).toBeVisible();

    // Mail view: mail icon hidden; the dashboard icon returns to Today
    await page.click('#dashboardMailBtn');
    await expect(page.locator('#mailView')).toBeVisible();
    await expect(page.locator('#dashboardMailBtn')).toBeHidden();
    await expect(page.locator('#dashboardCalBtn')).toBeVisible();
    await page.click('#todayBtn');
    await expect(page.locator('#today')).toBeVisible();
    await expect(page.locator('#mailView')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/today');
    await expect.poll(() => new URL(page.url()).searchParams.get('mail')).toBeNull();
    await expect(page.locator('#dashboardMailBtn')).toBeVisible();
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

  test('E-T-11 a note page in the Notes tile opens the note detail panel; Edit opens the note dialog on Today; Save writes that board\'s notes', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'notes', col: 0, order: 0, size: '1/1' }] } } };
    await mockApis(page, state);
    await page.route('**/api/today/widgets/notes', r => r.fulfill({ json: {
      total: 1, boards: [{ board: 'e2e-today', pages: 1, webdav: false, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes' }] }],
    } }));
    await mockBoard(page, 'e2e-today', { ...BOARD_TODAY, notes: { schemaVersion: 2, items: [{ type: 'folder', id: 'f-1', title: 'Team', children: [
      { type: 'page', id: 'n-abc1', title: 'Meeting notes', description: '## Agenda\n\nhello **world**\n\n' + Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n\n'), link: 'https://example.com/m', linkedCards: ['id-due1'],
        hasAttachments: true, lastModified: '2026-11-10T09:00:00Z' },
    ] }] } }, state);
    await page.route('**/api/e2e-today/notes/attachments/n-abc1', r => r.fulfill({ json: [{ name: 'minutes.pdf', size: 2048 }] }));
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="notes"]');
    await tile.locator('.today-nboard > summary').click();
    await tile.locator('.today-npage', { hasText: 'Meeting notes' }).click();

    // Detail panel: board / folder / link / linked card, Markdown body, attachments; no dialog yet
    const detail = page.locator('#dashboardDetail');
    await expect(detail).toBeVisible();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Meeting notes');
    await expect(detail.locator('.dashboard-detail-table')).toContainText('Team');
    await expect(detail.locator('.dashboard-detail-table a[href="https://example.com/m"]')).toBeVisible();
    await expect(detail.locator('.dash-linked-card')).toHaveText('Send offer · e2e-today / TODO');
    await expect(detail.locator('.dash-doc-preview h2')).toHaveText('Agenda');
    await expect(detail.locator('.dash-doc-preview strong')).toHaveText('world');
    await expect(detail.locator('.dash-card-attach-item')).toContainText('minutes.pdf');
    // Layout: table at the top, attachments at the bottom of the panel, only the text scrolls in between
    const box = await page.evaluate(() => {
      const r = sel => document.querySelector(`#dashboardDetail ${sel}`).getBoundingClientRect();
      const body = document.getElementById('dashboardDetailBody'), pv = document.querySelector('#dashboardDetail .dash-doc-preview');
      return { table: r('.dashboard-detail-table'), preview: r('.dash-doc-preview'), section: r('.dash-card-detail-section'), body: body.getBoundingClientRect(),
        bodyScrolls: body.scrollHeight > body.clientHeight, previewScrolls: pv.scrollHeight > pv.clientHeight };
    });
    expect(box.table.bottom).toBeLessThanOrEqual(box.preview.top);
    expect(box.preview.bottom).toBeLessThanOrEqual(box.section.top);
    expect(box.body.bottom - box.section.bottom).toBeLessThan(20);
    expect(box.bodyScrolls).toBe(false);
    expect(box.previewScrolls).toBe(true);
    await expect(page.locator('#noteModal')).toBeHidden();
    await expect(page.locator('#dashboardDetailEditBtn')).toHaveAttribute('href', '/board/e2e-today#note:n-abc1');

    await page.click('#dashboardDetailEditBtn');
    await expect(detail).toBeHidden();
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
    await page.click('#searchOverview [data-mode="cards"]');
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
  test('E-T-14 edit mode: a removed widget is added back via "Add widget" at the end of a column', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(LAYOUTS)) };
    await mockApis(page, state);
    await page.goto('/today');
    await page.locator('.today-tile[data-tile="agenda"] .today-ev-row').waitFor();
    await page.click('#todayEditBtn');

    // Every active widget missing from this layout counts (weather, quickaccess, boards, notes, search, stickies)
    const addBtn = page.locator('[data-edit="add-tile"]');
    await expect(addBtn).toHaveText('+ Widget (6)');
    await page.locator('.today-tile[data-tile="progress"] .today-tile-hide').click();
    await expect(addBtn).toHaveText('+ Widget (7)');
    await expect(page.locator('#todayGrid .today-col-add')).toHaveCount(2);   // one per column
    // The add slot is the last element of each column
    expect(await page.locator('#todayGrid .today-col').evaluateAll(cols => cols.map(c => c.lastElementChild.className))).toEqual(['today-col-add', 'today-col-add']);

    await page.locator('#todayGrid .today-col[data-col="0"] .today-col-add').click();
    await page.locator('#_genericCtxMenu .ctx-item', { hasText: 'Achievements' }).click();
    expect((await columnsOf(page))[0]).toEqual(['agenda:1/1', 'progress:container']);
    await expect(page.locator('.today-tile[data-tile="progress"] .today-stat').first()).toBeVisible();   // data loaded
    await expect(addBtn).toHaveText('+ Widget (6)');

    await page.click('[data-edit="save"]');
    await expect(page.locator('#todayEditBar')).toBeHidden();
    await expect(page.locator('#todayGrid .today-col-add')).toHaveCount(0);
    expect(state.put.layouts.lg.tiles.find(t => t.id === 'progress')).toMatchObject({ col: 0, size: 'container' });
  });

  test('E-T-16 event detail: Edit in the header (series → occurrence / series menu), no footer, online meeting as link', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    const teams = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc';
    await page.route('**/api/dashboard/calendar/ca-e2e?**', r => r.fulfill({ json: { type: 'caldav', events: [
      { uid: 'ev1', title: 'Planning meeting', start: at(9), end: at(10), location: `Microsoft Teams Meeting ${teams}` },
      { uid: 'ev2', title: 'Weekly sync', start: at(11), end: at(12), location: 'Room 4', hasRrule: true, rruleStr: 'FREQ=WEEKLY' },
    ] } }));
    await page.goto('/today');
    const agenda = page.locator('.today-tile[data-tile="agenda"]');

    // Single event: Where = meeting link; Edit opens the event dialog directly
    await agenda.locator('.today-ev-row', { hasText: 'Planning meeting' }).click();
    const detail = page.locator('#dashboardDetail');
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Planning meeting');
    const where = detail.locator('.dashboard-detail-table tr', { hasText: 'Where' }).locator('a');
    await expect(where).toHaveText(/Teams/);
    await expect(where).toHaveAttribute('href', teams);
    await expect(page.locator('#dashboardDetailWebUrl')).toBeHidden();
    await expect(detail.locator('.dash-detail-footer')).toHaveCount(0);
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#calEventModal')).toBeVisible();
    await expect(page.locator('#calEventTitle')).toHaveValue('Planning meeting');
    await page.click('#calEventModalClose');
    await page.click('#dashboardDetailClose');

    // Series: Edit asks first — this occurrence or the entire series
    await agenda.locator('.today-ev-row', { hasText: 'Weekly sync' }).click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Weekly sync');
    await expect(detail.locator('.dashboard-detail-table tr', { hasText: 'Where' })).toContainText('Room 4');
    await expect(detail.locator('.dash-detail-footer')).toHaveCount(0);
    await page.click('#dashboardDetailEditBtn');
    const menu = page.locator('#_genericCtxMenu');
    await expect(menu.locator('.ctx-item')).toHaveText(['This occurrence', 'Entire series']);
    await menu.locator('.ctx-item', { hasText: 'Entire series' }).click();
    await expect(page.locator('#calEventModal')).toBeVisible();
    await expect(page.locator('#calEventTitle')).toHaveValue('Weekly sync');
  });

  test('E-T-17 event organiser "mailto:" writes a mail in the mail view (default mail program without a sending account)', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await page.route('**/api/dashboard/calendar/ca-e2e?**', r => r.fulfill({ json: { type: 'caldav', events: [
      { uid: 'ev1', title: 'Planning meeting', start: at(9), end: at(10), organizer: 'mailto:boss@example.org' },
    ] } }));
    let smtp = null;   // no sending account at first
    await page.route('**/api/dashboard/config', r => r.fulfill({ json: {
      calendarAccounts: [{ id: 'ca-e2e', label: 'Work', type: 'caldav', color: '#7c6af7' }],
      mailAccounts: smtp ? [{ id: 'ma-e2e', label: 'Mail', user: 'me@example.org', smtp }] : [],
    } }));
    await page.route('**/api/dashboard/mail/ma-e2e/**', r => r.fulfill({ json: { folders: [{ path: 'INBOX', name: 'INBOX', delimiter: '/' }], messages: [], total: 0, page: 1, pageSize: 50 } }));
    await page.goto('/today');
    const agenda = page.locator('.today-tile[data-tile="agenda"]');
    const organiser = page.locator('#dashboardDetail .dashboard-detail-table tr', { hasText: 'Organiser' }).locator('a');

    // Without a sending account: a plain mailto: link (the click hands it to the mail program)
    await agenda.locator('.today-ev-row', { hasText: 'Planning meeting' }).click();
    await expect(organiser).toHaveText('boss@example.org');
    await expect(organiser).toHaveAttribute('href', 'mailto:boss@example.org');
    const mailto = page.waitForRequest(req => req.url().startsWith('mailto:'), { timeout: 3000 }).catch(() => null);
    await organiser.click();
    await mailto;
    await expect(page.locator('#mailView')).toBeHidden();
    await page.click('#dashboardDetailClose');

    // With a sending account: the mail view opens a new message to the organiser
    smtp = { host: 'smtp.example.org', port: 587 };
    await agenda.locator('.today-ev-row', { hasText: 'Planning meeting' }).click();
    await organiser.click();
    await expect(page.locator('#mailView')).toBeVisible();
    await expect(page.locator('#dashboardDetail')).toBeHidden();
    await expect(page.locator('#mailViewReader input[name="to"]')).toHaveValue('boss@example.org');
  });

  test('E-T-18 Notes tile: "Open next level" opens one folder level per click; "Collapse all" starts over', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'notes', col: 0, order: 0, size: '1/1' }] } } };
    await mockApis(page, state);
    const page_ = (id, title) => ({ type: 'page', id, title });
    await page.route('**/api/today/widgets/notes', r => r.fulfill({ json: { total: 3, boards: [
      { board: 'b-one', pages: 2, webdav: false, items: [
        { type: 'folder', id: 'f1', title: 'Projects', children: [{ type: 'folder', id: 'f2', title: 'Archive', children: [page_('n-1', 'Old plan')] }] },
        page_('n-2', 'Ideas'),
      ] },
      { board: 'b-two', pages: 1, webdav: false, items: [page_('n-3', 'Todo list')] },
    ] } }));
    await page.addInitScript(() => localStorage.removeItem('today-notes-open'));
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="notes"]');
    const open = () => tile.locator('.today-ntree details[open] > summary .today-nlabel').allTextContents();
    await tile.locator('.today-ntree').waitFor();
    expect(await open()).toEqual([]);

    const next = tile.locator('.today-tile-btn[title="Open next level"]');
    await next.click();
    expect(await open()).toEqual(['b-one', 'b-two']);
    await next.click();
    expect(await open()).toEqual(['b-one', 'Projects', 'b-two']);
    await next.click();
    expect(await open()).toEqual(['b-one', 'Projects', 'Archive', 'b-two']);
    await next.click();   // nothing left to open
    expect(await open()).toEqual(['b-one', 'Projects', 'Archive', 'b-two']);

    await tile.locator('.today-tile-btn[title="Collapse all"]').click();
    expect(await open()).toEqual([]);
    await next.click();
    expect(await open()).toEqual(['b-one', 'b-two']);
  });

  test('E-T-19 Search tile: groups per source, include checkbox per category / All / None, full text, results open in place or a new tab', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'search', col: 0, order: 0, size: '1/1' }] } } };
    await mockApis(page, state);
    const calls = [];
    // One handler for the whole search API (the last registered handler wins — see memory notes)
    await page.route('**/api/today/search**', r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/api/today/search')) {
        return r.fulfill({ json: { types: ['cards', 'notes', 'events', 'mail', 'applications'], mailAccounts: [{ id: 'ma-e2e', label: 'Mail', color: '#0a0', webInterfaceUrl: null }] } });
      }
      const type = url.pathname.split('/').pop();
      calls.push(`${type}${url.searchParams.get('full') ? '+full' : ''}:${url.searchParams.get('q')}`);
      const json = {
        cards: { items: [item('id-s1', 'ACME | Backend Dev', { created: TODAY }), item('id-s2', 'ACME old task', { done: true }),
          { board: 'e2e-today', column: '⏰ Scheduled', card: { id: 'id-s3', text: 'ACME weekly report', description: false, link: '' } }], total: 3 },
        notes: url.searchParams.get('full') ? { items: [{ board: 'e2e-today', id: 'n-s1', title: 'ACME research', path: ['Jobs'] }], total: 1 } : { items: [], total: 0 },
        events: { items: [{ uid: 'ev-s1', title: 'Interview ACME', location: 'Köln', start: at(14), end: at(15), accountId: 'ca-e2e', label: 'Work', color: '#7c6af7', webUrl: '' }], total: 1 },
        mail: { items: [{ id: '42', subject: 'Offer from ACME', from: 'HR <hr@acme.com>', to: 'me@x', date: now.toISOString(), folder: 'Archive', unread: false }], total: 1 },
        applications: { items: [{ id: 'a9', title: 'Data Engineer', company: 'ACME', location: 'Berlin', status: 'Versendet', url: 'https://cv.example/#/applications?id=a9' }], total: 1 },
      }[type];
      return r.fulfill({ json });
    });
    await page.route('**/api/dashboard/calendar/ca-e2e/event/**', r => r.fulfill({ json: { uid: 'ev-s1', title: 'Interview ACME', location: 'Köln', start: at(14), end: at(15) } }));
    let mailUrl = '';
    await page.route('**/api/dashboard/mail/ma-e2e/message/**', r => {
      mailUrl = r.request().url();
      r.fulfill({ json: { id: '42', subject: 'Offer from ACME', from: 'hr@acme.com', to: 'me@x', date: now.toISOString(), text: 'Hello', attachments: [] } });
    });
    const SEARCH_BOARD = { settings: { scheduledColumnId: 'c-sched' }, columns: [
      { id: 'c-sched', title: '⏰ Scheduled', cards: [{ id: 'id-s3', text: 'ACME weekly report', scheduledFor: '2026-01-05', scheduledTarget: 'c-todo',
        recurrence: { type: 'weekly', interval: 1, daysOfWeek: [1] } }] },
      { id: 'c-todo', title: 'TODO', cards: [{ id: 'id-s1', text: 'ACME | Backend Dev', description: '## Role\n\n' + Array.from({ length: 60 }, (_, i) => `req ${i}`).join('\n\n') }, { id: 'id-s2', text: 'ACME old task', done: true }] },
    ] };
    await mockBoard(page, 'e2e-today', { board: SEARCH_BOARD, notes: { schemaVersion: 2, items: [{ type: 'folder', id: 'f-j', title: 'Jobs', children: [
      { type: 'page', id: 'n-s1', title: 'ACME research', description: 'Salary range' }] }] } }, state);
    await page.addInitScript(() => localStorage.removeItem('today-search'));
    await page.goto('/today');

    const tile  = page.locator('.today-tile[data-tile="search"]');
    const input = tile.locator('.today-search-input');
    // Every available category is listed (ticked) before anything is searched
    await expect(tile.locator('.today-search-group')).toHaveCount(5);
    await expect(tile.locator('.today-search-check:checked')).toHaveCount(5);
    await expect(tile.locator('.today-tile-title')).toHaveText('Find');
    // Searching starts at 3 characters
    await input.fill('ac');
    await page.waitForTimeout(600);   // > debounce
    expect(calls).toEqual([]);
    await input.fill('acme');
    await expect.poll(() => calls.length).toBe(5);
    await expect(tile.locator('.today-search-dots')).toHaveCount(0);   // no category still searching
    expect(await tile.locator('.today-search-group').evaluateAll(els => els.map(e => e.dataset.type))).toEqual(['cards', 'notes', 'events', 'mail', 'applications']);
    expect(calls.sort()).toEqual(['applications:acme', 'cards:acme', 'events:acme', 'mail:acme', 'notes:acme']);
    await expect(tile.locator('.today-tile-count')).toHaveText('6');
    // Header magnifier: the detailed Find dialog, overview first, the typed text taken along
    await tile.locator('.today-tile-btn[aria-label^="Detailed find"]').click();
    await expect(page.locator('#searchOverview')).toBeVisible();
    await expect(page.locator('#searchText')).toHaveValue('acme');
    await page.keyboard.press('Escape');
    await expect(page.locator('#searchBackdrop')).toBeHidden();
    // A source without hits stays listed: "0", no triangle (not a <details>)
    const notesRow = tile.locator('.today-search-group[data-type="notes"]');
    await expect(notesRow).toHaveClass(/today-search-group--empty/);
    await expect(notesRow.locator('.today-search-n')).toHaveText('0');
    await expect(notesRow.locator('summary')).toHaveCount(0);

    // Categories start collapsed; the summary shows the hit count; a click opens one
    await expect(tile.locator('details.today-search-group[open]')).toHaveCount(0);
    await expect(tile.locator('.today-search-group[data-type="cards"] .today-search-n')).toHaveText('3');
    await expect(tile.locator('.today-search-group[data-type="cards"] .today-kcard').first()).toBeHidden();
    for (const type of ['cards', 'events', 'mail', 'applications']) await tile.locator(`.today-search-group[data-type="${type}"] > summary`).click();

    // Card → detail panel; mail → detail panel with its folder; application → new tab link
    await tile.locator('.today-search-group[data-type="cards"] .today-kcard', { hasText: 'ACME | Backend Dev' }).locator('.card-text').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('ACME | Backend Dev');
    await expect(page.locator('#dashboardDetail .dash-card-where')).toHaveText('e2e-today › TODO');
    // Same layout as notes: table on top, the description scrolls in its own box, the body doesn't
    await expect(page.locator('#dashboardDetail .dash-doc-preview h2')).toHaveText('Role');
    expect(await page.evaluate(() => {
      const body = document.getElementById('dashboardDetailBody'), pv = document.querySelector('#dashboardDetail .dash-doc-preview');
      const t = document.querySelector('#dashboardDetail .dashboard-detail-table').getBoundingClientRect();
      return [t.bottom <= pv.getBoundingClientRect().top, body.scrollHeight > body.clientHeight, pv.scrollHeight > pv.clientHeight];
    })).toEqual([true, false, true]);
    await expect(page.locator('#dashboardDetail th', { hasText: 'Scheduled' })).toHaveCount(0);
    await page.click('#dashboardDetailClose');
    // Done card: filled circle (no button), struck through
    const doneCard = tile.locator('.today-kcard', { hasText: 'ACME old task' });
    await expect(doneCard.locator('.today-check--done')).toBeVisible();
    await expect(doneCard.locator('button.today-check')).toHaveCount(0);
    await expect(tile.locator('.today-kcard', { hasText: 'ACME | Backend Dev' }).locator('button.today-check')).toHaveCount(1);
    // Card in the Scheduled column: scheduling line in the detail panel
    await tile.locator('.today-kcard', { hasText: 'ACME weekly report' }).locator('.card-text').click();
    await expect(page.locator('#dashboardDetail .dash-card-where')).toHaveText('e2e-today › ⏰ Scheduled');
    const sched = page.locator('#dashboardDetail tr', { has: page.locator('th', { hasText: 'Scheduled' }) });
    await expect(sched).toContainText('↻ weekly Mon');
    await expect(sched).toContainText('→ TODO');
    await expect(sched).toContainText('from');
    await page.click('#dashboardDetailClose');
    await tile.locator('.today-search-group[data-type="mail"] .today-mail-row').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Offer from ACME');
    expect(mailUrl).toContain('/message/42?folder=Archive');
    await page.click('#dashboardDetailClose');
    await tile.locator('.today-search-group[data-type="events"] .today-ev').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Interview ACME');
    await page.click('#dashboardDetailClose');
    const app = tile.locator('.today-search-group[data-type="applications"] a.today-search-app');
    await expect(app).toHaveAttribute('target', '_blank');
    await expect(app).toHaveAttribute('href', 'https://cv.example/#/applications?id=a9');

    // Checkbox per category: unticking keeps the row (no count, no triangle) without a new request
    // and doesn't open the category; "None" unticks all; "All" re-shows the cached results
    calls.length = 0;
    const mailRow = tile.locator('.today-search-group[data-type="mail"]');
    await mailRow.locator('.today-search-check').uncheck();
    await expect(mailRow).toHaveClass(/today-search-group--off/);
    await expect(mailRow.locator('summary, .today-search-n')).toHaveCount(0);
    await expect(tile.locator('.today-tile-count')).toHaveText('5');
    await tile.locator('[data-ts-all="0"]').click();
    await expect(tile.locator('.today-search-group--off')).toHaveCount(5);
    await expect(tile.locator('.today-search-check:checked')).toHaveCount(0);
    await tile.locator('[data-ts-all="1"]').click();
    await expect(tile.locator('.today-search-check:checked')).toHaveCount(5);
    await expect(tile.locator('details.today-search-group[open]')).toHaveCount(4);   // opened ones stay open
    expect(calls).toEqual([]);
    // Ticking inside a collapsed category's header doesn't open it
    await tile.locator('.today-search-group[data-type="cards"] > summary').click();   // close
    await tile.locator('.today-search-group[data-type="cards"] .today-search-check').uncheck();
    await tile.locator('.today-search-group[data-type="cards"] .today-search-check').check();
    await expect(tile.locator('.today-search-group[data-type="cards"]')).not.toHaveAttribute('open', '');
    expect(calls).toEqual([]);

    // Full text: a new search of every source with full=1, kept per browser
    await tile.locator('.today-tile-btn', { hasText: 'Full text' }).click();
    await expect.poll(() => calls.length).toBe(5);
    expect(calls.every(c => c.includes('+full:acme'))).toBe(true);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('today-search')).full)).toBe(true);
    await expect(tile.locator('details.today-search-group[open]')).toHaveCount(0);   // new search: collapsed again

    // A note hit opens the note detail panel
    await tile.locator('.today-search-group[data-type="notes"] > summary').click();
    await tile.locator('.today-search-group[data-type="notes"] .today-npage').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('ACME research');
    await expect(page.locator('#dashboardDetail .dash-doc-preview')).toContainText('Salary range');
    await page.click('#dashboardDetailClose');

    // Auto-refresh keeps query and results without searching again
    calls.length = 0;
    await page.evaluate(() => loadToday({ quiet: true }));
    await expect(input).toHaveValue('acme');
    await expect(tile.locator('.today-search-group')).toHaveCount(5);
    expect(calls).toEqual([]);
  });
  test('E-T-21 while a search runs, reloads are held back and run once afterwards', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [
      { id: 'search', col: 0, order: 0, size: '1/1' }, { id: 'attention', col: 1, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    let cardLoads = 0;
    await page.route('**/api/today/widgets/cards?**', r => { cardLoads++; r.fulfill({ json: {
      date: TODAY, overdue: [], dueToday: [], startsToday: [], dueTomorrow: [], dueWeek: [], startsWeek: [], unread: [],
      counts: { overdue: 0, dueToday: 0, startsToday: 0, dueTomorrow: 0, unread: 0 } } }); });
    let releaseMail;
    await page.route('**/api/today/search**', async r => {
      const url = new URL(r.request().url());
      if (url.pathname.endsWith('/api/today/search')) return r.fulfill({ json: { types: ['cards', 'mail'], mailAccounts: [{ id: 'ma', label: 'M' }] } });
      if (url.pathname.endsWith('/mail')) await new Promise(res => { releaseMail = res; });
      return r.fulfill({ json: { items: [], total: 0 } });
    });
    await page.goto('/today');
    await page.waitForLoadState('networkidle');
    const base = cardLoads;
    await page.locator('.today-search-input').fill('acme');
    await expect(page.locator('.today-search-group[data-type="mail"] .today-search-dots')).toBeVisible();

    // Auto-refresh, refresh button and an action refresh during the search: nothing is fetched
    await page.evaluate(() => { loadToday({ quiet: true }); _todayRefresh('cards'); _todayRefreshAll(); });
    await page.waitForTimeout(300);
    expect(cardLoads).toBe(base);

    // Search done → one full reload
    releaseMail();
    await expect(page.locator('.today-search-group[data-type="mail"] .today-search-n')).toHaveText('0');
    await expect.poll(() => cardLoads).toBe(base + 1);
    await page.waitForTimeout(300);
    expect(cardLoads).toBe(base + 1);
    await expect(page.locator('.today-search-input')).toHaveValue('acme');
  });
  test('E-T-23 detail panel keeps a card unread, Edit marks it read; "Last edited" cards open the panel', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }, { width: 1 }], tiles: [
      { id: 'attention', col: 0, order: 0, size: 'container' }, { id: 'boards', col: 1, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    const board = { columns: [{ id: 'c-todo', title: 'TODO', cards: [{ id: 'id-new1', text: 'Fresh import', unread: true }, { id: 'id-r1', text: 'Recently edited', priority: 2 }] }] };
    await mockBoard(page, 'e2e-today', { board }, state);
    await page.route('**/api/today/widgets/cards?**', r => r.fulfill({ json: {
      date: TODAY, overdue: [], dueToday: [], startsToday: [], dueTomorrow: [], dueWeek: [], startsWeek: [],
      unread: [item('id-new1', 'Fresh import', { unread: true })],
      counts: { overdue: 0, dueToday: 0, startsToday: 0, dueTomorrow: 0, unread: 1 } } }));
    await page.route('**/api/boards', r => r.fulfill({ json: [{ name: 'e2e-today', columnBadges: [] }] }));
    await page.route('**/api/dashboard/recent?**', r => r.fulfill({ json: [
      { type: 'card', id: 'id-r1', title: 'Recently edited', board: 'e2e-today', context: 'TODO', at: new Date().toISOString(), color: '' }] }));
    await page.addInitScript(() => localStorage.setItem('today-att-open', JSON.stringify({ new: true })));
    await page.goto('/today');

    // Viewing in the panel: still unread, nothing written
    const row = page.locator('details.today-att[data-key="new"] .today-kcard', { hasText: 'Fresh import' });
    await expect(row).toHaveClass(/card--unread/);
    await row.locator('.card-text').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Fresh import');
    await page.waitForTimeout(300);
    expect(state.patches['e2e-today'] || []).toEqual([]);
    await expect(row).toHaveClass(/card--unread/);

    // Edit from the panel opens the dialog and marks it read (saved to the board)
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#modal')).toBeVisible();
    await expect.poll(() => JSON.stringify(state.patches['e2e-today'] || [])).toContain('"unread":false');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();

    // Boards tile → Last edited: a card opens the panel (href keeps the card on its board for new tabs)
    const recent = page.locator('.today-tile[data-tile="boards"] .today-recent');
    await recent.locator('summary').click();
    const link = recent.locator('a.dashboard-recent-item', { hasText: 'Recently edited' });
    await expect(link).toHaveAttribute('href', '/board/e2e-today#card:id-r1');
    await link.click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Recently edited');
    await expect(page.locator('#dashboardDetail .dash-card-where')).toHaveText('e2e-today › TODO');
    expect(new URL(page.url()).pathname).toBe('/today');
  });
  test('E-T-24 Edit from a full-screen detail panel opens the card / note dialog in full screen', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 1 }], tiles: [{ id: 'notes', col: 0, order: 0, size: '1/1' }] } } };
    await mockApis(page, state);
    await page.route('**/api/today/widgets/notes', r => r.fulfill({ json: {
      total: 1, boards: [{ board: 'e2e-today', pages: 1, webdav: false, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes' }] }],
    } }));
    await mockBoard(page, 'e2e-today', { ...BOARD_TODAY, notes: { schemaVersion: 2, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes', description: 'hi' }] } }, state);
    await page.goto('/today');
    const panel = page.locator('#dashboardDetail .modal');

    // Card: panel in full screen → Edit → dialog in full screen
    await page.evaluate(() => _openCardDetail('e2e-today', { id: 'id-due1', text: 'Send offer' }));
    await page.click('#dashboardDetailFsBtn');
    await expect(panel).toHaveClass(/modal--fullscreen/);
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal .modal')).toHaveClass(/modal--fullscreen/);
    await page.keyboard.press('Escape');   // leaves full screen
    await page.keyboard.press('Escape');   // closes
    await expect(page.locator('#modal')).toBeHidden();

    // Panel not in full screen → dialog not in full screen
    await page.evaluate(() => _openCardDetail('e2e-today', { id: 'id-due1', text: 'Send offer' }));
    await expect(panel).not.toHaveClass(/modal--fullscreen/);
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#modal .modal')).not.toHaveClass(/modal--fullscreen/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();

    // Note: same
    await page.locator('.today-tile[data-tile="notes"] .today-nboard > summary').click();
    await page.locator('.today-npage', { hasText: 'Meeting notes' }).click();
    await page.click('#dashboardDetailFsBtn');
    await page.click('#dashboardDetailEditBtn');
    await expect(page.locator('#noteModal')).toBeVisible();
    await expect(page.locator('#noteModal .modal')).toHaveClass(/modal--fullscreen/);
  });
  test('E-T-26 board menu on Today lists all active boards (also after an in-place edit); full-screen icon only on phones', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await page.route('**/api/boards', r => r.fulfill({ json: [
      { name: 'alpha', columnBadges: [] }, { name: 'e2e-today', columnBadges: [] }, { name: 'old', archived: true, columnBadges: [] }] }));
    await page.goto('/today');
    await page.evaluate(() => setBoardContext('e2e-today'));   // as after editing a card of that board in place
    await page.click('#headerHomeBtn');
    await expect(page.locator('#boardSwitchMenu .board-switch-item')).toHaveText(['alpha', 'e2e-today']);
    await page.keyboard.press('Escape');

    await page.goto('/today?cal=week');
    await expect(page.locator('#calView')).toBeVisible();
    await expect(page.locator('#calView [data-view-fs]')).toBeHidden();
    await page.click('#headerHomeBtn');
    await expect(page.locator('#boardSwitchMenu .board-switch-item')).toHaveText(['alpha', 'e2e-today']);
  });

  test('E-T-28 calendar / mail view open over a board without loading Today; close returns to the board', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    const todayCalls = [];
    page.on('request', r => { if (r.url().includes('/api/today/')) todayCalls.push(r.url()); });
    await page.goto('/board/e2e-today');
    await expect(page.locator('.column .card', { hasText: 'Send offer' })).toBeVisible();
    // Header order: board icons, dashboard, boards, calendar, mail, menu; no menu entries for the views on wide screens
    const order = await page.$$eval('header .header-menu > .header-menu-btn, header #headerHomeBtn',
      els => els.filter(e => e.offsetParent).map(e => e.id));
    expect(order).toEqual(['notesToggleBtn', 'schedToggleBtn', 'todayBtn', 'headerHomeBtn', 'dashboardCalBtn', 'dashboardMailBtn', 'headerMenuBtn']);
    await page.click('#headerMenuBtn');
    await expect(page.locator('#menuCalendar')).toBeHidden();
    await page.click('#headerMenuBtn');

    await page.click('#dashboardCalBtn');
    await expect(page.locator('#calView')).toBeVisible();
    await expect(page.locator('#calView')).toContainText('Planning meeting');
    expect(new URL(page.url()).pathname).toBe('/board/e2e-today');
    expect(new URL(page.url()).searchParams.get('cal')).toBeTruthy();
    await expect(page.locator('#today')).toBeHidden();
    // The view covers the board below the header
    const hdr = await page.locator('header').boundingBox();
    expect(Math.round((await page.locator('#dashboard').boundingBox()).y)).toBe(Math.round(hdr.y + hdr.height));

    // Mail view takes over; Escape closes it and returns to the board (history entry popped)
    await expect(page.locator('#dashboardCalBtn')).toBeHidden();
    await expect(page.locator('#notesToggleBtn')).toBeHidden();
    await page.click('#dashboardMailBtn');
    await expect(page.locator('#mailView')).toBeVisible();
    await expect(page.locator('#calView')).toBeHidden();
    await expect(page.locator('#dashboardMailBtn')).toBeHidden();
    await expect(page.locator('#dashboardCalBtn')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#mailView')).toBeHidden();
    await expect(page.locator('#dashboard')).toBeHidden();
    await expect.poll(() => new URL(page.url()).search).toBe('');
    await expect(page.locator('.column .card', { hasText: 'Send offer' })).toBeVisible();

    // Reload with ?cal= reopens the view over the board
    await page.goto('/board/e2e-today?cal=week');
    await expect(page.locator('#calView')).toBeVisible();
    expect(todayCalls).toEqual([]);
  });

  test('E-T-30 mail folders: hide via the folder menu (saved in the settings), "Show more … (N)" reveals them, Show folder brings one back', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    // A list from the old per-browser storage is moved to the server once
    await page.addInitScript(() => { if (!sessionStorage.getItem('e2e-hid')) { localStorage.setItem('mail-view-hidden', JSON.stringify(['ma-h\nLists'])); sessionStorage.setItem('e2e-hid', '1'); } });
    let hidden = {};
    const puts = [];
    await page.route('**/api/dashboard/mail-hidden-folders', r => {
      if (r.request().method() === 'PUT') {
        const { accountId, folders } = JSON.parse(r.request().postData());
        puts.push({ accountId, folders });
        if (folders.length) hidden[accountId] = folders; else delete hidden[accountId];
        return r.fulfill({ json: { ok: true, folders: hidden } });
      }
      return r.fulfill({ json: { folders: hidden } });
    });
    await page.route('**/api/dashboard/config', r => r.fulfill({ json: { calendarAccounts: [], mailAccounts: [{ id: 'ma-h', label: 'Work' }] } }));
    await page.route('**/api/dashboard/mail/ma-h/**', r => {
      const p = new URL(r.request().url()).pathname.replace('/api/dashboard/mail/ma-h', '');
      if (p === '/folders') return r.fulfill({ json: { folders: [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: '', specialUse: '\\Inbox', messages: 0, unseen: 0 },
        { path: 'Old', name: 'Old', delimiter: '/', parent: '', messages: 0, unseen: 0 },
        { path: 'Old/2019', name: '2019', delimiter: '/', parent: 'Old', messages: 0, unseen: 0 },
        { path: 'Lists', name: 'Lists', delimiter: '/', parent: '', messages: 0, unseen: 0 },
      ] } });
      if (p === '/messages') return r.fulfill({ json: { messages: [], total: 0, page: 0, pageSize: 50 } });
      return r.fulfill({ json: { size: 0, messages: 0 } });
    });
    await page.goto('/today?mail=ma-h&folder=INBOX');
    const row = path => page.locator(`#mailView .mv-folder[data-mv-folder="${path}"]`);
    await expect(row('Old/2019')).toBeVisible();
    await expect(row('Lists')).toHaveCount(0);
    await expect.poll(() => hidden).toEqual({ 'ma-h': ['Lists'] });
    expect(await page.evaluate(() => localStorage.getItem('mail-view-hidden'))).toBeNull();
    await row('Old').click({ button: 'right' });
    await page.locator('.ctx-item:visible', { hasText: 'Hide folder' }).click();
    await expect(row('Old')).toHaveCount(0);
    await expect(row('Old/2019')).toHaveCount(0);   // subfolders go with it
    const more = page.locator('#mailView [data-mv-hidden-toggle="ma-h"]');
    await expect(more).toHaveText('Show more … (2)');
    await expect.poll(() => hidden).toEqual({ 'ma-h': ['Lists', 'Old'] });

    // Saved on the server (settings), not in the browser
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(row('INBOX')).toBeVisible();
    await expect(row('Old')).toHaveCount(0);

    await more.click();
    await expect(row('Old')).toHaveClass(/mv-folder--hidden/);
    await expect(more).toHaveText('Show less');
    await row('Old').click({ button: 'right' });
    await page.locator('.ctx-item:visible', { hasText: 'Show folder' }).click();
    await expect(row('Old')).not.toHaveClass(/mv-folder--hidden/);
    await expect.poll(() => hidden).toEqual({ 'ma-h': ['Lists'] });
    await expect(more).toHaveText('Show less');

    // Settings → Mail lists them; the eye shows one again (also in the open mail view)
    await page.evaluate(() => openSettingsDialog('mail-accounts'));
    const list = page.locator('#mailHiddenList');
    await page.locator('#mail-hidden-folders > summary').click();
    await expect(list.locator('.mail-trusted-row')).toHaveCount(1);
    await expect(list).toContainText('Lists');
    await expect(list).toContainText('Work');
    await list.locator('[data-hidden-show="ma-h"]').click();
    await expect.poll(() => hidden).toEqual({});
    await expect(list).toContainText('No hidden folders.');
    expect(await page.evaluate(() => _mvHidden.size)).toBe(0);
  });

  test('E-T-29 mail folder menu "Delete duplicates": scan, confirm count, move the copies to the trash', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    const deletes = [];
    let dupes = [5, 7];
    await page.route('**/api/dashboard/config', r => r.fulfill({ json: { calendarAccounts: [], mailAccounts: [{ id: 'ma-d', label: 'Work', color: '#0a0' }] } }));
    await page.route('**/api/dashboard/mail/ma-d/**', r => {
      const url = new URL(r.request().url());
      const p = url.pathname.replace('/api/dashboard/mail/ma-d', '');
      if (r.request().method() === 'DELETE') { deletes.push(`${p}?${url.searchParams}`); return r.fulfill({ json: { ok: true, permanent: false } }); }
      if (p === '/folders') return r.fulfill({ json: { folders: [
        { path: 'INBOX', name: 'INBOX', delimiter: '/', parent: '', specialUse: '\\Inbox', messages: 3, unseen: 0 },
        { path: 'Projects', name: 'Projects', delimiter: '/', parent: '', messages: 9, unseen: 0 },
      ] } });
      if (p === '/messages') {
        const msg = (id, subject) => ({ id, subject, messageId: `<${subject}@ex.com>`, from: 'Jane <jane@ex.com>', to: 'me@ex.com', date: '2026-11-01T10:00:00.000Z', size: 500, unread: false });
        return r.fulfill({ json: { messages: [msg('8', 'Offer'), { ...msg('4', 'Offer'), size: 300 }, msg('5', 'Other')], total: 3, page: 0, pageSize: 50 } });
      }
      if (p === '/folder-size') return r.fulfill({ json: { size: 0, messages: 0 } });
      if (p === '/duplicates') return r.fulfill({ json: { messages: 9, uids: dupes } });
      return r.fulfill({ status: 404, json: { error: 'nf' } });
    });
    await page.goto('/today?mail=ma-d&folder=INBOX');
    // Loaded duplicates are marked like duplicate cards: same Message-ID, the smaller copy (UID 4) — the largest is kept
    await expect(page.locator('#mailView .mv-msg[data-mv-msg="4"] .card-duplicate-badge')).toHaveText('duplicate');
    await expect(page.locator('#mailView .card-duplicate-badge')).toHaveCount(1);
    const folder = page.locator('#mailView .mv-folder[data-mv-folder="Projects"]');
    await folder.click({ button: 'right' });
    await page.locator('.ctx-item:visible', { hasText: 'Delete duplicates' }).click();
    await expect(page.locator('#dialogMsg')).toContainText('Found 2 duplicates in "Projects" (9 messages checked');
    await expect(page.locator('#dialogOkBtn')).toHaveText('Move to trash');
    await page.click('#dialogOkBtn');
    await expect.poll(() => deletes).toEqual(['/message/5,7?folder=Projects']);

    // Nothing found: just a message, nothing deleted
    dupes = [];
    await folder.click({ button: 'right' });
    await page.locator('.ctx-item:visible', { hasText: 'Delete duplicates' }).click();
    await expect(page.locator('#dialogMsg')).toContainText('No duplicates found in "Projects"');
    expect(deletes).toHaveLength(1);
  });

  test('E-T-35 mail flags (Apple colours): set in the mail view list / reader, flagged mails in Needs attention, unflag there', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    const patches = [];
    const msg = (id, subject, extra = {}) => ({ id, subject, messageId: `<${id}@ex.com>`, from: 'Jane <jane@ex.com>', to: 'me@ex.com',
      date: '2026-11-01T10:00:00.000Z', size: 500, unread: false, flagged: false, flagColor: null, ...extra });
    const flagged = [msg('2', 'Old contract', { flagged: true, flagColor: 'green', date: '2025-03-01T10:00:00.000Z' })];
    await page.route('**/api/dashboard/config', r => r.fulfill({ json: { calendarAccounts: [], mailAccounts: [{ id: 'ma-f', label: 'Work', color: '#0a0' }] } }));
    await page.route('**/api/dashboard/mail', r => r.fulfill({ json: [{ accountId: 'ma-f', label: 'Work', folder: 'INBOX',
      messages: [], flagged: flagged.filter(m => m.flagColor), flaggedTotal: flagged.filter(m => m.flagColor).length, error: null }] }));
    await page.route('**/api/dashboard/mail/ma-f/**', r => {
      const url = new URL(r.request().url());
      const p = url.pathname.replace('/api/dashboard/mail/ma-f', '');
      if (r.request().method() === 'PATCH') {
        const body = r.request().postDataJSON();
        patches.push([p, body]);
        if (p === '/message/2') flagged[0].flagColor = body.flag;
        return r.fulfill({ json: { ok: true } });
      }
      if (p === '/folders') return r.fulfill({ json: { folders: [{ path: 'INBOX', name: 'INBOX', delimiter: '/', parent: '', specialUse: '\\Inbox', messages: 2, unseen: 0 }] } });
      if (p === '/messages') return r.fulfill({ json: { messages: [msg('8', 'Offer'), msg('7', 'Invoice', { flagged: true, flagColor: 'blue' })], total: 2, page: 0, pageSize: 50 } });
      if (p === '/folder-size') return r.fulfill({ json: { size: 0, messages: 0 } });
      if (p.startsWith('/message/')) return r.fulfill({ json: { ...msg(p.split('/')[2], 'Offer'), body: 'Hello', bodyHtml: '', attachments: [] } });
      return r.fulfill({ status: 404, json: { error: 'nf' } });
    });
    await page.addInitScript(() => localStorage.setItem('today-att-open', JSON.stringify({ flagged: true })));

    // Needs attention: flagged mails, however old, with the flag colour
    await page.goto('/today');
    const att = page.locator('.today-att--flagged');
    await expect(att.locator('.today-att-count')).toHaveText('1');
    await expect(att).toContainText('flagged mail');
    const row = att.locator('.today-mail-row[data-msg-id="2"]');
    await expect(row).toContainText('Old contract');
    await expect(row.locator('.mail-flag')).toHaveAttribute('title', 'Flagged (Green)');
    // Context menu → Flag → Clear flag: leaves the list
    await row.click({ button: 'right' });
    await page.hover('#mailCtxFlagWrap');
    await page.locator('#mailCtxFlagList .ctx-item', { hasText: 'Clear flag' }).click();
    await expect.poll(() => patches).toEqual([['/message/2', { flag: null }]]);
    await expect(page.locator('.today-att--flagged')).toHaveCount(0);

    // Mail view: flag shown in the list; context menu → Flag → Orange
    await page.goto('/today?mail=ma-f&folder=INBOX');
    await expect(page.locator('#mailView .mv-msg[data-mv-msg="7"] .mail-flag')).toHaveAttribute('title', 'Flagged (Blue)');
    await expect(page.locator('#mailView .mv-msg[data-mv-msg="8"] .mail-flag')).toHaveCount(0);
    await page.locator('#mailView .mv-msg[data-mv-msg="8"]').click({ button: 'right' });
    await page.locator('.ctx-item:visible', { hasText: /^Flag/ }).hover();
    await page.locator('.ctx-submenu .ctx-item:visible', { hasText: 'Orange' }).click();
    await expect(page.locator('#mailView .mv-msg[data-mv-msg="8"] .mail-flag')).toHaveAttribute('title', 'Flagged (Orange)');
    await expect.poll(() => patches.at(-1)).toEqual(['/message/8', { flag: 'orange' }]);

    // Reader: Flag button shows the colour and opens the colour menu; `s` toggles
    await page.locator('#mailView .mv-msg[data-mv-msg="7"]').click();
    const flagBtn = page.locator('#mailViewReaderActions [data-mv-act="flag"]');
    await expect(flagBtn).toHaveAttribute('aria-label', 'Flagged (Blue)');
    await flagBtn.click();
    await page.locator('#_genericCtxMenu .ctx-item:visible', { hasText: 'Clear flag' }).click();
    await expect(flagBtn).toHaveAttribute('aria-label', 'Flag');
    await expect.poll(() => patches.at(-1)).toEqual(['/message/7', { flag: null }]);
    await page.locator('#mailView .mv-msg[data-mv-msg="7"]').click();
    await page.keyboard.press('s');
    await expect(flagBtn).toHaveAttribute('aria-label', 'Flagged (Red)');
    await expect.poll(() => patches.at(-1)).toEqual(['/message/7', { flag: 'red' }]);
  });

  test('E-T-39 Stickies: rotated stack, slider / keys flip, text fits, double-click edits, new / delete, turn into a card', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(STICKY_LAYOUTS)) };
    await mockApis(page, state);
    await mockStickies(page, state);
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="stickies"]');
    const top  = tile.locator('.today-stk-paper--top');
    await expect(top).toContainText('First idea');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');
    await expect(tile.locator('.today-stk-paper--back')).toHaveCount(2);
    // Every sticky is rotated, each at its own angle
    const angles = () => tile.locator('.today-stk-paper').evaluateAll(els => els.map(e => parseFloat(e.style.getPropertyValue('--stk-tilt'))));
    const a0 = await angles();   // [2nd behind, 1st behind, top]
    expect(new Set(a0).size).toBe(3);
    for (const a of a0) expect(Math.abs(a)).toBeGreaterThanOrEqual(1.5);
    // Flipping forward: the paper behind comes up with its angle, the stack gets a fresh one
    await tile.locator('.today-stk').press('ArrowRight');
    await expect(tile.locator('.today-stk-pos')).toHaveText('2 / 3');
    const a1 = await angles();
    expect(a1[2]).toBe(a0[1]);
    expect(a1[1]).toBe(a0[0]);
    await tile.locator('.today-stk').press('ArrowLeft');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');

    // Slider → the long sticky; its text is scaled down to fit the square
    await setSlider(page, 2);
    await expect(top).toContainText('A very long thought');
    await expect(tile.locator('.today-stk-pos')).toHaveText('2 / 3');
    const fit = await top.locator('.today-stk-textbox').evaluate(b => ({ h: b.firstElementChild.offsetHeight, H: b.clientHeight, font: parseFloat(b.firstElementChild.style.fontSize) }));
    expect(fit.h).toBeLessThanOrEqual(fit.H);
    expect(fit.font).toBeLessThan(20);
    // Words never break: the long one sits on one line, inside the paper
    const word = await top.locator('.today-stk-text').evaluate(el => {
      const node = el.firstChild, w = 'Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterungsersatzteilbeschaffungsantragsformularausfüllhilfe';
      const range = document.createRange();
      range.setStart(node, node.data.indexOf(w));
      range.setEnd(node, node.data.indexOf(w) + w.length);
      const lines = new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
      const box = el.parentElement.getBoundingClientRect(), r = range.getBoundingClientRect();
      return { lines, inside: r.left >= box.left - 1 && r.right <= box.right + 1 };
    });
    expect(word).toEqual({ lines: 1, inside: true });
    const shortFont = await tile.locator('.today-stk-paper--back[data-stk-id="s-000000000001"] .today-stk-text').evaluate(e => parseFloat(e.style.fontSize));
    expect(shortFont).toBeGreaterThan(fit.font);

    // Keyboard: → next (wraps), ← back
    await tile.locator('.today-stk').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tile.locator('.today-stk-pos')).toHaveText('3 / 3');
    await page.keyboard.press('ArrowRight');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(top).toContainText('Simplicity');
    // Source after the category: the URL is a link (without the scheme), cut with an ellipsis
    const src = top.locator('.today-stk-src');
    await expect(src).toContainText('Leonardo da Vinci,');
    await expect(src.locator('a')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Leonardo_da_Vinci_and_a_very_long_path');
    await expect(src.locator('a')).toHaveText('en.wikipedia.org/wiki/Leonardo_da_Vinci_and_a_very_long_path');
    expect(await src.evaluate(e => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow)).toBe('ellipsis');
    // A click on the link opens it in a new tab, not the sticky
    const [popup] = await Promise.all([page.context().waitForEvent('page'), src.locator('a').click()]);
    await popup.close();
    await expect(page.locator('#dashboardDetail')).toBeHidden();

    // Double-click opens the detail panel; typing saves (debounced PUT)
    await top.dblclick();
    const detail = page.locator('#dashboardDetail');
    await expect(detail).toBeVisible();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Sticky · Quote');
    const ta = detail.locator('.stk-detail-text');
    await expect(ta).toHaveValue('Simplicity is the ultimate sophistication');
    await expect(detail.locator('.stk-detail-source')).toHaveValue('Leonardo da Vinci, https://en.wikipedia.org/wiki/Leonardo_da_Vinci_and_a_very_long_path');
    await ta.press('End');
    await ta.type('.');
    await detail.locator('[data-stk-color="#86efac"]').click();
    await expect.poll(() => state.stickyWrites.filter(w => w.method === 'PUT').length).toBeGreaterThan(0);
    expect(state.stickyWrites.at(-1)).toMatchObject({ method: 'PUT', id: 's-000000000001', body: { text: 'Simplicity is the ultimate sophistication.', source: 'Leonardo da Vinci, https://en.wikipedia.org/wiki/Leonardo_da_Vinci_and_a_very_long_path', color: '#86efac', category: 'quote' } });

    // Turn into a card: the inbox dialog opens prefilled
    await detail.locator('[data-stk-convert="card"]').click();
    await expect(detail).toBeHidden();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Simplicity is the ultimate sophistication.');
    await page.keyboard.press('Escape');   // inbox dialog: closes without asking
    await expect(page.locator('#modal')).toBeHidden();

    // New sticky: created on the first save, shown on top
    await tile.locator('[title="New sticky"]').click();
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('New sticky');
    await detail.locator('.stk-detail-text').fill('Call the plumber');
    await expect.poll(() => state.stickyWrites.filter(w => w.method === 'POST').length).toBe(1);
    expect(state.stickyWrites.find(w => w.method === 'POST').body).toMatchObject({ text: 'Call the plumber', category: 'note' });
    await expect(page.locator('#dashboardDetailTitle')).toHaveText('Sticky · Note');
    await expect(top).toContainText('Call the plumber');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 4');

    // Delete (confirm)
    await detail.locator('[data-stk-delete]').click();
    await page.click('#dialogOkBtn');
    await expect(detail).toBeHidden();
    expect(state.stickyWrites.at(-1)).toMatchObject({ method: 'DELETE', id: 's-0000000000ff' });
    await expect(tile.locator('.today-stk-pos')).toHaveText(/ \/ 3$/);
    await expect(top).not.toContainText('Call the plumber');
  });

  test('E-T-42 Stickies: category filter chips with counts limit the stack, are saved in the Today config, new stickies get the category, save & add another', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(STICKY_LAYOUTS)) };
    await mockApis(page, state);
    await mockStickies(page, state);
    state.stickies.push({ id: 's-000000000000', text: 'Be yourself', color: '#c4b5fd', category: 'quote', created: '2026-11-09T09:00:00.000Z', updated: '2026-11-09T09:00:00.000Z' });
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="stickies"]');
    const chip = id => tile.locator(`[data-stk-filter="${id}"]`);
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 4');
    expect(await tile.locator('[data-stk-filter]').evaluateAll(els => els.map(e => e.textContent))).toEqual(['All4', 'Note1', 'Quote2', 'Intervention0', 'Other1']);
    await expect(chip('all')).toHaveAttribute('aria-checked', 'true');

    // Quote: only the two quotes, flipping stays inside them
    await chip('quote').click();
    await expect(chip('quote')).toHaveAttribute('aria-checked', 'true');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 2');
    await expect(tile.locator('.today-stk-paper--top')).toContainText('Simplicity');
    await tile.locator('.today-stk').press('ArrowRight');
    await expect(tile.locator('.today-stk-paper--top')).toContainText('Be yourself');
    await tile.locator('.today-stk').press('ArrowRight');
    await expect(tile.locator('.today-stk-paper--top')).toContainText('Simplicity');
    await expect(tile.locator('.today-stk-paper')).toHaveCount(2);

    // Note: a single sticky, no slider
    await chip('note').click();
    await expect(tile.locator('.today-stk-paper--top')).toContainText('First idea');
    await expect(tile.locator('.today-stk-nav')).toHaveCount(0);

    // Saved in the Today config (same on all devices), kept after a reload
    await chip('quote').click();
    await expect.poll(() => state.widgets?.stickies?.filter).toBe('quote');
    expect(state.widgets.cvapp).toMatchObject({ apiUrl: 'http://cv' });   // other widget settings kept
    expect(await page.evaluate(() => localStorage.getItem('today-stickies-filter'))).toBeNull();
    await page.reload();
    await expect(chip('quote')).toHaveAttribute('aria-checked', 'true');
    await expect(tile.locator('.today-stk-pos')).toHaveText(/ \/ 2$/);

    // A new sticky starts in the filtered category and joins the filtered stack
    await tile.locator('[title="New sticky"]').click();
    await expect(page.locator('#dashboardDetail [data-stk-cat="quote"]')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#dashboardDetail .stk-detail-text').fill('Less is more');
    await expect.poll(() => state.stickyWrites.filter(w => w.method === 'POST').length).toBe(1);
    expect(state.stickyWrites.find(w => w.method === 'POST').body).toMatchObject({ text: 'Less is more', category: 'quote' });
    await page.click('#dashboardDetailClose');
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');
    await expect(chip('quote')).toHaveText('Quote3');

    // Save & add another (button, then Ctrl+Shift+Enter): saved, a blank sticky in the same category follows
    await tile.locator('[title="New sticky"]').click();
    const detail = page.locator('#dashboardDetail');
    await expect(detail.locator('[data-stk-save-new]')).toBeDisabled();   // nothing typed yet
    await detail.locator('.stk-detail-text').fill('First of many');
    await detail.locator('[data-stk-save-new]').click();
    await expect.poll(() => state.stickyWrites.filter(w => w.method === 'POST').length).toBe(2);
    await expect(detail.locator('.stk-detail-text')).toHaveValue('');
    await expect(detail.locator('.stk-detail-text')).toBeFocused();
    await expect(detail.locator('[data-stk-cat="quote"]')).toHaveAttribute('aria-checked', 'true');
    await detail.locator('.stk-detail-text').fill('Second of many');
    await detail.locator('.stk-detail-text').press('Control+Shift+Enter');
    await expect.poll(() => state.stickyWrites.filter(w => w.method === 'POST').length).toBe(3);
    await expect(detail.locator('.stk-detail-text')).toHaveValue('');
    await page.click('#dashboardDetailClose');
    expect(state.stickyWrites.filter(w => w.method === 'POST').length).toBe(3);   // the blank one is not saved
    await expect(chip('quote')).toHaveText('Quote5');
    // An existing sticky has no "Save & add another"
    await tile.locator('.today-stk-paper--top').dblclick();
    await expect(detail.locator('.stk-detail-text')).not.toHaveValue('');
    await expect(detail.locator('[data-stk-save-new]')).toHaveCount(0);
    await page.click('#dashboardDetailClose');

    // Back to all
    await chip('all').click();
    await expect(tile.locator('.today-stk-pos')).toHaveText(/ \/ 7$/);
  });

  test('E-T-40 Stickies: a due rhythm brings a random sticky to the top, the dice picks one on request', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(STICKY_LAYOUTS)) };
    await mockApis(page, state);
    await page.route('**/api/today/config', r => r.fulfill({ json: { showBar: true, widgets: { stickies: { rhythm: 60 } }, layouts: state.layouts } }));
    await mockStickies(page, state);
    // Last random pick two hours ago, current = the first sticky
    await page.addInitScript(() => {
      localStorage.setItem('today-stickies-pos', 's-000000000003');
      localStorage.setItem('today-stickies-random', JSON.stringify({ at: Date.now() - 2 * 3600000 }));
    });
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="stickies"]');
    await expect(tile.locator('.today-stk-paper--top')).toBeVisible();
    await expect(tile.locator('.today-stk-paper--top')).not.toHaveAttribute('data-stk-id', 's-000000000003');
    const at = await page.evaluate(() => JSON.parse(localStorage.getItem('today-stickies-random')).at);
    expect(Date.now() - at).toBeLessThan(60000);

    const before = await tile.locator('.today-stk-paper--top').getAttribute('data-stk-id');
    await tile.locator('[title="Random sticky"]').click();
    await expect(tile.locator('.today-stk-paper--top')).not.toHaveAttribute('data-stk-id', before);
  });

  test('E-T-43 Stickies in a fixed-height tile scale to fit without scrolling; wide tiles get an upright slider', async ({ page }) => {
    const state = { layouts: { lg: { columns: [{ width: 2 }, { width: 1 }], tiles: [
      { id: 'stickies', col: 0, order: 0, size: '1/3' },
      { id: 'agenda',   col: 1, order: 0, size: '1/1' },
    ] } } };
    await mockApis(page, state);
    await mockStickies(page, state);
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="stickies"]');
    const body = tile.locator('.today-tile-body');
    const noScroll = () => body.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1);
    await expect(tile.locator('.today-stk')).toHaveClass(/today-stk--wide/);
    await expect.poll(noScroll).toBe(true);
    const slider = await tile.locator('.today-stk-slider').boundingBox();
    const stack  = await tile.locator('.today-stk-stack').boundingBox();
    expect(slider.height).toBeGreaterThan(slider.width);   // upright …
    expect(slider.x).toBeGreaterThan(stack.x + stack.width);   // … right of the stack
    const tb = await tile.boundingBox();
    expect(tb.x + tb.width - (slider.x + slider.width)).toBeLessThan(8);   // … at the tile's right border
    await expect(tile.locator('.today-stk-navbtn')).toHaveCount(0);   // slider only, no ‹ ›

    // "available" below a 1/3 tile in a narrow column: takes the remaining space, still no scrolling
    state.layouts = { lg: { columns: [{ width: 1 }, { width: 2 }], tiles: [
      { id: 'agenda',   col: 0, order: 0, size: '1/3' },
      { id: 'stickies', col: 0, order: 1, size: 'available' },
    ] } };
    await page.reload();
    await expect(tile.locator('.today-stk-paper--top')).toBeVisible();
    await expect.poll(noScroll).toBe(true);
    const colH = await page.locator('#todayGrid .today-col').first().evaluate(el => el.clientHeight);
    const tileH = await tile.evaluate(el => el.offsetHeight);
    expect(tileH).toBeGreaterThan(colH * 0.6);   // filled the rest of the column

    // "fit content" (container) keeps the natural, width-based size
    state.layouts.lg.tiles[1].size = 'container';
    await page.reload();
    await expect(tile.locator('.today-stk-paper--top')).toBeVisible();
    await expect(tile.locator('.today-stk')).not.toHaveClass(/today-stk--wide/);
  });
});

// Touch swipe via CDP (Chromium): real touch events → pointer events with pointerType 'touch'
async function swipe(page, locator, dx) {
  await page.waitForLoadState('networkidle');   // the tile re-renders after each action: let it settle
  await locator.waitFor();
  const b = await locator.boundingBox();
  const y = b.y + b.height / 2, x0 = b.x + b.width / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / 8, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('Today page — phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('E-T-41 Stickies on a phone: swipe flips the stack, a tap opens the sticky without the keyboard', async ({ page }) => {
    const state = { layouts: JSON.parse(JSON.stringify(STICKY_LAYOUTS)) };
    await mockApis(page, state);
    await mockStickies(page, state);
    await page.addInitScript(() => localStorage.setItem('today-stickies-pos', 's-000000000003'));
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="stickies"]');
    const top  = tile.locator('.today-stk-paper--top');
    await expect(top).toContainText('First idea');
    await expect(tile.locator('.today-stk-slider')).toBeHidden();   // swipe instead; the position stays
    await expect(tile.locator('.today-stk-pos')).toBeVisible();
    await swipe(page, top, -220);   // left = next
    await expect(tile.locator('.today-stk-pos')).toHaveText('2 / 3');
    await swipe(page, top, 220);    // right = previous
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');
    await swipe(page, top, 20);     // too short: springs back
    await expect(tile.locator('.today-stk-pos')).toHaveText('1 / 3');

    await top.tap();
    await expect(page.locator('#dashboardDetail')).toBeVisible();
    await expect(page.locator('#dashboardDetail .stk-detail-text')).toHaveValue('First idea');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('stk-detail-text'))).toBe(false);
  });

  test('E-T-37 board on a phone: calendar and mail move from the header to the menu', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await page.goto('/board/e2e-today');
    await expect(page.locator('.column .card', { hasText: 'Send offer' })).toBeVisible();
    await expect(page.locator('#dashboardCalBtn')).toBeHidden();
    await expect(page.locator('#dashboardMailBtn')).toBeHidden();
    await page.click('#headerMenuBtn');
    await page.click('#menuCalendar');
    await expect(page.locator('#calView')).toBeVisible();
    await expect(page.locator('#headerDropdown')).not.toHaveClass(/open/);
    await page.click('#headerMenuBtn');
    await page.click('#menuMail');
    await expect(page.locator('#mailView')).toBeVisible();
    await expect(page.locator('#calView')).toBeHidden();
  });

  test('E-T-38 Today on a phone: calendar and mail stay in the header, not in the menu', async ({ page }) => {
    await mockApis(page, { layouts: LAYOUTS });
    await page.goto('/today');
    await expect(page.locator('#dashboardCalBtn')).toBeVisible();
    await expect(page.locator('#dashboardMailBtn')).toBeVisible();
    await page.click('#headerMenuBtn');
    await expect(page.locator('#menuFindCard')).toBeVisible();
    await expect(page.locator('#menuCalendar')).toBeHidden();
    await expect(page.locator('#menuMail')).toBeHidden();
  });

  test('E-T-25 calendar / mail view full screen on phones: header icon, covers the screen, kept per browser', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await page.addInitScript(() => {   // start without the mode once; later navigations keep it
      if (!sessionStorage.getItem('e2e-fs-reset')) { localStorage.removeItem('view-fullscreen'); sessionStorage.setItem('e2e-fs-reset', '1'); }
    });
    await page.goto('/today?cal=week');
    const view = page.locator('#calView');
    await expect(view).toBeVisible();
    const fsBtn = view.locator('[data-view-fs]');
    await expect(fsBtn).toBeVisible();
    const before = await view.boundingBox();
    expect(before.y).toBeGreaterThan(20);   // below the app header

    await fsBtn.click();
    await expect(fsBtn).toHaveAttribute('aria-pressed', 'true');
    const vp = page.viewportSize();
    const fs = await view.boundingBox();
    expect([Math.round(fs.x), Math.round(fs.y), Math.round(fs.width), Math.round(fs.height)]).toEqual([0, 0, vp.width, vp.height]);
    expect(await page.evaluate(() => localStorage.getItem('view-fullscreen'))).toBe('1');

    // The mail view shares the mode
    await page.goto('/today?mail=ma-x');
    await expect(page.locator('#mailView [data-view-fs]')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/today?cal=week');
    await page.locator('#calView [data-view-fs]').click();
    expect((await page.locator('#calView').boundingBox()).y).toBeGreaterThan(20);
  });

  test('E-T-22 detail panel stays inside the safe area (iPhone insets): centred, full screen below the status bar', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'attention', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await mockBoard(page, 'e2e-today', BOARD_TODAY, state);
    await page.goto('/today');
    await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; }' });
    await page.evaluate(() => _openCardDetail('e2e-today', { id: 'id-due1', text: 'Send offer' }));
    const modal = page.locator('#dashboardDetail .modal');
    await expect(modal).toBeVisible();
    await page.waitForTimeout(300);   // scale-in animation
    const vh = page.viewportSize().height;
    const r = await modal.boundingBox();
    expect(r.y).toBeGreaterThanOrEqual(47);
    expect(r.y + r.height).toBeLessThanOrEqual(vh - 34);
    // centred in the safe area
    expect(Math.abs((r.y - 47) - (vh - 34 - (r.y + r.height)))).toBeLessThanOrEqual(2);

    // Full screen: covers the screen, the header runs under the status bar; title and icons sit below the
    // status bar plus the blurred band (16 px), the content above the home indicator
    await page.click('#dashboardDetailFsBtn');
    await page.waitForTimeout(100);
    const f = await modal.boundingBox();
    expect(Math.round(f.y)).toBe(0);
    expect(Math.round(f.y + f.height)).toBe(vh);
    const title = await page.locator('#dashboardDetailTitle').boundingBox();
    expect(title.y).toBeGreaterThanOrEqual(47 + 16);
    const pad = await page.evaluate(() => getComputedStyle(document.getElementById('dashboardDetailBody')).paddingBottom);
    expect(pad).toBe('42px');   // 8 px + home indicator

    // iOS Home-Screen app with a short viewport (viewport.js sets --vp-gap): overlays reach the screen bottom
    await page.evaluate(() => document.documentElement.style.setProperty('--vp-gap', '62px'));
    const g = await page.locator('#dashboardDetail').boundingBox();
    expect(Math.round(g.y + g.height)).toBe(vh + 62);
    // the page height follows only its own gap (100dvh may already be full height — no overshoot)
    const bodyH = () => page.evaluate(() => Math.round(document.body.getBoundingClientRect().height));
    expect(await bodyH()).toBe(vh);
    await page.evaluate(() => document.documentElement.style.setProperty('--vp-dvh-gap', '62px'));
    expect(await bodyH()).toBe(vh + 62);
  });

  test('E-T-27 phone calendar view and Today page end above the home indicator', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await page.addInitScript(() => localStorage.removeItem('view-fullscreen'));
    await page.goto('/today');
    await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; }' });
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('today')).paddingBottom)).toBe('66px');
    await page.goto('/today?cal=week');
    await page.addStyleTag({ content: ':root { --safe-top: 47px; --safe-bottom: 34px; }' });
    const r = await page.locator('#calView').boundingBox();
    expect(Math.round(r.y + r.height)).toBe(page.viewportSize().height - 34);
  });

  test('E-T-20 note detail on a phone: table and attachments are not fixed, the whole panel scrolls', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'notes', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await page.route('**/api/today/widgets/notes', r => r.fulfill({ json: {
      total: 1, boards: [{ board: 'e2e-today', pages: 1, webdav: false, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes' }] }],
    } }));
    await mockBoard(page, 'e2e-today', { ...BOARD_TODAY, notes: { schemaVersion: 2, items: [{ type: 'page', id: 'n-abc1', title: 'Meeting notes',
      description: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n\n'), hasAttachments: true }] } }, state);
    await page.route('**/api/e2e-today/notes/attachments/n-abc1', r => r.fulfill({ json: [{ name: 'minutes.pdf', size: 2048 }] }));
    await page.goto('/today');
    const tile = page.locator('.today-tile[data-tile="notes"]');
    await tile.locator('.today-nboard > summary').click();
    await tile.locator('.today-npage', { hasText: 'Meeting notes' }).click();
    await expect(page.locator('#dashboardDetail .dash-card-attach-item')).toBeVisible();
    const m = await page.evaluate(() => {
      const body = document.getElementById('dashboardDetailBody'), pv = document.querySelector('#dashboardDetail .dash-doc-preview');
      return { bodyScrolls: body.scrollHeight > body.clientHeight, previewScrolls: pv.scrollHeight > pv.clientHeight };
    });
    expect(m).toEqual({ bodyScrolls: true, previewScrolls: false });
  });

  test('E-T-15 swipe actions in "Needs attention": mail read / flag / move, card move to column / edit / delete', async ({ page }) => {
    const state = { layouts: LAYOUTS };
    await mockApis(page, state);
    const board = { board: { columns: [
      { id: 'c-todo', title: 'TODO', cards: [{ id: 'id-od1', text: 'Overdue report', endDate: '2020-01-01' }, { id: 'id-due1', text: 'Send offer', endDate: TODAY }] },
      { id: 'c-done', title: 'DONE', cards: [] },
    ] } };
    await mockBoard(page, 'e2e-today', board, state);
    const mails = [
      { id: '11', subject: 'First unread', from: 'a@example.org', date: at(8), unread: true },
      { id: '12', subject: 'Second unread', from: 'b@example.org', date: at(7), unread: true },
    ];
    const mailCalls = [];
    await page.route('**/api/dashboard/mail', r => r.fulfill({ json: [{ accountId: 'ma-e2e', label: 'Mail', messages: mails.filter(m => m.unread && !m.gone) }] }));
    await page.route('**/api/dashboard/mail/ma-e2e/folders', r => r.fulfill({ json: { folders: [
      { path: 'INBOX', name: 'INBOX', delimiter: '/' }, { path: 'Archive', name: 'Archive', delimiter: '/' },
    ] } }));
    await page.route('**/api/dashboard/mail/ma-e2e/message/**', r => {
      const [id, action] = r.request().url().split('/message/')[1].split('?')[0].split('/');
      mailCalls.push({ method: r.request().method(), id, action, body: r.request().postData() });
      const m = mails.find(x => x.id === id);
      if (r.request().method() === 'PATCH') { const b = JSON.parse(r.request().postData()); if ('seen' in b) m.unread = !b.seen; if ('flag' in b) m.flagColor = b.flag; }
      else m.gone = true;
      r.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/dashboard/mail/ma-e2e/recent-folders', r => r.fulfill({ json: { ok: true } }));
    // Sections open from the start (clicking a summary could race the tile's re-render after an action)
    await page.addInitScript(() => localStorage.setItem('today-att-open', JSON.stringify({ mail: true, overdue: true, due: true })));
    await page.goto('/today');

    // Mail: right swipe → Mark as read
    const mail = page.locator('details.today-att[data-key="mail"]');
    await swipe(page, mail.locator('.today-mail-row', { hasText: 'First unread' }), 200);
    await mail.locator('[data-today-swipe="read"]').click();
    await expect(mail.locator('.today-mail-row', { hasText: 'First unread' })).toHaveCount(0);
    expect(mailCalls.at(-1)).toMatchObject({ method: 'PATCH', id: '11' });
    expect(JSON.parse(mailCalls.at(-1).body)).toEqual({ seen: true });

    // Mail: right swipe → Flag (orange by default) next to Mark as read
    await swipe(page, mail.locator('.today-mail-row', { hasText: 'Second unread' }), 200);
    await expect(mail.locator('.mv-swipe-actions--start [data-today-swipe]')).toHaveCount(2);
    await mail.locator('[data-today-swipe="flag"]').click();
    await expect.poll(() => mailCalls.at(-1)).toMatchObject({ method: 'PATCH', id: '12' });
    expect(JSON.parse(mailCalls.at(-1).body)).toEqual({ flag: 'orange' });

    // Mail: left swipe → Move → folder picker (current folder INBOX not offered)
    await swipe(page, mail.locator('.today-mail-row', { hasText: 'Second unread' }), -200);
    await mail.locator('[data-today-swipe="move"]').click();
    await expect(page.locator('.today-picker .mv-picker-item')).toHaveText(['Archive']);
    await page.locator('.today-picker .mv-picker-item', { hasText: 'Archive' }).click();
    await expect.poll(() => mailCalls.at(-1)).toMatchObject({ method: 'POST', id: '12', action: 'move' });
    expect(JSON.parse(mailCalls.at(-1).body)).toEqual({ folder: 'Archive' });
    await expect(mail).toHaveCount(0);   // no unread mail left

    // Card: left swipe → Move to column → DONE
    const overdue = page.locator('details.today-att[data-key="overdue"]');
    await swipe(page, overdue.locator('.today-kcard', { hasText: 'Overdue report' }), -200);
    await overdue.locator('[data-today-swipe="move"]').click();
    await expect(page.locator('.today-picker .mv-picker-item')).toHaveText(['DONE']);
    await page.locator('.today-picker .mv-picker-item', { hasText: 'DONE' }).click();
    await expect.poll(() => state.patches['e2e-today']?.length).toBe(1);
    const cols = state.patches['e2e-today'][0].updatedColumns;
    expect(cols.find(c => c.id === 'c-todo').cards.map(c => c.id)).toEqual(['id-due1']);
    expect(cols.find(c => c.id === 'c-done').cards.map(c => c.id)).toEqual(['id-od1']);

    // Card: right swipe → Edit opens the card dialog in place
    const due = page.locator('details.today-att[data-key="due"]');
    const sendOffer = due.locator('.today-kcard', { hasText: 'Send offer' });
    await swipe(page, sendOffer, 120);
    await expect(due.locator('[data-today-swipe="edit"]')).toBeVisible();
    await due.locator('[data-today-swipe="edit"]').click();
    await expect(page.locator('#modal')).toBeVisible();
    await expect(page.locator('#cardText')).toHaveValue('Send offer');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();

    // Card: left swipe → Delete asks first; Cancel keeps the card
    await swipe(page, due.locator('.today-kcard', { hasText: 'Send offer' }), -200);
    await due.locator('[data-today-swipe="delete"]').click();
    await expect(page.locator('#dialogMsg')).toHaveText('Delete card "Send offer"?');
    await page.click('#dialogCancelBtn');
    expect(state.patches['e2e-today']).toHaveLength(1);
  });

  test('E-T-31 widget mode button: one open at a time (header tap), all collapsed, all open', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [
      { id: 'agenda', col: 0, order: 0, size: 'container' },
      { id: 'attention', col: 0, order: 1, size: 'container' },
      { id: 'progress', col: 0, order: 2, size: 'container' },
    ] } } };
    await mockApis(page, state);
    await page.goto('/today');
    const btn = page.locator('#todayBar [data-bar="collapse"]');
    await expect(btn).toBeVisible();
    const collapsed = () => page.evaluate(() =>
      [...document.querySelectorAll('#todayGrid .today-tile')].filter(t => t.classList.contains('today-tile--collapsed')).map(t => t.dataset.tile));
    expect(await collapsed()).toEqual([]);

    await btn.click();   // all open → one at a time: the first open tile stays open
    expect(await collapsed()).toEqual(['attention', 'progress']);
    await page.locator('.today-tile[data-tile="attention"] .today-tile-title').click();   // single tap on phones
    expect(await collapsed()).toEqual(['agenda', 'progress']);
    await page.locator('.today-tile[data-tile="attention"] .today-tile-title').click();   // closing keeps the others closed
    expect(await collapsed()).toEqual(['agenda', 'attention', 'progress']);

    await btn.click();   // → all collapsed
    expect(await collapsed()).toEqual(['agenda', 'attention', 'progress']);
    await page.locator('.today-tile[data-tile="agenda"] .today-tile-title').click();
    await page.locator('.today-tile[data-tile="progress"] .today-tile-title').click();
    expect(await collapsed()).toEqual(['attention']);   // free toggling outside "one at a time"

    await btn.click();   // → all open
    expect(await collapsed()).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('today-collapse-mode'))).toBe('open');
  });

  test('E-T-32 phone week view: hours fixed while the days scroll, today centred, swipe past the last day offers the next week', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await page.goto('/today?cal=week');
    const week = page.locator('#calViewBody .cv-week');
    await expect(week.locator('.cv-daycol')).toHaveCount(7);
    // Today's column is centred in the area right of the hours (as far as the scroll range allows)
    const pos = () => page.evaluate(ymd => {
      const w = document.querySelector('#calViewBody .cv-week');
      const hours = w.querySelector('.cv-hours').getBoundingClientRect();
      const col = w.querySelector(`.cv-daycol[data-date="${ymd}"]`).getBoundingClientRect();
      return { left: w.scrollLeft, max: w.scrollWidth - w.clientWidth, hoursX: hours.left - w.getBoundingClientRect().left,
        colMid: col.left + col.width / 2, areaMid: hours.right + (w.getBoundingClientRect().right - hours.right) / 2 };
    }, TODAY);
    const p0 = await pos();
    expect(p0.max).toBeGreaterThan(0);
    if (p0.left > 1 && p0.left < p0.max - 1) expect(Math.abs(p0.colMid - p0.areaMid)).toBeLessThan(3);
    // Scrolled to the end: the hours stay where they are
    await week.evaluate(w => { w.scrollLeft = w.scrollWidth; });
    const p1 = await pos();
    expect(p1.left).toBe(p1.max);
    expect(Math.round(p1.hoursX)).toBe(0);
    // Swipe left at the last day → offer the next week; tapping it shows that week from its first day
    const firstBefore = await week.locator('.cv-daycol').first().getAttribute('data-date');
    const shift = days => ymd(new Date(new Date(`${firstBefore}T12:00:00`).getTime() + days * 86400000));
    const edgeSwipe = async dx => {   // touch pull from the middle of the grid; native scroll stops at the edge
      const box = await week.boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / 8, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    await edgeSwipe(-80);
    const offer = page.locator('#calViewBody .cv-edge-offer--next');
    await expect(offer).toHaveText(/Next week/);
    await offer.click();
    await expect(week.locator('.cv-daycol').first()).toHaveAttribute('data-date', shift(7));
    expect(await week.evaluate(w => w.scrollLeft)).toBe(0);

    // At the first day: a pull right offers the previous week, a second pull jumps there (at its last day)
    await edgeSwipe(80);
    await expect(page.locator('#calViewBody .cv-edge-offer--prev')).toHaveText(/Previous week/);
    await edgeSwipe(80);
    await expect(week.locator('.cv-daycol').first()).toHaveAttribute('data-date', shift(0));
    await expect(page.locator('#calViewBody .cv-edge-offer')).toHaveCount(0);
    await expect.poll(() => week.evaluate(w => w.scrollWidth - w.clientWidth - w.scrollLeft)).toBeLessThan(2);

    // One long pull past the last day: offer, then the jump in the same gesture
    await edgeSwipe(-200);
    await expect(week.locator('.cv-daycol').first()).toHaveAttribute('data-date', shift(7));
  });

  test('E-T-33 swipe actions on the cards of Boards → "Last edited"', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'boards', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    const board = { board: { columns: [
      { id: 'c-todo', title: 'TODO', cards: [{ id: 'id-due1', text: 'Send offer' }] },
      { id: 'c-done', title: 'DONE', cards: [] },
    ] } };
    await mockBoard(page, 'e2e-today', board, state);
    await page.route('**/api/boards', r => r.fulfill({ json: [{ name: 'e2e-today', columnBadges: [] }] }));
    await page.route('**/api/dashboard/recent?**', r => r.fulfill({ json: [
      { type: 'card', board: 'e2e-today', id: 'id-due1', title: 'Send offer', context: 'TODO', at: new Date().toISOString() },
      { type: 'note', board: 'e2e-today', id: 'n-abc', title: 'A note', at: new Date().toISOString() },
    ] }));
    await page.goto('/today');
    const recent = page.locator('.today-tile[data-tile="boards"] details.today-recent');
    await recent.locator('summary').click();
    // Only cards swipe (notes have no swipe wrapper)
    await expect(recent.locator('.today-swipe > .dashboard-recent-item')).toHaveCount(1);
    await swipe(page, recent.locator('.dashboard-recent-item', { hasText: 'Send offer' }), -200);
    await recent.locator('[data-today-swipe="move"]').click();
    await expect(page.locator('.today-picker .mv-picker-item')).toHaveText(['DONE']);
    await page.locator('.today-picker .mv-picker-item', { hasText: 'DONE' }).click();
    await expect.poll(() => state.patches['e2e-today']?.length).toBe(1);
    const cols = state.patches['e2e-today'][0].updatedColumns;
    expect(cols.find(c => c.id === 'c-done').cards.map(c => c.id)).toEqual(['id-due1']);
    expect(page.url()).toMatch(/\/today$/);   // the swipe did not follow the card's link
  });

  test('E-T-34 phone calendar: touch edit mode — tap marks the event, moves only after 1 s, stays editable 5 s after the change', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    const puts = [];
    await page.route('**/api/dashboard/calendar/ca-e2e/event/**', r => {
      if (r.request().method() === 'PUT') { puts.push(JSON.parse(r.request().postData())); return r.fulfill({ json: { ok: true } }); }
      return r.fulfill({ status: 404, json: { error: 'not mocked' } });
    });
    await page.goto('/today?cal=week');
    const ev = page.locator('#calViewBody .cv-timed', { hasText: 'Planning meeting' });
    await expect(ev).toBeVisible();
    const touch = async (from, dy) => {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + dy * i / 8 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    const centre = async () => { const b = await ev.boundingBox(); return { x: b.x + b.width / 2, y: b.y + 8 }; };

    // Dragging before the tap: no change (the grid may scroll, the event is not moved)
    await touch(await centre(), 60);
    expect(puts).toHaveLength(0);
    await expect(ev).not.toHaveClass(/cv-ev--touch-edit/);

    // Tap → marked; a drag right away does not move it
    await ev.tap();
    await expect(ev).toHaveClass(/cv-ev--touch-edit/);
    await expect(ev).not.toHaveClass(/cv-ev--touch-ready/);
    await expect(page.locator('#dashboardDetail .modal')).toBeHidden();   // no detail panel
    await touch(await centre(), 48);
    expect(puts).toHaveLength(0);

    // 1 s later: ready — a drag moves it one hour later
    await expect(ev).toHaveClass(/cv-ev--touch-ready/);
    await page.locator('#calViewBody .cv-week').evaluate(w => { w.scrollTop = 7 * 48 - 10; });
    await touch(await centre(), 48);
    await expect.poll(() => puts.length).toBe(1);
    expect(new Date(puts[0].start).getHours()).toBe(10);
    // Still in edit mode after the change (also after the reload re-rendered it) …
    await expect(page.locator('#calViewBody .cv-ev--touch-ready')).toHaveCount(1);
    // … until 5 s after it
    await expect(page.locator('#calViewBody .cv-ev--touch-edit')).toHaveCount(0, { timeout: 8000 });

    // A second tap on the marked event opens its details and ends the mode
    await ev.tap();
    await expect(ev).toHaveClass(/cv-ev--touch-edit/);
    await ev.tap();
    await expect(page.locator('#dashboardDetail .modal')).toBeVisible();
    await expect(page.locator('#calViewBody .cv-ev--touch-edit')).toHaveCount(0);
  });

  test('E-T-36 date, widget mode and Refresh share the first line; short date when narrow', async ({ page }) => {
    const state = { layouts: { sm: { columns: [{ width: 1 }], tiles: [{ id: 'agenda', col: 0, order: 0, size: 'container' }] } } };
    await mockApis(page, state);
    await page.goto('/today');
    const date = page.locator('#todayBar .today-bar-date strong');
    const sameLine = async () => {
      const [d, c, r] = await Promise.all([date, page.locator('#todayBar [data-bar="collapse"]'),
        page.locator('#todayBar .today-bar-refresh-sm[data-bar="refresh"]')].map(l => l.boundingBox()));
      const mid = b => b.y + b.height / 2;
      expect(Math.abs(mid(c) - mid(d))).toBeLessThan(12);
      expect(Math.abs(mid(r) - mid(d))).toBeLessThan(12);
    };
    await sameLine();
    const long = await date.getAttribute('data-long');
    const short = await date.getAttribute('data-short');
    expect(short).toMatch(/, \d\d\.\d\d\.\d{4}$/);

    await page.setViewportSize({ width: 280, height: 700 });
    await expect(date).toHaveText(short);
    await sameLine();
    await page.setViewportSize({ width: 700, height: 844 });
    await expect(date).toHaveText(long);
    await sameLine();
  });
});
