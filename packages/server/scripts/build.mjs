// Bundles the server into dist/index.js (dependencies stay external) and copies the SQL migrations.
import { build } from 'esbuild';
import { cp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@ritrovo/'));

await rm(path.join(root, 'dist'), { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [...external, '@electric-sql/pglite'],
  logLevel: 'info',
});
await cp(path.join(root, 'src/db/migrations'), path.join(root, 'dist/migrations'), { recursive: true });
console.log('Build del server completata: dist/index.js');
