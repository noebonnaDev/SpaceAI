import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderManifest } from '../scripts/generate-manifest.mjs';
import { localChecks } from '../scripts/validate-manifest.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = await readFile(path.join(here, '..', 'manifest.template.xml'), 'utf8');
const good = renderManifest(template, { url: 'https://prenotazioni.azienda.example' });
const publicDir = path.join(here, '..', '..', 'web', 'public');

test('il manifest generato supera i controlli strutturali', async () => {
  const r = await localChecks(good, { webPublicDir: publicDir });
  assert.deepEqual(r.errors, []);
  assert.match(good, /<SourceLocation DefaultValue="https:\/\/prenotazioni\.azienda\.example\/addin\/taskpane\.html"\/>/);
  assert.match(good, /AppointmentOrganizerCommandSurface/);
  assert.match(good, /MobileMessageReadCommandSurface/);
});

test('il generatore rifiuta URL non HTTPS o con percorso', () => {
  assert.throws(() => renderManifest(template, { url: 'http://prenotazioni.azienda.example' }), /URL non valido/);
  assert.throws(() => renderManifest(template, { url: 'https://azienda.example/ritrovo' }), /URL non valido/);
  assert.throws(() => renderManifest(template, { url: 'https://azienda.example', id: 'non-un-guid' }), /GUID/);
});

test('i controlli rilevano ordine errato, resid mancanti, URL non HTTPS, icone mancanti', async () => {
  const swapped = good.replace(/(<FormSettings>[\s\S]*?<\/FormSettings>)(\s*)(<Permissions>ReadWriteItem<\/Permissions>)/, '$3$2$1');
  assert.notEqual(swapped, good);
  assert.ok((await localChecks(swapped)).errors.some((e) => e.includes('Ordine')));
  const missingRes = good.replace('<bt:String id="paneButtonLabel" DefaultValue="Prenotazioni"/>', '');
  assert.ok((await localChecks(missingRes)).errors.some((e) => e.includes('paneButtonLabel')));
  const http = good.replace('https://login.microsoftonline.com', 'http://login.microsoftonline.com');
  assert.ok((await localChecks(http)).errors.some((e) => e.includes('non HTTPS')));
  const noIcon = good.replace('<bt:Image size="80" resid="icon80"/>', '');
  assert.ok((await localChecks(noIcon)).errors.some((e) => e.includes('Icona 80')));
  assert.ok((await localChecks('<OfficeApp>')).errors[0].includes('XML'));
});
