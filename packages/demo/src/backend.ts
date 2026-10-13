import { createContext, type AppContext } from '../../server/src/app-context';
import { loadConfig } from '../../server/src/config';
import { applyMigrations } from '../../server/src/db/apply-migrations';
import { createPgliteDb } from '../../server/src/db/db';
import initSql from '../../server/src/db/migrations/001_init.sql?raw';
import type { Logger } from '../../server/src/domain/bookings';
import { systemClock } from '../../server/src/domain/clock';
import { FakeExchange } from '../../server/src/graph/mock';
import { startJobs } from '../../server/src/jobs/scheduler';
import { registerAdminRoutes } from '../../server/src/routes/admin';
import { registerKioskRoutes } from '../../server/src/routes/kiosk';
import { registerPublicRoutes } from '../../server/src/routes/public';
import { registerUserRoutes } from '../../server/src/routes/user';
import { hydrateFakeFromDb } from '../../server/src/seed/hydrate';
import { loadSeedIds, registerMailboxes, seedDemo, seedUpcoming } from '../../server/src/seed/seed';
import { DemoRouter, type DemoResponse } from './http';

export interface DemoBackend {
  handle(method: string, url: string, headers?: Record<string, string>, body?: string | null): Promise<DemoResponse>;
  ctx: AppContext;
  /** Stops the scheduled jobs and closes the database. */
  stop(): Promise<void>;
}

export interface BackendOptions {
  /** Base of the QR and pairing links shown in the app. Defaults to the page's origin. */
  publicBaseUrl?: string;
  progress?: (step: string) => void;
}

/**
 * Starts Ritrovo's real server code inside the page: PostgreSQL (PGlite, WebAssembly) in memory,
 * Exchange simulated by the same FakeExchange used by the tests, demo users and sample data.
 * It mirrors what the server does at start-up with GRAPH_MODE=mock and SEED_DEMO_DATA=true.
 */
export async function startBackend({ publicBaseUrl, progress = () => undefined }: BackendOptions = {}): Promise<DemoBackend> {
  const config = loadConfig({
    NODE_ENV: 'development',
    AUTH_MODE: 'dev',
    GRAPH_MODE: 'mock',
    SEED_DEMO_DATA: 'true',
    GRAPH_WEBHOOKS_ENABLED: 'false',
    PUBLIC_BASE_URL: publicBaseUrl ?? window.location.origin,
    LOG_LEVEL: 'warn',
  });
  const log: Logger = {
    info: () => undefined,
    warn: (o, m) => console.warn('[Ritrovo demo]', m ?? '', o),
    error: (o, m) => console.error('[Ritrovo demo]', m ?? '', o),
  };

  progress('database');
  const db = await createPgliteDb();
  await applyMigrations(db, [{ version: '001_init.sql', sql: initSql }]);

  const clock = systemClock;
  const fake = new FakeExchange(clock, config.timezone);
  const ctx = createContext({ config, db, graph: fake, clock, log });
  const router = new DemoRouter((err) => log.error({ err: String(err) }, 'Errore non gestito'));
  const app = router.asFastify();
  await registerPublicRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerKioskRoutes(app, ctx);

  progress('data');
  await seedDemo(db, { referenceDate: clock.now(), tz: config.timezone, history: true, upcoming: null });
  await registerMailboxes(fake, db);
  await hydrateFakeFromDb(fake, db, clock);
  await seedUpcoming(ctx.bookings, await loadSeedIds(db), clock.now(), config.timezone);
  // Simulated change notifications go through the real webhook endpoint, as on the server.
  fake.sink = async (body) => {
    await router.handle('POST', '/api/graph/notifications', { 'content-type': 'application/json' }, JSON.stringify(body));
  };

  progress('jobs');
  const stopJobs = startJobs(ctx);
  return {
    handle: (method, url, headers, body) => router.handle(method, url, headers, body),
    ctx,
    stop: async () => {
      stopJobs();
      await ctx.sync.idle().catch(() => undefined);
      await db.close();
    },
  };
}
