// Generates the Outlook add-in manifest for your Ritrovo domain.
// Usage: npm run manifest -- --url https://prenotazioni.azienda.it [--id <GUID>] [--version 1.0.0.0] [--out build/manifest.xml]
// Tip: the running server also publishes the same manifest at <PUBLIC_BASE_URL>/addin/manifest.xml.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ADDIN_ID = '97ff4eff-7c3f-4004-9faf-dbc30ac4db11';
const here = path.dirname(fileURLToPath(import.meta.url));

export function renderManifest(template, opts) {
  const base = String(opts.url ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/.test(base)) {
    throw new Error(`URL non valido: "${opts.url}". Serve l'indirizzo HTTPS di Ritrovo senza percorso, es. https://prenotazioni.azienda.it`);
  }
  const id = opts.id ?? DEFAULT_ADDIN_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error(`GUID non valido: ${id}`);
  const version = opts.version ?? '1.0.0.0';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`Versione non valida (formato 1.0.0.0): ${version}`);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const values = {
    BASE_URL: base,
    ADDIN_ID: id,
    VERSION: version,
    PROVIDER: esc(opts.provider ?? 'Ritrovo'),
    DISPLAY_NAME: esc(opts.name ?? 'Ritrovo'),
    SUPPORT_URL: opts.supportUrl ?? `${base}/`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in values)) throw new Error(`Segnaposto sconosciuto: ${k}`);
    return values[k];
  });
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const template = await readFile(path.join(here, '..', 'manifest.template.xml'), 'utf8');
  const out = path.resolve(arg('out') ?? path.join(here, '..', 'build', 'manifest.xml'));
  try {
    const xml = renderManifest(template, {
      url: arg('url') ?? process.env.PUBLIC_BASE_URL,
      id: arg('id') ?? process.env.ADDIN_ID,
      version: arg('version'),
      name: arg('name'),
      provider: arg('provider'),
    });
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, xml, 'utf8');
    console.log(`Manifest generato: ${out}`);
  } catch (err) {
    console.error(`Errore: ${err.message}`);
    process.exit(1);
  }
}
