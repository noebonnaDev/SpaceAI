import type { DemoBackend } from './backend';

/** Routes the app's same-origin /api calls to the in-page backend; every other request goes to the network as usual. */
export function interceptFetch(backend: DemoBackend): void {
  const networkFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return networkFetch(input, init);

    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? 'GET';
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: string | null = null;
    if (typeof init?.body === 'string') body = init.body;
    else if (init?.body != null) body = await new Response(init.body).text();
    else if (request && !['GET', 'HEAD'].includes(method.toUpperCase())) body = await request.text();

    const res = await backend.handle(method, url.pathname + url.search, headers, body);
    return new Response(res.status === 204 ? null : (res.body as BodyInit | null), { status: res.status, headers: res.headers });
  };
}
