import type { FastifyInstance } from 'fastify';
import { errorResponse, INTERNAL_ERROR } from '../../server/src/app-context';

/**
 * A minimal stand-in for Fastify, enough to mount Ritrovo's real route modules in the browser:
 * route registration with :params, query strings, JSON bodies, reply.code/header/type/send and the same error mapping.
 */
type Handler = (req: DemoRequest, reply: DemoReply) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export interface DemoRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  headers: Record<string, string>;
  [extra: string]: unknown;
}

export interface DemoResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array | null;
}

export class DemoReply {
  statusCode = 200;
  headers: Record<string, string> = {};
  payload: unknown = undefined;
  sent = false;

  code(status: number): this {
    this.statusCode = status;
    return this;
  }

  status(status: number): this {
    return this.code(status);
  }

  header(name: string, value: unknown): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  type(contentType: string): this {
    return this.header('content-type', contentType);
  }

  send(payload?: unknown): this {
    this.payload = payload;
    this.sent = true;
    return this;
  }
}

export class DemoRouter {
  private routes: Route[] = [];

  constructor(private readonly onError: (err: unknown) => void = () => undefined) {}

  private add(method: string, path: string, rest: unknown[]): void {
    const handler = rest[rest.length - 1] as Handler;
    const keys: string[] = [];
    const source = path
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
  }

  // Same call shapes as Fastify: (path, handler) or (path, options, handler).
  get(path: string, handler: Handler): void;
  get(path: string, options: object, handler: Handler): void;
  get(path: string, ...rest: unknown[]): void {
    this.add('GET', path, rest);
  }
  post(path: string, handler: Handler): void;
  post(path: string, options: object, handler: Handler): void;
  post(path: string, ...rest: unknown[]): void {
    this.add('POST', path, rest);
  }
  put(path: string, handler: Handler): void;
  put(path: string, options: object, handler: Handler): void;
  put(path: string, ...rest: unknown[]): void {
    this.add('PUT', path, rest);
  }
  patch(path: string, handler: Handler): void;
  patch(path: string, options: object, handler: Handler): void;
  patch(path: string, ...rest: unknown[]): void {
    this.add('PATCH', path, rest);
  }
  delete(path: string, handler: Handler): void;
  delete(path: string, options: object, handler: Handler): void;
  delete(path: string, ...rest: unknown[]): void {
    this.add('DELETE', path, rest);
  }

  /** The route modules are typed against Fastify; they only use the methods implemented here. */
  asFastify(): FastifyInstance {
    return this as unknown as FastifyInstance;
  }

  async handle(method: string, url: string, headers: Record<string, string> = {}, bodyText?: string | null): Promise<DemoResponse> {
    const parsed = new URL(url, 'https://demo.invalid');
    const upper = method.toUpperCase();
    let params: Record<string, string> = {};
    const route = this.routes.find((r) => {
      if (r.method !== upper) return false;
      const m = r.pattern.exec(parsed.pathname);
      if (!m) return false;
      params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      return true;
    });
    if (!route) return json(404, { code: 'NOT_FOUND', message: 'Risorsa non trovata.' });

    const query: Record<string, string | string[]> = {};
    for (const [k, v] of parsed.searchParams) {
      const prev = query[k];
      query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown;
    if (bodyText) {
      try {
        body = (lowerHeaders['content-type'] ?? '').includes('json') ? JSON.parse(bodyText) : bodyText;
      } catch {
        return json(400, { code: 'BAD_REQUEST', message: 'Corpo della richiesta non valido.' });
      }
    }
    const req: DemoRequest = { method: upper, url: parsed.pathname + parsed.search, params, query, body, headers: lowerHeaders };
    const reply = new DemoReply();
    try {
      const result = await route.handler(req, reply);
      const payload = reply.sent ? reply.payload : result === reply ? undefined : result;
      return serialize(reply.statusCode, reply.headers, payload);
    } catch (err) {
      const known = errorResponse(err);
      if (known) return json(known.status, known.body);
      this.onError(err);
      return json(500, INTERNAL_ERROR);
    }
  }
}

function json(status: number, value: unknown): DemoResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) };
}

function serialize(status: number, headers: Record<string, string>, payload: unknown): DemoResponse {
  if (payload === undefined || status === 204) return { status, headers, body: null };
  if (payload instanceof Uint8Array) {
    return { status, headers: { 'content-type': 'application/octet-stream', ...headers }, body: payload };
  }
  if (typeof payload === 'string') {
    return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: payload };
  }
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(payload) };
}
