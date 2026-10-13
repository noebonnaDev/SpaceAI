import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { systemClock } from './domain/clock.js';
import { startJobs } from './jobs/scheduler.js';
import { GraphHttp, LiveGraphGateway, MsalTokenProvider } from './graph/live.js';
import { FakeExchange } from './graph/mock.js';
import type { GraphGateway } from './graph/types.js';
import { hydrateFakeFromDb } from './seed/hydrate.js';
import { loadSeedIds, registerMailboxes, seedDemo, seedUpcoming } from './seed/seed.js';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[Ritrovo] ${err.message}\nControlla il file .env (vedi .env.example e docs/03-installazione.md).\n`);
      process.exit(1);
    }
    throw err;
  }
  if (!config.databaseUrl) {
    console.warn('[Ritrovo] DATABASE_URL non impostato: uso un database temporaneo in memoria (solo per prove).');
  }
  const db = await createDb(config.databaseUrl);
  const applied = await migrate(db);
  if (applied.length) console.info(`[Ritrovo] Migrazioni applicate: ${applied.join(', ')}`);

  const clock = systemClock;
  let fake: FakeExchange | null = null;
  let graph: GraphGateway;
  if (config.graphMode === 'mock') {
    fake = new FakeExchange(clock, config.timezone);
    graph = fake;
  } else {
    const logger = { warn: (o: unknown, m?: string) => console.warn('[Graph]', m ?? '', o) };
    graph = new LiveGraphGateway(
      new GraphHttp({ baseUrl: config.graphBaseUrl, tokens: new MsalTokenProvider(config), logger }),
      config.timezone,
      config.windowsTimeZone,
    );
  }

  const { app, ctx } = await buildApp({ config, db, graph, clock, logger: { level: config.logLevel } });

  if (fake) {
    const before = (await db.query<{ n: number }>('select count(*)::int as n from booking')).rows[0]!.n;
    if (config.seedDemoData) await seedDemo(db, { referenceDate: clock.now(), tz: config.timezone, history: true, upcoming: null });
    await registerMailboxes(fake, db);
    const hydrated = await hydrateFakeFromDb(fake, db, clock);
    if (config.seedDemoData && before === 0) {
      await seedUpcoming(ctx.bookings, await loadSeedIds(db), clock.now(), config.timezone);
    }
    // Simulated change notifications go through the real webhook endpoint.
    fake.sink = async (body) => {
      await app.inject({ method: 'POST', url: '/api/graph/notifications', payload: body });
    };
    app.log.warn(
      { hydrated },
      'GRAPH_MODE=mock: Exchange è simulato in memoria (solo test e demo). In produzione usa GRAPH_MODE=live.',
    );
  } else if (config.seedDemoData) {
    app.log.warn('SEED_DEMO_DATA ignorato in modalità live: i dati di esempio non vengono mai scritti su un tenant reale.');
  }

  const stopJobs = config.jobsEnabled ? startJobs(ctx) : () => undefined;
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`Ritrovo in ascolto su ${config.host}:${config.port} (pubblico: ${config.publicBaseUrl})`);

  const shutdown = async (signal: string) => {
    app.log.info(`Arresto (${signal})...`);
    stopJobs();
    await app.close().catch(() => undefined);
    await ctx.sync.idle().catch(() => undefined);
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Ritrovo] Avvio non riuscito:', err);
  process.exit(1);
});
