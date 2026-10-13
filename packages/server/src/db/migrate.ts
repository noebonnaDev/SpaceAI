import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './apply-migrations.js';
import type { Db } from './db.js';

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout: src/db/migrate.ts -> src/db/migrations. Bundle layout: dist/index.js -> dist/migrations.
  return path.join(here, 'migrations');
}

export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  const migrations = await Promise.all(files.map(async (version) => ({ version, sql: await readFile(path.join(dir, version), 'utf8') })));
  return applyMigrations(db, migrations);
}
