import type { IPublicClientApplication } from '@azure/msal-browser';
import type { PublicConfig, UserDto } from '@ritrovo/shared';

/**
 * Authentication for the web app.
 * - entra: Microsoft Entra ID single sign-on with MSAL.js (redirect flow, MSAL v5 redirect bridge at /redirect.html);
 *   the access token is requested for Ritrovo's own API scope (api://<client-id>/access_as_user).
 * - dev: demo login with sample users, only available when the server runs with simulated Exchange.
 */
const DEV_TOKEN_KEY = 'ritrovo.devToken';

/** Demo session token: sessionStorage when available (it can throw in sandboxed or private views), memory otherwise. */
const memoryStore = new Map<string, string>();
export const devTokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(DEV_TOKEN_KEY);
    } catch {
      return memoryStore.get(DEV_TOKEN_KEY) ?? null;
    }
  },
  set(token: string): void {
    memoryStore.set(DEV_TOKEN_KEY, token);
    try {
      sessionStorage.setItem(DEV_TOKEN_KEY, token);
    } catch {
      /* memory only */
    }
  },
  clear(): void {
    memoryStore.delete(DEV_TOKEN_KEY);
    try {
      sessionStorage.removeItem(DEV_TOKEN_KEY);
    } catch {
      /* memory only */
    }
  },
};

/** What happens after a demo sign-out: by default back to the start page. The in-browser demo replaces it. */
let afterDevSignOut = () => window.location.assign('/');
export function setAfterDevSignOut(handler: () => void): void {
  afterDevSignOut = handler;
}

let config: PublicConfig | null = null;
let msal: IPublicClientApplication | null = null;

export async function loadPublicConfig(): Promise<PublicConfig> {
  if (config) return config;
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('Configurazione non disponibile');
  config = (await res.json()) as PublicConfig;
  return config;
}

export function publicConfig(): PublicConfig {
  if (!config) throw new Error('Configurazione non ancora caricata');
  return config;
}

async function msalInstance(): Promise<IPublicClientApplication> {
  if (msal) return msal;
  const cfg = publicConfig();
  const { createStandardPublicClientApplication } = await import('@azure/msal-browser');
  msal = await createStandardPublicClientApplication({
    auth: {
      clientId: cfg.clientId!,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: `${window.location.origin}/redirect.html`,
      postLogoutRedirectUri: `${window.location.origin}/`,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  return msal;
}

/** Call once at start-up: completes a pending redirect sign-in. Returns true when a user is signed in. */
export async function initAuth(): Promise<boolean> {
  const cfg = await loadPublicConfig();
  if (cfg.authMode === 'dev') return Boolean(devTokenStore.get());
  const pca = await msalInstance();
  const result = await pca.handleRedirectPromise();
  if (result?.account) pca.setActiveAccount(result.account);
  const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (account) pca.setActiveAccount(account);
  return Boolean(account);
}

export async function signInWithMicrosoft(): Promise<void> {
  const pca = await msalInstance();
  await pca.loginRedirect({ scopes: [publicConfig().apiScope!], redirectStartPage: window.location.href });
}

export async function devSignIn(email: string): Promise<UserDto> {
  const res = await fetch('/api/auth/dev-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error('Accesso demo non riuscito');
  const body = (await res.json()) as { token: string; user: UserDto };
  devTokenStore.set(body.token);
  return body.user;
}

export async function getAccessToken(): Promise<string | null> {
  const cfg = await loadPublicConfig();
  if (cfg.authMode === 'dev') return devTokenStore.get();
  const pca = await msalInstance();
  const account = pca.getActiveAccount() ?? pca.getAllAccounts()[0];
  if (!account) return null;
  try {
    const r = await pca.acquireTokenSilent({ scopes: [cfg.apiScope!], account });
    return r.accessToken;
  } catch (err) {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    if (err instanceof InteractionRequiredAuthError) {
      await pca.acquireTokenRedirect({ scopes: [cfg.apiScope!], account });
    }
    return null;
  }
}

export async function signOut(): Promise<void> {
  const cfg = await loadPublicConfig();
  if (cfg.authMode === 'dev') {
    devTokenStore.clear();
    afterDevSignOut();
    return;
  }
  const pca = await msalInstance();
  await pca.logoutRedirect({ account: pca.getActiveAccount() ?? undefined });
}
