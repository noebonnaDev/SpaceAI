// End-to-end test of the in-browser demo (packages/demo): everything runs in the page, no server behind /api.
// Usage: npm run build -w @ritrovo/demo && serve packages/demo/dist (with application/wasm) && BASE=http://localhost:4600 node e2e/demo.mjs
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const BASE = process.env.BASE ?? 'http://localhost:4600';
const OUT = process.env.OUT ?? new URL('./screenshots/demo', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--lang=it-IT'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
const step = (s) => console.log(`- ${s}`);
const login = async (name) => {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('heading', { name: /Buongiorno/ }).waitFor();
};
const demoBar = page.locator('aside.demo-bar');

const t0 = Date.now();
await page.goto(BASE);
await page.getByRole('heading', { name: 'Accedi a Ritrovo' }).waitFor({ timeout: 90_000 });
step(`avvio completato in ${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')} s`);

await login('Marco Esposito');
await page.screenshot({ path: `${OUT}/01-oggi.png` });
await page.getByRole('link', { name: 'Sale riunioni' }).first().click();
await page.getByRole('heading', { name: 'Sale riunioni' }).waitFor();
await page.getByRole('button', { name: 'Prenota' }).first().click();
await page.getByLabel('Oggetto').fill('Riunione demo');
await page.locator('dialog').getByRole('button', { name: 'Prenota' }).click();
await page.getByText(/Prenotazione creata|in attesa/).first().waitFor({ timeout: 15_000 });
await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 10_000 });
step('prenotazione di una sala: ok');

await page.getByRole('link', { name: 'Le mie prenotazioni' }).click();
const item = page.locator('.booking-item', { hasText: 'Riunione demo' }).first();
await item.waitFor();
await item.getByRole('button', { name: 'Annulla prenotazione' }).click();
await page.locator('dialog[open]').getByRole('button', { name: 'Annulla prenotazione' }).click();
await page.getByText('Prenotazione annullata.').first().waitFor({ timeout: 10_000 });
step('annullamento con conferma nella finestra dell’app: ok');

await page.getByRole('link', { name: 'Postazioni' }).click();
await page.locator('.floormap img').waitFor({ timeout: 15_000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-postazioni.png` });
step('planimetria caricata come immagine dal backend nel browser: ok');

await demoBar.getByRole('button', { name: 'Cambia utente' }).click();
await login('Giulia Rinaldi');
await page.getByRole('link', { name: 'Amministrazione' }).click();
await page.getByRole('link', { name: 'Report KPI' }).click();
await page.locator('.stat-value.hero').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/03-report.png` });
step(`report KPI: occupazione ${await page.locator('.stat-value.hero').innerText()}`);

await page.getByRole('link', { name: 'Richieste' }).first().click();
await page.getByLabel('Oggetto').fill('Lampada da sostituire in Sala Fermi');
await page.getByRole('button', { name: 'Invia richiesta' }).click();
await page.getByText('Richiesta inviata.').first().waitFor();
const row = page.locator('.card', { hasText: 'Tutte le richieste' }).locator('.booking-item', { hasText: 'Lampada' });
await row.locator('select').selectOption('resolved');
await page.locator('#request-resolution-note').fill('Lampada sostituita alle 15:30.');
await page.locator('dialog[open]').getByRole('button', { name: 'Salva' }).click();
await page.getByText('Lampada sostituita alle 15:30.').first().waitFor({ timeout: 10_000 });
step('richiesta risolta con nota di chiusura: ok');

await demoBar.getByRole('button', { name: 'Pannello Sala Volta' }).click();
await page.locator('.kiosk-state').waitFor({ timeout: 15_000 });
await page.screenshot({ path: `${OUT}/04-pannello.png` });
step(`pannello Sala Volta: ${await page.locator('.kiosk-state').innerText()}`);
await demoBar.getByRole('button', { name: 'Schermo ingresso' }).click();
await page.getByText('Disponibilità sale').waitFor({ timeout: 15_000 });
await page.screenshot({ path: `${OUT}/05-totem.png` });
step('schermo ingresso: ok');

await demoBar.getByRole('button', { name: 'QR del proiettore' }).click();
await page.getByRole('heading', { name: /Proiettore portatile/ }).first().waitFor({ timeout: 15_000 });
await page.screenshot({ path: `${OUT}/06-qr.png` });
step('scansione QR simulata: ok');

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'it-IT', timezoneId: 'Europe/Rome' });
const phone = await mobile.newPage();
phone.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
await phone.goto(BASE);
await phone.getByRole('heading', { name: 'Accedi a Ritrovo' }).waitFor({ timeout: 90_000 });
await phone.getByRole('button', { name: /Sara Colombo/ }).click();
await phone.getByRole('heading', { name: /Buongiorno/ }).waitFor();
await phone.screenshot({ path: `${OUT}/07-mobile.png` });
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
step(`telefono: scorrimento orizzontale ${overflow ? 'PRESENTE' : 'assente'}`);

await browser.close();
console.log(errors.length ? `ERRORI:\n${errors.join('\n')}` : 'Nessun errore nel browser.');
process.exit(errors.length || overflow ? 1 : 0);
