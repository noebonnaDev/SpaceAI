import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type DemoBackend } from './backend';

// The whole demo backend (real routes, PGlite, simulated Exchange, sample data) driven through the in-page router.
let backend: DemoBackend;
const json = (res: { body: unknown }) => JSON.parse(String(res.body));

async function as(email: string) {
  const res = await backend.handle('POST', '/api/auth/dev-login', { 'content-type': 'application/json' }, JSON.stringify({ email }));
  const token = json(res).token as string;
  return (method: string, url: string, body?: unknown) =>
    backend.handle(method, url, { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body === undefined ? null : JSON.stringify(body));
}

beforeAll(async () => {
  backend = await startBackend({ publicBaseUrl: 'https://demo.ritrovo.test' });
}, 120_000);
afterAll(async () => {
  await backend?.stop();
});

describe('demo backend in the browser runtime', () => {
  it('serves configuration, demo users and sample data', async () => {
    expect(json(await backend.handle('GET', '/api/config')).authMode).toBe('dev');
    expect(json(await backend.handle('GET', '/api/auth/dev-users')).length).toBe(8);
    const admin = await as('giulia.rinaldi@ufficio.example');
    const resources = json(await admin('GET', '/api/admin/resources'));
    expect(resources.filter((r: { kind: string }) => r.kind === 'room')).toHaveLength(4);
    expect(resources[0].qrUrl).toMatch(/^https:\/\/demo\.ritrovo\.test\/q\//);
  });

  it('books a free room, refuses an overlap with alternatives, and serves the floor plan bytes', async () => {
    const marco = await as('marco.esposito@ufficio.example');
    const rooms = json(await marco('GET', '/api/resources?kind=room'));
    const room = (rooms.resources ?? rooms).map((x: { resource?: unknown }) => x.resource ?? x)[0];
    const start = new Date(Date.now() + 3 * 864e5);
    start.setUTCHours(8, 0, 0, 0);
    const slot = { resourceId: room.id, start: start.toISOString(), end: new Date(start.getTime() + 3600e3).toISOString(), title: 'Prova demo' };
    const first = await marco('POST', '/api/bookings', slot);
    expect(first.status).toBe(201);
    expect(json(first).status).toBe('confirmed');
    const davide = await as('davide.gallo@ufficio.example');
    const clash = await davide('POST', '/api/bookings', slot);
    expect(clash.status).toBe(409);
    expect(json(clash).details.alternatives.resources.length).toBeGreaterThan(0);

    const buildings = json(await marco('GET', '/api/buildings'));
    const floor = buildings[0].floors[0];
    const map = await marco('GET', `/api/floors/${floor.id}/map`);
    expect(map.status).toBe(200);
    expect(map.headers['content-type']).toBe('image/svg+xml');
    expect(new TextDecoder().decode(map.body as Uint8Array)).toContain('<svg');
  });

  it('pairs a door panel and answers its state with the device key', async () => {
    const admin = await as('giulia.rinaldi@ufficio.example');
    const volta = json(await admin('GET', '/api/admin/resources')).find((r: { name: string }) => r.name === 'Sala Volta');
    const pairing = json(await admin('POST', '/api/admin/kiosks', { name: 'Tablet', kind: 'panel', resourceId: volta.id }));
    const key = pairing.pairingUrl.split('#t=')[1];
    const state = await backend.handle('GET', '/api/kiosk/state', { authorization: `Kiosk ${key}` });
    expect(state.status).toBe(200);
    expect(json(state).resource.name).toBe('Sala Volta');
    expect((await backend.handle('GET', '/api/kiosk/state', { authorization: 'Kiosk sbagliata' })).status).toBe(401);
  });
});
