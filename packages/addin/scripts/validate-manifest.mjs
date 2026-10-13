// Validates the Outlook add-in manifest.
// 1) Microsoft's official validation (office-addin-manifest -> Microsoft validation service). Needs Internet access.
// 2) Local structural checks based on the official element reference and element ordering
//    (https://learn.microsoft.com/office/dev/add-ins/develop/manifest-element-ordering).
// Usage: npm run manifest:validate -- [path/to/manifest.xml] [--offline]
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xml2js = require('xml2js');
const here = path.dirname(fileURLToPath(import.meta.url));

const TOP_ORDER = [
  'Id', 'AlternateId', 'Version', 'ProviderName', 'DefaultLocale', 'DisplayName', 'Description', 'IconUrl',
  'HighResolutionIconUrl', 'SupportUrl', 'AppDomains', 'Hosts', 'Requirements', 'FormSettings', 'Permissions', 'Rule',
  'DisableEntityHighlighting', 'VersionOverrides',
];
const REQUIRED_TOP = ['Id', 'Version', 'ProviderName', 'DefaultLocale', 'DisplayName', 'Description', 'IconUrl', 'SupportUrl', 'Hosts', 'Requirements', 'FormSettings', 'Permissions', 'Rule'];
const VO_ORDER = ['Description', 'Requirements', 'Hosts', 'Resources', 'VersionOverrides'];
const DESKTOP_POINTS = new Set([
  'MessageReadCommandSurface', 'MessageComposeCommandSurface', 'AppointmentOrganizerCommandSurface',
  'AppointmentAttendeeCommandSurface', 'Module', 'LaunchEvent', 'Events', 'DetectedEntity', 'ReportPhishingCommandSurface',
]);
const MOBILE_POINTS = new Set(['MobileMessageReadCommandSurface', 'MobileOnlineMeetingCommandSurface', 'MobileLogEventAppointmentAttendee', 'LaunchEvent']);
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const local = (name) => name.replace(/^.*:/, '');
const kids = (node) => (node?.$$ ?? []);
const child = (node, name) => kids(node).find((c) => local(c['#name']) === name);
const children = (node, name) => kids(node).filter((c) => local(c['#name']) === name);
function* walk(node, trail = []) {
  for (const c of kids(node)) {
    const p = [...trail, local(c['#name'])];
    yield [c, p];
    yield* walk(c, p);
  }
}

export async function localChecks(xml, { webPublicDir } = {}) {
  const errors = [];
  const warnings = [];
  let doc;
  try {
    doc = await xml2js.parseStringPromise(xml, { explicitChildren: true, preserveChildrenOrder: true, charsAsChildren: false, explicitRoot: true });
  } catch (err) {
    return { errors: [`XML non ben formato: ${err.message}`], warnings };
  }
  const rootName = Object.keys(doc)[0];
  const root = doc[rootName];
  if (local(rootName) !== 'OfficeApp') errors.push('Elemento radice diverso da OfficeApp.');
  if (root.$?.['xsi:type'] !== 'MailApp') errors.push('OfficeApp deve avere xsi:type="MailApp".');
  if (root.$?.xmlns !== 'http://schemas.microsoft.com/office/appforoffice/1.1') errors.push('Namespace OfficeApp non corretto (atteso .../appforoffice/1.1).');

  // Top-level ordering and required elements.
  const names = kids(root).map((c) => local(c['#name']));
  let last = -1;
  for (const n of names) {
    const idx = TOP_ORDER.indexOf(n);
    if (idx === -1) errors.push(`Elemento non previsto al primo livello: ${n}`);
    else if (idx < last) errors.push(`Ordine degli elementi non valido: ${n} deve precedere ${TOP_ORDER[last]}`);
    else last = idx;
  }
  for (const r of REQUIRED_TOP) if (!names.includes(r)) errors.push(`Elemento obbligatorio mancante: ${r}`);

  const text = (n) => (typeof n?._ === 'string' ? n._.trim() : '');
  if (!GUID.test(text(child(root, 'Id')))) errors.push('Id deve essere un GUID.');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(text(child(root, 'Version')))) errors.push('Version deve avere il formato n.n.n.n.');
  if (!['ReadItem', 'ReadWriteItem', 'ReadWriteMailbox', 'Restricted'].includes(text(child(root, 'Permissions')))) errors.push('Permissions non valido.');

  // URLs must be HTTPS.
  const urls = [];
  for (const [n, p] of walk(root)) {
    const name = p[p.length - 1];
    if (['IconUrl', 'HighResolutionIconUrl', 'SupportUrl', 'SourceLocation', 'Image', 'Url'].includes(name) && n.$?.DefaultValue) urls.push(n.$.DefaultValue);
    if (name === 'AppDomain') urls.push(text(n));
  }
  for (const u of urls) if (!/^https:\/\//.test(u)) errors.push(`URL non HTTPS: ${u}`);

  // VersionOverrides structure.
  const vo = child(root, 'VersionOverrides');
  if (!vo) errors.push('VersionOverrides mancante (pulsanti dei comandi).');
  const vo11 = vo && child(vo, 'VersionOverrides');
  const target = vo11 ?? vo;
  if (vo && vo.$?.['xsi:type'] !== 'VersionOverridesV1_0') errors.push('VersionOverrides esterno deve essere VersionOverridesV1_0.');
  if (vo11 && vo11.$?.['xsi:type'] !== 'VersionOverridesV1_1') errors.push('VersionOverrides annidato deve essere VersionOverridesV1_1.');
  if (vo11 && vo11.$?.xmlns !== 'http://schemas.microsoft.com/office/mailappversionoverrides/1.1') errors.push('Namespace di VersionOverridesV1_1 non corretto.');
  for (const v of [vo, vo11].filter(Boolean)) {
    let lastV = -1;
    for (const n of kids(v).map((c) => local(c['#name']))) {
      const idx = VO_ORDER.indexOf(n);
      if (idx === -1) errors.push(`Elemento non previsto in VersionOverrides: ${n}`);
      else if (idx < lastV) errors.push(`Ordine non valido in VersionOverrides: ${n}`);
      else lastV = idx;
    }
  }

  // Resources and resid references.
  const resources = target && child(target, 'Resources');
  const pool = { Images: new Map(), Urls: new Map(), ShortStrings: new Map(), LongStrings: new Map() };
  if (!resources) errors.push('Resources mancante.');
  else {
    for (const kind of Object.keys(pool)) {
      for (const item of kids(child(resources, kind))) {
        const id = item.$?.id;
        const value = item.$?.DefaultValue ?? '';
        if (!id) errors.push(`Risorsa ${kind} senza id.`);
        else if (id.length > 32) errors.push(`resid troppo lungo (max 32): ${id}`);
        else if (pool[kind].has(id)) errors.push(`resid duplicato: ${id}`);
        pool[kind].set(id, value);
        if (kind === 'ShortStrings' && value.length > 125) errors.push(`ShortString oltre 125 caratteri: ${id}`);
        if (kind === 'LongStrings' && value.length > 250) errors.push(`LongString oltre 250 caratteri: ${id}`);
      }
    }
  }
  const expect = (resid, kind, where) => {
    if (!resid) errors.push(`resid mancante in ${where}`);
    else if (!pool[kind].has(resid)) errors.push(`resid "${resid}" (${where}) non definito in Resources/${kind}`);
  };
  const ids = new Set();
  const hosts = target ? kids(child(target, 'Hosts')) : [];
  if (!hosts.length) errors.push('Nessun Host in VersionOverrides.');
  for (const host of hosts) {
    if (host.$?.['xsi:type'] !== 'MailHost') errors.push('Host deve essere MailHost.');
    for (const ff of kids(host)) {
      const ffName = local(ff['#name']);
      if (!['DesktopFormFactor', 'MobileFormFactor'].includes(ffName)) {
        errors.push(`Form factor non previsto: ${ffName}`);
        continue;
      }
      const ff1 = child(ff, 'FunctionFile');
      if (ff1) expect(ff1.$?.resid, 'Urls', `${ffName}/FunctionFile`);
      for (const ep of children(ff, 'ExtensionPoint')) {
        const type = ep.$?.['xsi:type'];
        const allowed = ffName === 'DesktopFormFactor' ? DESKTOP_POINTS : MOBILE_POINTS;
        if (!allowed.has(type)) errors.push(`ExtensionPoint non valido per ${ffName}: ${type}`);
        for (const [n, p] of walk(ep)) {
          const name = p[p.length - 1];
          const where = `${type}/${p.join('/')}`;
          if (['Group', 'Control'].includes(name)) {
            const id = n.$?.id;
            if (!id) errors.push(`${name} senza id in ${where}`);
            else if (id.length > 125) errors.push(`id troppo lungo: ${id}`);
            else if (ids.has(`${ffName}:${id}`)) errors.push(`id duplicato: ${id}`);
            ids.add(`${ffName}:${id}`);
          }
          if (name === 'Label' || (name === 'Title' && p.includes('Supertip'))) expect(n.$?.resid, 'ShortStrings', where);
          if (name === 'Description' && p.includes('Supertip')) expect(n.$?.resid, 'LongStrings', where);
          if (name === 'Image') expect(n.$?.resid, 'Images', where);
          if (name === 'SourceLocation') expect(n.$?.resid, 'Urls', where);
          if (name === 'Icon') {
            const sizes = kids(n).map((i) => `${i.$?.size}${i.$?.scale ? `@${i.$.scale}` : ''}`);
            const need = ffName === 'DesktopFormFactor' ? ['16', '32', '80'] : ['25@1', '25@2', '25@3', '32@1', '32@2', '32@3', '48@1', '48@2', '48@3'];
            for (const s of need) if (!sizes.includes(s)) errors.push(`Icona ${s} mancante in ${where}`);
          }
        }
      }
    }
  }

  // Icon files actually shipped with the web app (checked when the folder is available).
  if (webPublicDir) {
    for (const [, url] of pool.Images) {
      const m = url.match(/^https:\/\/[^/]+(\/.*)$/);
      if (m && !existsSync(path.join(webPublicDir, m[1]))) errors.push(`File icona non trovato: ${m[1]}`);
    }
  }
  if (!xml.includes('MobileFormFactor')) warnings.push('Nessun supporto mobile dichiarato.');
  return { errors, warnings };
}

async function officialValidation(manifestPath) {
  const { validateManifest } = require('office-addin-manifest');
  const result = await validateManifest(manifestPath);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const file = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(here, '..', 'build', 'manifest.xml'));
  if (!existsSync(file)) {
    console.error(`Manifest non trovato: ${file}\nGeneralo prima con: npm run manifest -- --url https://prenotazioni.azienda.it`);
    process.exit(1);
  }
  const xml = await readFile(file, 'utf8');
  const { errors, warnings } = await localChecks(xml, { webPublicDir: path.join(here, '..', '..', 'web', 'public') });
  console.log(`Controlli strutturali locali (${path.basename(file)}): ${errors.length ? 'ERRORI' : 'OK'}`);
  for (const e of errors) console.log(`  ✗ ${e}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  let officialOk = null;
  if (!offline) {
    try {
      const r = await officialValidation(file);
      officialOk = Boolean(r.isValid);
      console.log(`Validazione ufficiale Microsoft: ${r.isValid ? 'VALIDO' : 'NON VALIDO'}${r.status ? ` (HTTP ${r.status})` : ''}`);
      for (const e of r.report?.errors ?? []) console.log(`  ✗ ${e.title ?? ''} ${e.content ?? e.detail ?? ''}`);
      for (const w of r.report?.warnings ?? []) console.log(`  ! ${w.title ?? ''} ${w.content ?? w.detail ?? ''}`);
    } catch (err) {
      console.log(`Validazione ufficiale Microsoft: NON ESEGUITA - servizio non raggiungibile (${String(err.message).split('\n')[0]})`);
    }
  }
  process.exit(errors.length || officialOk === false ? 1 : 0);
}
