import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('Pannello di amministrazione', () => {
  it('una modifica parziale (posizione sulla planimetria) non azzera le altre impostazioni della risorsa', async () => {
    const id = h.ids.resources.volta!;
    const before = (await h.api('giulia.rinaldi').get('/api/admin/resources')).body.find((r: any) => r.id === id);
    expect(before.capacity).toBe(8);
    const res = await h.api('giulia.rinaldi').patch(`/api/admin/resources/${id}`, { mapX: 0.42, mapY: 0.33 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capacity: 8, mapX: 0.42, mapY: 0.33, features: before.features, mailboxEmail: 'sala.volta@ufficio.example' });
    expect(res.body.policy).toEqual(before.policy);
  });

  it('crea una risorsa, la importa da Places senza duplicati e propone i comandi Exchange', async () => {
    const created = await h.api('giulia.rinaldi').post('/api/admin/resources', { kind: 'asset', name: 'Fotocamera', category: 'foto' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: 'asset', capacity: 1, policy: { checkInRequired: true, maxDurationMinutes: 480 } });
    const imported = await h.api('giulia.rinaldi').post('/api/admin/import/places');
    expect(imported.body).toMatchObject({ found: 4, created: 0, skipped: 4 });
    const list = (await h.api('giulia.rinaldi').get('/api/admin/resources')).body;
    expect(list.find((r: any) => r.name === 'Sala Volta').powershell).toContain('Set-CalendarProcessing -Identity "sala.volta@ufficio.example" -AutomateProcessing AutoAccept');
    const audit = (await h.api('giulia.rinaldi').get('/api/admin/audit')).body;
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['resource.create', 'resource.import']));
  });

  it('le regole si aggiornano solo con valori validi', async () => {
    const ok = await h.api('giulia.rinaldi').put('/api/admin/settings', { checkInGraceMinutes: 15, retentionDays: 90 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ checkInGraceMinutes: 15, retentionDays: 90, checkInOpensMinutesBefore: 10 });
    const bad = await h.api('giulia.rinaldi').put('/api/admin/settings', { retentionDays: 5 });
    expect(bad.status).toBe(400);
  });

  it('un amministratore non può togliersi il ruolo', async () => {
    const me = (await h.api('giulia.rinaldi').get('/api/me')).body;
    const res = await h.api('giulia.rinaldi').patch(`/api/admin/users/${me.id}`, { role: 'utente' });
    expect(res.status).toBe(400);
  });
});

describe('Manifest dell\'add-in pubblicato dal server', () => {
  it('serve il manifest con il dominio configurato', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/addin/manifest.xml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.body).toContain('<SourceLocation DefaultValue="https://ritrovo.test/addin/taskpane.html"/>');
    expect(res.body).not.toContain('{{');
  });
});
