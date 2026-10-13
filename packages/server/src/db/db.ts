import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Runs a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    kind: 'pg',
    async query<T>(text: string, params?: unknown[]) {
      const r = await pool.query(text, params as any[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? r.rows.length };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q: Queryable = {
          async query<R>(text: string, params?: unknown[]) {
            const r = await client.query(text, params as any[]);
            return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
          },
        };
        const result = await fn(q);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** In-process PostgreSQL (WebAssembly) used by the automated tests when no TEST_DATABASE_URL is set. */
export async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  // PGlite runs one statement at a time: serialise transactions to mimic row locking semantics.
  let chain: Promise<unknown> = Promise.resolve();
  const wrap = (r: { rows: any[]; affectedRows?: number }) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length });
  return {
    kind: 'pglite',
    async query<T>(text: string, params?: unknown[]) {
      await chain;
      return wrap(await db.query<T>(text, params as any[])) as QueryResult<T>;
    },
    async exec(sql: string) {
      await chain;
      await db.exec(sql);
    },
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const run = chain.then(() =>
        db.transaction(async (t) =>
          fn({
            async query<R>(text: string, params?: unknown[]) {
              return wrap(await t.query<R>(text, params as any[])) as QueryResult<R>;
            },
          }),
        ),
      );
      chain = run.catch(() => undefined);
      return run;
    },
    async close() {
      await db.close();
    },
  };
}

export async function createDb(databaseUrl: string | undefined): Promise<Db> {
  if (databaseUrl) return createPgDb(databaseUrl);
  return createPgliteDb();
}
