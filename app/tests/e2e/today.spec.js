'use strict';
/**
 * E2E — Today page (/today)
 *
 * All data endpoints are mocked with page.route (no CalDAV / IMAP / Open-Meteo / CV-App, and no
 * writes to the shared CouchDB — PUT /api/today/config is captured in the test).
 *
 * Scenarios: E-T-1 … E-T-4
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
});
