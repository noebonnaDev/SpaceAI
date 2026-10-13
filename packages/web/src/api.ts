import { t } from './i18n';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: any = null,
  ) {
    super(message);
  }
}

export type TokenSource = () => Promise<string | null>;

/** Small fetch wrapper: JSON in/out, Italian error messages from the server, bearer token from the auth layer. */
export function createApi(getToken: TokenSource, scheme: 'Bearer' | 'Kiosk' = 'Bearer') {
  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `${scheme} ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK', t('errors.network'));
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const fallback = res.status === 401 ? t('errors.session') : res.status === 403 ? t('errors.forbidden') : t('common.error');
      throw new ApiError(res.status, json?.code ?? `HTTP${res.status}`, json?.message ?? fallback, json?.details ?? null);
    }
    return json as T;
  }
  return {
    get: <T>(url: string) => request<T>('GET', url),
    post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
    put: <T>(url: string, body: unknown = {}) => request<T>('PUT', url, body),
    patch: <T>(url: string, body: unknown = {}) => request<T>('PATCH', url, body),
    del: <T>(url: string) => request<T>('DELETE', url),
    /** Downloads a file (e.g. CSV) with the auth header. */
    async download(url: string, filename: string) {
      const token = await getToken();
      const res = await fetch(url, { headers: token ? { Authorization: `${scheme} ${token}` } : {} });
      if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD', t('common.error'));
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    async text(url: string): Promise<string> {
      const token = await getToken();
      const res = await fetch(url, { headers: token ? { Authorization: `${scheme} ${token}` } : {} });
      if (!res.ok) throw new ApiError(res.status, 'HTTP', t('common.error'));
      return res.text();
    },
  };
}

export type Api = ReturnType<typeof createApi>;
