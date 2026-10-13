import type { JWTVerifyGetKey } from 'jose';
import { ZodError } from 'zod';
import { Authenticator } from './auth/auth.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/db.js';
import { BookingService, type Logger } from './domain/bookings.js';
import type { Clock } from './domain/clock.js';
import { AppError } from './domain/errors.js';
import { SyncService } from './domain/sync.js';
import type { GraphGateway } from './graph/types.js';

/** Everything a route needs. Built once, independent of the HTTP framework (Fastify on the server, a router in the demo). */
export interface AppContext {
  config: AppConfig;
  db: Db;
  graph: GraphGateway;
  clock: Clock;
  auth: Authenticator;
  bookings: BookingService;
  sync: SyncService;
  log: Logger;
}

export interface ContextOptions {
  config: AppConfig;
  db: Db;
  graph: GraphGateway;
  clock: Clock;
  log: Logger;
  jwks?: JWTVerifyGetKey;
  acceptancePolls?: number;
  acceptancePollMs?: number;
}

export function createContext(opts: ContextOptions): AppContext {
  const services = {
    db: opts.db,
    graph: opts.graph,
    clock: opts.clock,
    config: opts.config,
    log: opts.log,
    acceptancePolls: opts.acceptancePolls ?? (opts.graph.mode === 'live' ? 3 : 0),
    acceptancePollMs: opts.acceptancePollMs ?? 1500,
  };
  return {
    config: opts.config,
    db: opts.db,
    graph: opts.graph,
    clock: opts.clock,
    auth: new Authenticator(opts.db, opts.config, opts.jwks),
    bookings: new BookingService(services),
    sync: new SyncService(services),
    log: opts.log,
  };
}

/** Maps an error thrown by a route to the HTTP answer. Returns null for unexpected errors (logged and answered with 500). */
export function errorResponse(err: unknown): { status: number; body: { code: string; message: string; details?: unknown } } | null {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { code: err.code, message: err.message, details: err.details ?? null } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'VALIDATION',
        message: 'Dati non validi: ' + err.issues.map((i) => `${i.path.join('.') || 'richiesta'}: ${i.message}`).join('; '),
        details: err.issues,
      },
    };
  }
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return { status, body: { code: 'BAD_REQUEST', message: (err as Error).message } };
  return null;
}

export const INTERNAL_ERROR = { code: 'INTERNAL', message: 'Errore interno. Riprova tra poco.' };
