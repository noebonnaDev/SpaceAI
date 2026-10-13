import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'si'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().optional(),
  AUTH_MODE: z.enum(['entra', 'dev']).default('dev'),
  GRAPH_MODE: z.enum(['live', 'mock']).default('mock'),
  GRAPH_BASE_URL: z.string().url().default('https://graph.microsoft.com/v1.0'),
  ENTRA_AUTHORITY_HOST: z.string().url().default('https://login.microsoftonline.com'),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_CLIENT_CERT_PATH: z.string().optional(),
  ENTRA_CLIENT_KEY_PATH: z.string().optional(),
  API_SCOPE_NAME: z.string().default('access_as_user'),
  INITIAL_ADMIN_EMAILS: z.string().default(''),
  DEV_JWT_SECRET: z.string().optional(),
  GRAPH_WEBHOOKS_ENABLED: bool(false),
  GRAPH_DELTA_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
  GRAPH_WINDOWS_TIMEZONE: z.string().default('W. Europe Standard Time'),
  APP_TIMEZONE: z.string().default('Europe/Rome'),
  APP_NAME: z.string().default('Ritrovo'),
  SEED_DEMO_DATA: bool(false),
  JOBS_ENABLED: bool(true),
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  ALLOW_INSECURE_DEV_AUTH: bool(false),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: string;
  host: string;
  port: number;
  publicBaseUrl: string;
  databaseUrl: string | undefined;
  authMode: 'entra' | 'dev';
  graphMode: 'live' | 'mock';
  graphBaseUrl: string;
  entra: {
    authorityHost: string;
    tenantId: string | null;
    clientId: string | null;
    clientSecret: string | null;
    certPath: string | null;
    keyPath: string | null;
    apiScopeName: string;
  };
  initialAdminEmails: string[];
  devJwtSecret: string;
  webhooksEnabled: boolean;
  deltaIntervalSeconds: number;
  windowsTimeZone: string;
  timezone: string;
  appName: string;
  seedDemoData: boolean;
  jobsEnabled: boolean;
  webDistDir: string | undefined;
  logLevel: string;
}

export class ConfigError extends Error {}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Configurazione non valida: ${issues}`);
  }
  const e = parsed.data;
  const cfg: AppConfig = {
    env: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    databaseUrl: e.DATABASE_URL,
    authMode: e.AUTH_MODE,
    graphMode: e.GRAPH_MODE,
    graphBaseUrl: e.GRAPH_BASE_URL.replace(/\/+$/, ''),
    entra: {
      authorityHost: e.ENTRA_AUTHORITY_HOST.replace(/\/+$/, ''),
      tenantId: e.ENTRA_TENANT_ID || null,
      clientId: e.ENTRA_CLIENT_ID || null,
      clientSecret: e.ENTRA_CLIENT_SECRET || null,
      certPath: e.ENTRA_CLIENT_CERT_PATH || null,
      keyPath: e.ENTRA_CLIENT_KEY_PATH || null,
      apiScopeName: e.API_SCOPE_NAME,
    },
    initialAdminEmails: e.INITIAL_ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    devJwtSecret: e.DEV_JWT_SECRET || randomBytes(32).toString('hex'),
    webhooksEnabled: e.GRAPH_WEBHOOKS_ENABLED,
    deltaIntervalSeconds: e.GRAPH_DELTA_INTERVAL_SECONDS,
    windowsTimeZone: e.GRAPH_WINDOWS_TIMEZONE,
    timezone: e.APP_TIMEZONE,
    appName: e.APP_NAME,
    seedDemoData: e.SEED_DEMO_DATA,
    jobsEnabled: e.JOBS_ENABLED,
    webDistDir: e.WEB_DIST_DIR,
    logLevel: e.LOG_LEVEL,
  };
  validateConfig(cfg, e.ALLOW_INSECURE_DEV_AUTH);
  return cfg;
}

/** Refuses unsafe combinations: demo login against a real tenant, or live mode without credentials. */
export function validateConfig(cfg: AppConfig, allowInsecureDevAuth = false): void {
  if (cfg.authMode === 'dev' && cfg.graphMode === 'live') {
    throw new ConfigError('AUTH_MODE=dev è ammesso solo con GRAPH_MODE=mock (accesso demo senza Entra ID).');
  }
  if (cfg.authMode === 'dev' && cfg.env === 'production' && !allowInsecureDevAuth) {
    throw new ConfigError(
      'AUTH_MODE=dev non è ammesso con NODE_ENV=production. Usa AUTH_MODE=entra oppure imposta ALLOW_INSECURE_DEV_AUTH=true solo per una demo isolata.',
    );
  }
  if (cfg.authMode === 'entra' || cfg.graphMode === 'live') {
    const missing: string[] = [];
    if (!cfg.entra.tenantId) missing.push('ENTRA_TENANT_ID');
    if (!cfg.entra.clientId) missing.push('ENTRA_CLIENT_ID');
    if (cfg.graphMode === 'live' && !cfg.entra.clientSecret && !(cfg.entra.certPath && cfg.entra.keyPath)) {
      missing.push('ENTRA_CLIENT_SECRET oppure ENTRA_CLIENT_CERT_PATH + ENTRA_CLIENT_KEY_PATH');
    }
    if (missing.length) {
      throw new ConfigError(`Variabili mancanti: ${missing.join(', ')}`);
    }
  }
  if (cfg.webhooksEnabled && !cfg.publicBaseUrl.startsWith('https://')) {
    throw new ConfigError('GRAPH_WEBHOOKS_ENABLED=true richiede PUBLIC_BASE_URL in HTTPS raggiungibile da Internet.');
  }
}

export function apiScope(cfg: AppConfig): string | null {
  return cfg.entra.clientId ? `api://${cfg.entra.clientId}/${cfg.entra.apiScopeName}` : null;
}
