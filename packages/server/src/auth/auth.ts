import type { Role } from '@ritrovo/shared';
import { hasRole } from '@ritrovo/shared';
import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { Actor } from '../domain/bookings.js';
import { ForbiddenError, UnauthorizedError } from '../domain/errors.js';
import { authenticateKiosk, type KioskRow } from '../domain/kiosk.js';
import { getUserByEmail, getUserById, maxRole, upsertUserFromIdentity } from '../domain/users.js';

/** Entra ID app roles (value) mapped to Ritrovo roles. */
export const APP_ROLE_VALUES: Record<string, Role> = {
  'Ritrovo.Admin': 'amministratore',
  'Ritrovo.Reception': 'reception',
};

const DEV_ISSUER = 'ritrovo-dev';
const DEV_AUDIENCE = 'ritrovo';

declare module 'fastify' {
  interface FastifyRequest {
    actorCache?: Actor;
    kioskCache?: KioskRow;
  }
}

export class Authenticator {
  private readonly jwks: JWTVerifyGetKey | null;
  private readonly devKey: Uint8Array;

  constructor(
    private readonly db: Db,
    private readonly cfg: AppConfig,
    jwks?: JWTVerifyGetKey,
  ) {
    this.devKey = new TextEncoder().encode(cfg.devJwtSecret);
    if (cfg.authMode === 'entra') {
      this.jwks =
        jwks ?? createRemoteJWKSet(new URL(`${cfg.entra.authorityHost}/${cfg.entra.tenantId}/discovery/v2.0/keys`));
    } else {
      this.jwks = null;
    }
  }

  private bearer(req: FastifyRequest): string {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) throw new UnauthorizedError();
    return h.slice(7).trim();
  }

  /** Authenticates the request (cached per request) and enforces the minimum role. */
  async require(req: FastifyRequest, minRole: Role = 'utente'): Promise<Actor> {
    req.actorCache ??= await this.verify(this.bearer(req));
    if (!hasRole(req.actorCache.role, minRole)) {
      throw new ForbiddenError(
        minRole === 'amministratore'
          ? 'Il pannello di amministrazione è riservato agli amministratori.'
          : 'Funzione riservata alla reception e agli amministratori.',
      );
    }
    return req.actorCache;
  }

  async requireKiosk(req: FastifyRequest): Promise<KioskRow> {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Kiosk ')) throw new UnauthorizedError('Pannello non abbinato.');
    req.kioskCache ??= await authenticateKiosk(this.db, h.slice(6).trim());
    return req.kioskCache;
  }

  async verify(token: string): Promise<Actor> {
    if (this.cfg.authMode === 'dev') return this.verifyDev(token);
    return this.verifyEntra(token);
  }

  private async verifyDev(token: string): Promise<Actor> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.devKey, { issuer: DEV_ISSUER, audience: DEV_AUDIENCE, algorithms: ['HS256'] }));
    } catch {
      throw new UnauthorizedError('Sessione demo scaduta o non valida.');
    }
    const user = payload.sub ? await getUserById(this.db, payload.sub) : null;
    if (!user || !user.is_active) throw new UnauthorizedError('Utente demo non trovato.');
    return { user, role: user.role, token };
  }

  private async verifyEntra(token: string): Promise<Actor> {
    const { tenantId, clientId, apiScopeName, authorityHost } = this.cfg.entra;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks!, {
        issuer: [`${authorityHost}/${tenantId}/v2.0`, `https://sts.windows.net/${tenantId}/`],
        audience: [clientId!, `api://${clientId}`],
        algorithms: ['RS256'],
        clockTolerance: 120,
      }));
    } catch (err) {
      throw new UnauthorizedError(`Token non valido: ${(err as Error).message}`);
    }
    if (payload.tid !== tenantId) throw new UnauthorizedError('Token emesso per un altro tenant.');
    const scopes = String(payload.scp ?? '').split(' ');
    if (!scopes.includes(apiScopeName)) throw new UnauthorizedError(`Il token non contiene lo scope ${apiScopeName}.`);
    const email = String(payload.preferred_username ?? payload.upn ?? payload.email ?? '').toLowerCase();
    if (!email) throw new UnauthorizedError('Il token non contiene il nome utente.');
    const user = await upsertUserFromIdentity(
      this.db,
      { oid: typeof payload.oid === 'string' ? payload.oid : null, email, name: String(payload.name ?? email) },
      this.cfg.initialAdminEmails,
    );
    if (!user.is_active) throw new ForbiddenError('Utente disattivato.');
    let role: Role = user.role;
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
    for (const r of roles) if (APP_ROLE_VALUES[r]) role = maxRole(role, APP_ROLE_VALUES[r]!);
    return { user, role, token };
  }

  /** Demo login (AUTH_MODE=dev with GRAPH_MODE=mock only). */
  async devLogin(email: string): Promise<{ token: string; actor: Actor }> {
    if (this.cfg.authMode !== 'dev') throw new ForbiddenError('Accesso demo disattivato.');
    const user = await getUserByEmail(this.db, email);
    if (!user) throw new UnauthorizedError('Utente demo non trovato.');
    const token = await new SignJWT({ email: user.email, name: user.display_name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(DEV_ISSUER)
      .setAudience(DEV_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(this.devKey);
    return { token, actor: { user, role: user.role, token } };
  }
}
