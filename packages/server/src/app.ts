import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import { createContext, errorResponse, INTERNAL_ERROR, type AppContext } from './app-context.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/db.js';
import type { Logger } from './domain/bookings.js';
import type { Clock } from './domain/clock.js';
import type { GraphGateway } from './graph/types.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerKioskRoutes } from './routes/kiosk.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerUserRoutes } from './routes/user.js';

export type { AppContext } from './app-context.js';

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
  const ctx: AppContext = createContext({ ...opts, log });

  app.setErrorHandler((err, req, reply) => {
    const known = errorResponse(err);
    if (known) return reply.code(known.status).send(known.body);
    req.log.error({ err }, 'Errore non gestito');
    return reply.code(500).send(INTERNAL_ERROR);
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
