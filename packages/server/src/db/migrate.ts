import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

export function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return process.env.MIGRATIONS_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout: src/db/migrate.ts -> src/db/migrations. Bundle layout: dist/index.js -> dist/migrations.
  return path.join(here, 'migrations');
}

export async function migrate(db: Db, dir = migrationsDir()): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await db.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.exec(`begin;\n${sql}\ninsert into schema_migrations(version) values ('${file.replace(/'/g, "''")}');\ncommit;`);
    applied.push(file);
  }
  return applied;
}
