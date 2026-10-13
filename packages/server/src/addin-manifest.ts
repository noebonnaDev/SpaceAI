import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ADDIN_ID = '97ff4eff-7c3f-4004-9faf-dbc30ac4db11';

/** Locates packages/addin/manifest.template.xml in the source tree or in the container image. */
export function findManifestTemplate(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ADDIN_MANIFEST_TEMPLATE,
    path.resolve(process.cwd(), '../addin/manifest.template.xml'),
    path.resolve(process.cwd(), 'packages/addin/manifest.template.xml'),
    path.resolve(here, '../../addin/manifest.template.xml'),
    path.resolve(here, '../addin/manifest.template.xml'),
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Same rendering as packages/addin/scripts/generate-manifest.mjs. */
export function renderAddinManifest(template: string, baseUrl: string, addinId = DEFAULT_ADDIN_ID, appName = 'Ritrovo'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const values: Record<string, string> = {
    BASE_URL: baseUrl.replace(/\/+$/, ''),
    ADDIN_ID: addinId,
    VERSION: '1.0.0.0',
    PROVIDER: esc(appName),
    DISPLAY_NAME: esc(appName),
    SUPPORT_URL: `${baseUrl.replace(/\/+$/, '')}/`,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}

export function loadManifestTemplate(): string | null {
  const p = findManifestTemplate();
  return p ? readFileSync(p, 'utf8') : null;
}
