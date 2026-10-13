import type { IPublicClientApplication } from '@azure/msal-browser';
import { devTokenStore, loadPublicConfig } from '../auth';

/**
 * Single sign-on inside Outlook with nested app authentication (NAA): Outlook brokers the token for
 * Ritrovo's API scope. If NAA is not available (old clients), MSAL falls back to a standard client and a popup.
 * Legacy Exchange identity/callback tokens are never used.
 */
let pca: IPublicClientApplication | null = null;

async function nestable(): Promise<IPublicClientApplication> {
  if (pca) return pca;
  const cfg = await loadPublicConfig();
  const { createNestablePublicClientApplication } = await import('@azure/msal-browser');
  pca = await createNestablePublicClientApplication({
    auth: {
      clientId: cfg.clientId!,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: `${window.location.origin}/redirect.html`,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  return pca;
}

export function naaSupported(): boolean {
  try {
    return Boolean(Office?.context?.requirements?.isSetSupported('NestedAppAuth', '1.1'));
  } catch {
    return false;
  }
}

export async function addinToken(): Promise<string | null> {
  const cfg = await loadPublicConfig();
  if (cfg.authMode === 'dev') return devTokenStore.get();
  const app = await nestable();
  const request = { scopes: [cfg.apiScope!] };
  try {
    return (await app.acquireTokenSilent(request)).accessToken;
  } catch {
    // Interaction required (consent, MFA) or no cached account outside NAA: ask the user.
    return (await app.acquireTokenPopup(request)).accessToken;
  }
}
