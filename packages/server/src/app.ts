import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { Authenticator } from './auth/auth.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/db.js';
import { BookingService, type Logger } from './domain/bookings.js';
import type { Clock } from './domain/clock.js';
import { AppError } from './domain/errors.js';
import { SyncService } from './domain/sync.js';
import type { GraphGateway } from './graph/types.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerKioskRoutes } from './routes/kiosk.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerUserRoutes } from './routes/user.js';
import type { JWTVerifyGetKey } from 'jose';

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

export interface BuildOptions {
  config: AppConfig;
  db: Db;
  graph: GraphGateway;
  clock: Clock;
  logger?: boolean | object;
  jwks?: JWTVerifyGetKey;
  acceptancePolls?: number;
  acceptancePollMs?: number;
}

const ADDIN_PREFIX = '/addin/';

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Request logs contain IP addresses (personal data): only with LOG_LEVEL=debug.
    disableRequestLogging: opts.config.logLevel !== 'debug',
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });
  const log: Logger = {
    info: (o, m) => app.log.info(o, m),
    warn: (o, m) => app.log.warn(o, m),
    error: (o, m) => app.log.error(o, m),
  };
  const services = {
    db: opts.db,
    graph: opts.graph,
    clock: opts.clock,
    config: opts.config,
    log,
    acceptancePolls: opts.acceptancePolls ?? (opts.graph.mode === 'live' ? 3 : 0),
    acceptancePollMs: opts.acceptancePollMs ?? 1500,
  };
  const ctx: AppContext = {
    config: opts.config,
    db: opts.db,
    graph: opts.graph,
    clock: opts.clock,
    auth: new Authenticator(opts.db, opts.config, opts.jwks),
    bookings: new BookingService(services),
    sync: new SyncService(services),
    log,
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ code: err.code, message: err.message, details: err.details ?? null });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        code: 'VALIDATION',
        message: 'Dati non validi: ' + err.issues.map((i) => `${i.path.join('.') || 'richiesta'}: ${i.message}`).join('; '),
        details: err.issues,
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
    req.log.error({ err }, 'Errore non gestito');
    return reply.code(500).send({ code: 'INTERNAL', message: 'Errore interno. Riprova tra poco.' });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    const url = req.url;
    if (url.startsWith('/api/') || url.startsWith('/redirect.html')) {
      // The MSAL redirect bridge receives authorization codes in its URL: never cache it.
      reply.header('Cache-Control', 'no-store');
    } else if (!url.startsWith(ADDIN_PREFIX)) {
      // The Outlook add-in pages are loaded by Outlook inside an iframe and use Office.js from Microsoft's CDN:
      // they must not carry frame restrictions. Everything else is locked down.
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
          "connect-src 'self' https://login.microsoftonline.com; frame-src https://login.microsoftonline.com; " +
          "frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
      );
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    }
    return payload;
  });

  await registerPublicRoutes(app, ctx);
  await registerUserRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerKioskRoutes(app, ctx);

  const webDir = opts.config.webDistDir ?? path.resolve(process.cwd(), '../web/dist');
  if (existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith(ADDIN_PREFIX) && !path.extname(req.url.split('?')[0]!)) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Risorsa non trovata.' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Risorsa non trovata.' }));
  }

  return { app, ctx };
}
