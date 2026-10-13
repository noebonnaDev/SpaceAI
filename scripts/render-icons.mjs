// Renders the Ritrovo logo (SVG) into the PNG sizes needed by the PWA and the Outlook add-in manifest.
// Usage: node scripts/render-icons.mjs  (needs Playwright with Chromium; icons are committed, so this is only for regeneration)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const svg = await readFile(path.join(root, 'packages/web/public/icons/logo.svg'), 'utf8');
const targets = [
  ...[192, 512].map((s) => ({ size: s, file: `packages/web/public/icons/icon-${s}.png` })),
  { size: 512, file: 'packages/web/public/icons/maskable-512.png', padding: 0.12 },
  { size: 180, file: 'packages/web/public/icons/apple-touch-icon.png' },
  ...[16, 25, 32, 48, 64, 80, 128].map((s) => ({ size: s, file: `packages/web/public/addin/icons/icon-${s}.png` })),
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const t of targets) {
  const pad = t.padding ? Math.round(t.size * t.padding) : 0;
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:${t.padding ? '#0f6b5c' : 'transparent'}"><div style="padding:${pad}px;width:${t.size - 2 * pad}px;height:${t.size - 2 * pad}px">${svg.replace('<svg ', `<svg width="${t.size - 2 * pad}" height="${t.size - 2 * pad}" `)}</div></body></html>`,
  );
  await page.screenshot({ path: path.join(root, t.file), omitBackground: !t.padding, clip: { x: 0, y: 0, width: t.size, height: t.size } });
  console.log('ok', t.file);
}
await browser.close();
