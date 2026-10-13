// Turns the Vite build into a page publishable as a claude.ai artifact: page content without the document
// skeleton (added at publish time), CSS inlined, scripts and database files listed as supporting files.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve(import.meta.dirname, '../dist');
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? 'Ritrovo demo';
const script = /<script type="module"[^>]*src="\.\/([^"]+)"/.exec(html)?.[1];
const css = /<link rel="stylesheet"[^>]*href="\.\/([^"]+)"/.exec(html)?.[1];
if (!script || !css) throw new Error('index.html inatteso: script o foglio di stile non trovati');

const style = await readFile(path.join(dist, css), 'utf8');
const page = `<title>${title}</title>
<style>
${style}
</style>
<div id="root"></div>
<script type="module" src="${script}"></script>
`;
const out = path.join(dist, 'artifact');
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'index.html'), page);

const files = {};
for (const f of await readdir(path.join(dist, 'assets'))) {
  if (f.endsWith('.css') || f.endsWith('.map')) continue;
  if (!/\.(js|wasm)$/.test(f)) throw new Error(`Tipo di file non pubblicabile come artifact: ${f}`);
  files[`assets/${f}`] = path.relative(process.cwd(), path.join(dist, 'assets', f));
}
await writeFile(path.join(out, 'files.json'), JSON.stringify(files, null, 2));
console.log(`Pagina: ${path.relative(process.cwd(), path.join(out, 'index.html'))} (${(page.length / 1024).toFixed(0)} KB), ${Object.keys(files).length} file di supporto`);
