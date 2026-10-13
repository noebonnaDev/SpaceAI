import type { PublicConfig } from '@ritrovo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { apiScope } from '../config.js';
import { DEFAULT_ADDIN_ID, loadManifestTemplate, renderAddinManifest } from '../addin-manifest.js';
import { userDto, type UserRow } from '../domain/users.js';
import type { ChangeNotification } from '../graph/types.js';

export async function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/health', async () => {
    await ctx.db.query('select 1');
    return { status: 'ok', graphMode: ctx.graph.mode, authMode: ctx.config.authMode, time: ctx.clock.now().toISOString() };
  });

  app.get('/api/config', async (): Promise<PublicConfig> => ({
    appName: ctx.config.appName,
    authMode: ctx.config.authMode,
    graphMode: ctx.graph.mode,
    tenantId: ctx.config.entra.tenantId,
    clientId: ctx.config.entra.clientId,
    apiScope: apiScope(ctx.config),
    timezone: ctx.config.timezone,
    locale: 'it-IT',
    publicBaseUrl: ctx.config.publicBaseUrl,
  }));

  if (ctx.config.authMode === 'dev') {
    app.get('/api/auth/dev-users', async () => {
      const rows = (await ctx.db.query<UserRow>('select * from app_user where is_active order by role desc, display_name')).rows;
      return rows.map((u) => userDto(u));
    });
    app.post('/api/auth/dev-login', async (req) => {
      const { email } = z.object({ email: z.string().email() }).parse(req.body);
      const { token, actor } = await ctx.auth.devLogin(email);
      return { token, user: userDto(actor.user, actor.role) };
    });
  }

  // Outlook add-in manifest for this deployment: usable as "manifest URL" in Microsoft 365 admin center > Integrated apps.
  app.get('/addin/manifest.xml', async (_req, reply) => {
    if (!ctx.config.publicBaseUrl.startsWith('https://')) {
      return reply.code(409).send({ code: 'HTTPS_REQUIRED', message: "Il manifest dell'add-in richiede PUBLIC_BASE_URL in HTTPS." });
    }
    const template = loadManifestTemplate();
    if (!template) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Template del manifest non trovato.' });
    const xml = renderAddinManifest(template, ctx.config.publicBaseUrl, process.env.ADDIN_ID || DEFAULT_ADDIN_ID, ctx.config.appName);
    reply.header('Content-Disposition', 'inline; filename="manifest.xml"');
    return reply.type('application/xml; charset=utf-8').send(xml);
  });

  // Microsoft Graph change notifications. The subscription handshake sends ?validationToken=... and expects it back as text.
  const handle = async (req: any, reply: any) => {
    const validationToken = (req.query as Record<string, string | undefined>).validationToken;
    if (validationToken) return reply.code(200).type('text/plain').send(validationToken);
    const body = (req.body ?? {}) as { value?: ChangeNotification[] };
    const items = Array.isArray(body.value) ? body.value : [];
    await ctx.sync.handleNotifications(items);
    return reply.code(202).send();
  };
  app.post('/api/graph/notifications', handle);
  app.post('/api/graph/lifecycle', handle);
}
