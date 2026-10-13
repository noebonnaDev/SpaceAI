import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { DateTime } from 'luxon';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPgDb, createPgliteDb, type Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { ManualClock } from '../src/domain/clock.js';
import { FakeExchange } from '../src/graph/mock.js';
import type { GraphGateway } from '../src/graph/types.js';
import { registerMailboxes, seedDemo, type SeedIds } from '../src/seed/seed.js';

export const TZ = 'Europe/Rome';
/** Wednesday 14/10/2026 09:00 in Rome (UTC+2). */
export const DEFAULT_NOW = '2026-10-14T07:00:00.000Z';

export function local(date: string, time: string): Date {
  return DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toJSDate();
}

async function testDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const db = await createPgliteDb();
    return { db, cleanup: () => db.close() };
  }
  // Real PostgreSQL: every test gets its own schema.
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createPgDb(url);
  await admin.exec(`create schema ${schema}`);
  const sep = url.includes('?') ? '&' : '?';
  const db = createPgDb(`${url}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`);
  return {
    db,
    cleanup: async () => {
      await db.close();
      await admin.exec(`drop schema ${schema} cascade`);
      await admin.close();
    },
  };
}

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  db: Db;
  fake: FakeExchange;
  clock: ManualClock;
  ids: SeedIds;
  config: AppConfig;
  token(userKey: string): Promise<string>;
  api(userKey: string | null): Api;
  settle(): Promise<void>;
  close(): Promise<void>;
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, unknown>;
}

export interface Api {
  get<T = any>(url: string): Promise<ApiResponse<T>>;
  post<T = any>(url: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = any>(url: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = any>(url: string, body?: unknown): Promise<ApiResponse<T>>;
}

export interface HarnessOptions {
  now?: string;
  env?: Record<string, string>;
  graph?: GraphGateway;
  jwks?: JWTVerifyGetKey;
  seed?: boolean;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock(opts.now ?? DEFAULT_NOW);
  const { db, cleanup } = await testDb();
  await migrate(db);
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    GRAPH_MODE: 'mock',
    DEV_JWT_SECRET: 'test-secret-test-secret-test-secret',
    PUBLIC_BASE_URL: 'https://ritrovo.test',
    JOBS_ENABLED: 'false',
    ...opts.env,
  });
  const fake = new FakeExchange(clock, TZ);
  const { app, ctx } = await buildApp({ config, db, graph: opts.graph ?? fake, clock, jwks: opts.jwks });
  const ids =
    opts.seed === false
      ? ({ users: {}, resources: {}, buildingId: '', floors: ['', ''] } as SeedIds)
      : await seedDemo(db, { referenceDate: clock.now(), tz: TZ, history: true, upcoming: null });
  await registerMailboxes(fake, db);
  fake.sink = async (body) => {
    await app.inject({ method: 'POST', url: '/api/graph/notifications', payload: body });
  };
  if (opts.seed !== false) await ctx.sync.ensureSubscriptions();

  const tokens = new Map<string, string>();
  const token = async (userKey: string) => {
    if (!tokens.has(userKey)) {
      const email = userKey.includes('@') ? userKey : `${userKey}@ufficio.example`;
      const res = await app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { email } });
      if (res.statusCode !== 200) throw new Error(`login failed for ${userKey}: ${res.body}`);
      tokens.set(userKey, res.json().token);
    }
    return tokens.get(userKey)!;
  };
  const call = async (userKey: string | null, method: string, url: string, body?: unknown): Promise<ApiResponse> => {
    const headers: Record<string, string> = {};
    if (userKey) headers.authorization = `Bearer ${await token(userKey)}`;
    const res = await app.inject({ method: method as any, url, headers, payload: body as any });
    let parsed: unknown = null;
    try {
      parsed = res.json();
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed, text: res.body, headers: res.headers };
  };
  const api = (userKey: string | null): Api => ({
    get: (url) => call(userKey, 'GET', url),
    post: (url, body) => call(userKey, 'POST', url, body ?? {}),
    patch: (url, body) => call(userKey, 'PATCH', url, body ?? {}),
    put: (url, body) => call(userKey, 'PUT', url, body ?? {}),
  });
  return {
    app,
    ctx,
    db,
    fake,
    clock,
    ids,
    config,
    token,
    api,
    settle: async () => {
      for (let i = 0; i < 3; i++) {
        await fake.flush();
        await ctx.sync.idle();
      }
    },
    close: async () => {
      await ctx.sync.idle();
      await app.close();
      await cleanup();
    },
  };
}
