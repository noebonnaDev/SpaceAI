// End-to-end smoke test in a real browser (Chromium via Playwright) against a running demo instance.
// Usage: docker compose up -d && BASE=http://localhost:8080 node e2e/smoke.mjs
// Needs Playwright (npm i -g playwright && npx playwright install chromium). Screenshots go to e2e/screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const BASE = process.env.BASE ?? 'http://localhost:8080';
const OUT = process.env.OUT ?? new URL('./screenshots', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--lang=it-IT'] });
const errors = [];
const watch = (page, name) => {
  page.on('pageerror', (e) => errors.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('appsforoffice')) errors.push(`${name}: console ${m.text()}`); });
};
async function login(ctx, name) {
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('heading', { name: /Buongiorno/ }).waitFor();
  return page;
}
// 1. User flow
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const page = await login(ctx, 'Marco Esposito');
await page.screenshot({ path: `${OUT}/01-home.png` });
await page.getByRole('link', { name: 'Sale riunioni' }).first().click();
await page.getByRole('heading', { name: 'Sale riunioni' }).waitFor();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/02-sale.png`, fullPage: true });
await page.getByRole('button', { name: 'Prenota' }).first().click();
await page.getByLabel('Oggetto').fill('Riunione di prova Playwright');
await page.screenshot({ path: `${OUT}/03-dialog.png` });
await page.locator('dialog').getByRole('button', { name: 'Prenota' }).click();
await page.getByText(/Prenotazione creata|in attesa/).first().waitFor({ timeout: 10000 });
await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 8000 });
console.log('booking created: OK');
await page.getByRole('link', { name: 'Postazioni' }).click();
await page.locator('.floormap img').waitFor();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/04-postazioni.png`, fullPage: true });
await page.locator('.marker.free').first().click();
await page.locator('aside').getByRole('button', { name: 'Prenota' }).click();
await page.waitForTimeout(5000); // let the previous toast disappear
await page.locator('dialog').getByRole('button', { name: 'Prenota' }).click();
try {
  await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 8000 });
  console.log('desk booked: OK');
} catch {
  await page.screenshot({ path: `${OUT}/err-desk.png` });
  console.log('DESK DIALOG STILL OPEN:', await page.locator('dialog').innerText());
  process.exit(1);
}
await page.getByRole('link', { name: 'Le mie prenotazioni' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/05-mie.png`, fullPage: true });
// 2. Admin
const actx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const admin = await login(actx, 'Giulia Rinaldi');
await admin.goto(BASE + '/admin/report');
await admin.locator('.stat-value.hero').waitFor();
await admin.waitForTimeout(800);
await admin.screenshot({ path: `${OUT}/06-report.png`, fullPage: true });
await admin.goto(BASE + '/admin');
await admin.waitForTimeout(1000);
await admin.screenshot({ path: `${OUT}/07-admin-overview.png`, fullPage: true });
const token = await admin.evaluate(() => sessionStorage.getItem('ritrovo.devToken'));
const resources = await (await fetch(BASE + '/api/admin/resources', { headers: { Authorization: `Bearer ${token}` } })).json();
const volta = resources.find((r) => r.name === 'Sala Volta');
const pair = await (await fetch(BASE + '/api/admin/kiosks', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Tablet Volta', kind: 'panel', resourceId: volta.id }) })).json();
// 3. Kiosk
const kctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const kiosk = await kctx.newPage();
watch(kiosk, 'kiosk');
await kiosk.goto(pair.pairingUrl.replace(/^https?:\/\/[^/]+/, BASE));
await kiosk.locator('.kiosk-state').waitFor();
await kiosk.screenshot({ path: `${OUT}/08-pannello.png` });
console.log('kiosk url after pairing:', kiosk.url());
// 4. Add-in task pane with a simulated Office.js host (appointment being composed)
const xctx = await browser.newContext({ viewport: { width: 360, height: 780 }, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const pane = await xctx.newPage();
watch(pane, 'addin');
await pane.route('https://appsforoffice.microsoft.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
await pane.addInitScript(() => {
  const ok = (value) => (cb) => cb({ status: 'succeeded', value });
  const start = new Date(Date.now() + 24 * 3600e3); start.setUTCHours(13, 0, 0, 0);
  const end = new Date(start.getTime() + 3600e3);
  window.__added = [];
  window.Office = {
    onReady: (cb) => { cb({ host: 'Outlook' }); return Promise.resolve(); },
    context: {
      requirements: { isSetSupported: () => true },
      mailbox: { item: {
        itemType: 'appointment',
        subject: { getAsync: ok('Riunione con il cliente') },
        start: { getAsync: ok(start) }, end: { getAsync: ok(end) },
        requiredAttendees: { getAsync: ok([{ emailAddress: 'sara.colombo@ufficio.example' }]), addAsync: (l, cb) => { window.__added.push(...l); cb({ status: 'succeeded' }); } },
        optionalAttendees: { getAsync: ok([]) },
        enhancedLocation: { addAsync: (l, cb) => { window.__added.push(...l); cb({ status: 'succeeded' }); } },
        addHandlerAsync: () => {},
      } },
    },
    MailboxEnums: { ItemType: { Appointment: 'appointment' }, LocationType: { Room: 'room' } },
    EventType: { AppointmentTimeChanged: 'appointmentTimeChanged' },
  };
});
await pane.goto(BASE + '/addin/taskpane.html');
await pane.locator('select').first().selectOption({ label: 'Marco Esposito (Utente)' });
await pane.getByText('Sale libere per questa riunione').waitFor();
await pane.getByRole('button', { name: 'Aggiungi alla riunione' }).first().waitFor();
await pane.screenshot({ path: `${OUT}/09-addin.png`, fullPage: true });
await pane.getByRole('button', { name: 'Aggiungi alla riunione' }).first().click();
await pane.waitForTimeout(500);
console.log('add-in added to meeting:', JSON.stringify(await pane.evaluate(() => window.__added)));
// 5. Mobile
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'it-IT', timezoneId: 'Europe/Rome', isMobile: true });
const mobile = await login(mctx, 'Sara Colombo');
await mobile.screenshot({ path: `${OUT}/10-mobile.png`, fullPage: true });
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('mobile horizontal overflow:', overflow);
await browser.close();
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
