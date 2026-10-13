import type { AppContext } from '../app.js';
import { applyRetention } from '../domain/retention.js';
import { getSettings } from '../domain/settings.js';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

/**
 * In-process scheduler. Ritrovo is designed to run as a single instance for a small or mid-sized office;
 * each job is guarded against overlapping runs.
 */
export function startJobs(ctx: AppContext): () => void {
  const jobs: Job[] = [
    {
      name: 'rilascio-no-show',
      everyMs: 60_000,
      run: async () => {
        await ctx.bookings.releaseNoShows();
        await ctx.bookings.expireProposals();
        await ctx.bookings.retryExchangeReleases();
      },
    },
    { name: 'sincronizzazione-delta', everyMs: ctx.config.deltaIntervalSeconds * 1000, run: () => ctx.sync.syncAll() },
    { name: 'sottoscrizioni-graph', everyMs: 15 * 60_000, run: () => ctx.sync.ensureSubscriptions() },
    {
      name: 'conservazione-dati',
      everyMs: 6 * 3600_000,
      run: async () => applyRetention(ctx.db, await getSettings(ctx.db), ctx.clock.now()),
    },
  ];
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();
  const exec = (job: Job) => {
    if (running.has(job.name)) return;
    running.add(job.name);
    job
      .run()
      .catch((err) => ctx.log.error({ err: String(err), job: job.name }, 'Job non riuscito'))
      .finally(() => running.delete(job.name));
  };
  for (const job of jobs) {
    timers.push(setInterval(() => exec(job), job.everyMs));
    // First run shortly after start-up.
    timers.push(setTimeout(() => exec(job), 2_000));
  }
  return () => timers.forEach((t) => clearInterval(t));
}
