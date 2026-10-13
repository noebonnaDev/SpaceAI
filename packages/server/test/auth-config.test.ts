/** Entra ID token validation, roles from app roles, configuration safety checks. */
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { createHarness, type Harness } from './harness.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let h: Harness;
let privateKey: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
  h = await createHarness({
    env: {
      AUTH_MODE: 'entra',
      GRAPH_MODE: 'mock',
      ENTRA_TENANT_ID: TENANT,
      ENTRA_CLIENT_ID: CLIENT,
      INITIAL_ADMIN_EMAILS: 'admin.iniziale@ufficio.example',
    },
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
});
afterAll(async () => {
  await h.close();
});

async function token(claims: Record<string, unknown>, opts: { key?: CryptoKey; aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT({ tid: TENANT, scp: 'access_as_user', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? `https://login.microsoftonline.com/${TENANT}/v2.0`)
    .setAudience(opts.aud ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? privateKey);
}

const me = (t: string) => h.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${t}` } });

describe('Autenticazione Entra ID', () => {
  it('accetta un token valido per l\'API, crea l\'utente al primo accesso', async () => {
    const res = await me(await token({ oid: 'oid-nuovo', preferred_username: 'Nuovo.Utente@ufficio.example', name: 'Nuovo Utente' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'nuovo.utente@ufficio.example', displayName: 'Nuovo Utente', role: 'utente' });
    // Token v1 (audience api://client-id, issuer sts.windows.net) is accepted as well.
    const v1 = await me(await token({ oid: 'oid-nuovo', upn: 'nuovo.utente@ufficio.example', name: 'Nuovo Utente' }, { aud: `api://${CLIENT}`, iss: `https://sts.windows.net/${TENANT}/` }));
    expect(v1.statusCode).toBe(200);
  });

  it('i ruoli app di Entra ID danno i ruoli reception e amministratore', async () => {
    const admin = await me(await token({ oid: 'o-a', preferred_username: 'capo@ufficio.example', name: 'Capo', roles: ['Ritrovo.Admin'] }));
    expect(admin.json().role).toBe('amministratore');
    const rec = await me(await token({ oid: 'o-r', preferred_username: 'banco@ufficio.example', name: 'Banco', roles: ['Ritrovo.Reception'] }));
    expect(rec.json().role).toBe('reception');
    const initial = await me(await token({ oid: 'o-i', preferred_username: 'admin.iniziale@ufficio.example', name: 'Iniziale' }));
    expect(initial.json().role).toBe('amministratore');
  });

  it('rifiuta firma errata, audience errata, altro tenant, scope mancante e token scaduto', async () => {
    const base = { oid: 'o-x', preferred_username: 'x@ufficio.example', name: 'X' };
    expect((await me(await token(base, { key: otherKey }))).statusCode).toBe(401);
    expect((await me(await token(base, { aud: 'altra-app' }))).statusCode).toBe(401);
    expect((await me(await token({ ...base, tid: 'altro-tenant' }))).statusCode).toBe(401);
    expect((await me(await token({ ...base, scp: 'User.Read' }))).statusCode).toBe(401);
    expect((await me(await token(base, { exp: '-10m' }))).statusCode).toBe(401);
    expect((await me('non-un-jwt')).statusCode).toBe(401);
  });

  it("l'accesso demo è disattivato in modalità Entra", async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/auth/dev-login', payload: { email: 'giulia.rinaldi@ufficio.example' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('Configurazione', () => {
  it('rifiuta l\'accesso demo con Graph reale e in produzione', () => {
    expect(() => loadConfig({ AUTH_MODE: 'dev', GRAPH_MODE: 'live', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'x' })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: 'dev', GRAPH_MODE: 'mock', NODE_ENV: 'production' })).toThrow(ConfigError);
  });

  it('in modalità live richiede tenant, client e credenziale', () => {
    expect(() => loadConfig({ AUTH_MODE: 'entra', GRAPH_MODE: 'live', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT })).toThrow(/ENTRA_CLIENT_SECRET/);
    const ok = loadConfig({ AUTH_MODE: 'entra', GRAPH_MODE: 'live', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 'x', PUBLIC_BASE_URL: 'https://ritrovo.contoso.example' });
    expect(ok.graphMode).toBe('live');
  });

  it('i webhook richiedono un URL pubblico HTTPS', () => {
    expect(() => loadConfig({ GRAPH_WEBHOOKS_ENABLED: 'true', PUBLIC_BASE_URL: 'http://localhost:8080' })).toThrow(/HTTPS/);
  });
});
