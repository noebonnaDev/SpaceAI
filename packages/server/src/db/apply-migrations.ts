import type { Db } from './db.js';

export interface Migration {
  /** File name, e.g. 001_init.sql: also the version recorded in schema_migrations. */
  version: string;
  sql: string;
}

/** Applies, in order, the migrations not yet recorded. Pure SQL: shared by the server and the in-browser demo. */
export async function applyMigrations(db: Db, migrations: Migration[]): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`);
  const done = new Set((await db.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
  const applied: string[] = [];
  for (const m of [...migrations].sort((a, b) => a.version.localeCompare(b.version))) {
    if (done.has(m.version)) continue;
    await db.exec(`begin;\n${m.sql}\ninsert into schema_migrations(version) values ('${m.version.replace(/'/g, "''")}');\ncommit;`);
    applied.push(m.version);
  }
  return applied;
}
