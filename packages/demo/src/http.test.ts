import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NotFoundError } from '../../server/src/domain/errors';
import { DemoRouter } from './http';

describe('DemoRouter (Fastify stand-in for the in-browser demo)', () => {
  const onError = vi.fn();
  const r = new DemoRouter(onError);
  r.get('/api/items/:id', async (req) => ({ id: req.params.id, q: req.query }));
  r.post('/api/items', async (req, reply) => reply.code(201).send({ got: req.body }));
  r.get('/api/report.csv', async (_req, reply) => reply.header('Content-Disposition', 'attachment').type('text/csv; charset=utf-8').send('a;b'));
  r.get('/api/missing', async () => {
    throw new NotFoundError('Non trovato.');
  });
  r.post('/api/validate', async (req) => z.object({ n: z.number() }).parse(req.body));
  r.get('/api/boom', async () => {
    throw new Error('guasto');
  });

  it('matches :params and parses repeated query keys', async () => {
    const res = await r.handle('GET', '/api/items/a%20b?x=1&x=2&y=3');
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body))).toEqual({ id: 'a b', q: { x: ['1', '2'], y: '3' } });
  });

  it('parses JSON bodies and honours reply.code().send()', async () => {
    const res = await r.handle('POST', '/api/items', { 'Content-Type': 'application/json' }, '{"a":1}');
    expect(res.status).toBe(201);
    expect(JSON.parse(String(res.body))).toEqual({ got: { a: 1 } });
  });

  it('keeps headers and content type set by the route', async () => {
    const res = await r.handle('GET', '/api/report.csv');
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.body).toBe('a;b');
  });

  it('maps errors like the server: AppError, validation, unexpected', async () => {
    expect((await r.handle('GET', '/api/missing')).status).toBe(404);
    const bad = await r.handle('POST', '/api/validate', { 'content-type': 'application/json' }, '{"n":"x"}');
    expect(bad.status).toBe(400);
    expect(JSON.parse(String(bad.body)).code).toBe('VALIDATION');
    const boom = await r.handle('GET', '/api/boom');
    expect(boom.status).toBe(500);
    expect(onError).toHaveBeenCalledOnce();
    expect((await r.handle('GET', '/api/nowhere')).status).toBe(404);
    expect((await r.handle('DELETE', '/api/items/1')).status).toBe(404);
  });
});
