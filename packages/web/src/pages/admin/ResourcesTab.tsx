import type { BuildingDto, ResourceDto, ResourceKind } from '@ritrovo/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Dialog, ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { useSession } from '../../session';

type AdminResource = ResourceDto & { qrUrl: string; powershell: string | null };

interface Draft {
  kind: ResourceKind;
  name: string;
  description: string;
  category: string;
  mailboxEmail: string;
  buildingId: string;
  floorId: string;
  capacity: number;
  features: string;
  isActive: boolean;
  checkInRequired: boolean;
  checkInGraceMinutes: string;
  maxDurationMinutes: number;
  bookingWindowDays: number;
}

const emptyDraft: Draft = {
  kind: 'room',
  name: '',
  description: '',
  category: '',
  mailboxEmail: '',
  buildingId: '',
  floorId: '',
  capacity: 4,
  features: '',
  isActive: true,
  checkInRequired: true,
  checkInGraceMinutes: '',
  maxDurationMinutes: 480,
  bookingWindowDays: 180,
};

/** Bookable resources and their rules; QR codes; Exchange alignment commands. */
export function ResourcesTab() {
  const { api } = useSession();
  const toast = useToast();
  const list = useAsync(() => api.get<AdminResource[]>('/api/admin/resources'), []);
  const buildings = useAsync(() => api.get<BuildingDto[]>('/api/buildings'), []);
  const [editing, setEditing] = useState<AdminResource | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState<unknown>(null);
  const [qr, setQr] = useState<{ r: AdminResource; svg: string } | null>(null);
  const [kindFilter, setKindFilter] = useState<ResourceKind | ''>('');
  const [sheet, setSheet] = useState<Array<{ r: AdminResource; svg: string }> | null>(null);

  useEffect(() => {
    if (editing === 'new') setDraft(emptyDraft);
    else if (editing) {
      setDraft({
        kind: editing.kind,
        name: editing.name,
        description: editing.description ?? '',
        category: editing.category ?? '',
        mailboxEmail: editing.mailboxEmail ?? '',
        buildingId: editing.buildingId ?? '',
        floorId: editing.floorId ?? '',
        capacity: editing.capacity,
        features: editing.features.join(', '),
        isActive: editing.isActive,
        checkInRequired: editing.policy.checkInRequired,
        checkInGraceMinutes: '',
        maxDurationMinutes: editing.policy.maxDurationMinutes,
        bookingWindowDays: editing.policy.bookingWindowDays,
      });
    }
    setError(null);
  }, [editing]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = {
      kind: draft.kind,
      name: draft.name,
      description: draft.description || null,
      category: draft.category || null,
      mailboxEmail: draft.mailboxEmail || null,
      buildingId: draft.buildingId || null,
      floorId: draft.floorId || null,
      capacity: Number(draft.capacity),
      features: draft.features
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean),
      isActive: draft.isActive,
      checkInRequired: draft.checkInRequired,
      ...(draft.checkInGraceMinutes ? { checkInGraceMinutes: Number(draft.checkInGraceMinutes) } : {}),
      maxDurationMinutes: Number(draft.maxDurationMinutes),
      bookingWindowDays: Number(draft.bookingWindowDays),
    };
    try {
      if (editing === 'new') await api.post('/api/admin/resources', body);
      else if (editing) await api.patch(`/api/admin/resources/${editing.id}`, body);
      toast(t('admin.resources.saved'));
      setEditing(null);
      list.reload();
    } catch (err) {
      setError(err);
    }
  };

  const showQr = async (r: AdminResource) => {
    try {
      setQr({ r, svg: await api.text(`/api/admin/resources/${r.id}/qr.svg`) });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const printSheet = async () => {
    const items = (list.data ?? []).filter((r) => r.isActive && (!kindFilter || r.kind === kindFilter));
    const out: Array<{ r: AdminResource; svg: string }> = [];
    for (const r of items) out.push({ r, svg: await api.text(`/api/admin/resources/${r.id}/qr.svg`) });
    setSheet(out);
    setTimeout(() => window.print(), 300);
  };

  const importPlaces = async () => {
    try {
      const res = await api.post<{ created: number; skipped: number }>('/api/admin/import/places');
      toast(t('admin.resources.imported', { created: res.created, skipped: res.skipped }));
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const floors = buildings.data?.find((b) => b.id === draft.buildingId)?.floors ?? [];
  const rows = (list.data ?? []).filter((r) => !kindFilter || r.kind === kindFilter);

  if (sheet) {
    return (
      <div>
        <div className="row no-print" style={{ marginBottom: 16 }}>
          <button className="btn" onClick={() => setSheet(null)}>
            {t('common.back')}
          </button>
          <button className="btn primary" onClick={() => window.print()}>
            {t('common.print')}
          </button>
        </div>
        <div className="grid grid-3">
          {sheet.map(({ r, svg }) => (
            <div key={r.id} className="card" style={{ textAlign: 'center', breakInside: 'avoid' }}>
              <div style={{ width: 180, margin: '0 auto' }} dangerouslySetInnerHTML={{ __html: svg }} />
              <h3>{r.name}</h3>
              <p className="small muted">{t(`kinds.${r.kind}`)} · {t('qr.title')}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row">
        <Field label={t('admin.resources.kind')}>
          <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as ResourceKind | '')}>
            <option value="">{t('common.all')}</option>
            <option value="room">{t('kinds.room')}</option>
            <option value="desk">{t('kinds.desk')}</option>
            <option value="asset">{t('kinds.asset')}</option>
          </select>
        </Field>
        <span className="spacer" />
        <button className="btn" onClick={() => void importPlaces()}>
          {t('admin.resources.import')}
        </button>
        <button className="btn" onClick={() => void printSheet()}>
          {t('admin.resources.qrPrint')}
        </button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          {t('admin.resources.new')}
        </button>
      </div>
      <ErrorBox error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('admin.resources.name')}</th>
              <th>{t('admin.resources.kind')}</th>
              <th>{t('common.floor')}</th>
              <th className="num">{t('admin.resources.capacity')}</th>
              <th>{t('admin.resources.exchange')}</th>
              <th>{t('admin.resources.checkInRequired')}</th>
              <th>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.5 }}>
                <td>{r.name}</td>
                <td>{t(`kinds.${r.kind}`)}</td>
                <td>{r.floorName ?? '—'}</td>
                <td className="num">{r.capacity}</td>
                <td className="small">{r.mailboxEmail ?? <span className="muted">{t('admin.resources.onlyRitrovo')}</span>}</td>
                <td>{r.policy.checkInRequired ? `${t('common.yes')} (${r.policy.checkInGraceMinutes}′)` : t('common.no')}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn small" onClick={() => setEditing(r)}>
                      {t('common.edit')}
                    </button>
                    <button className="btn small" onClick={() => void showQr(r)}>
                      {t('admin.resources.qr')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog
        open={!!editing}
        title={editing === 'new' ? t('admin.resources.new') : t('admin.resources.edit')}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" type="submit" form="resource-form">
              {t('common.save')}
            </button>
          </>
        }
      >
        <form id="resource-form" className="stack" onSubmit={save}>
          <div className="row">
            <Field label={t('admin.resources.kind')}>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ResourceKind })}>
                <option value="room">{t('kinds.room')}</option>
                <option value="desk">{t('kinds.desk')}</option>
                <option value="asset">{t('kinds.asset')}</option>
              </select>
            </Field>
            <Field label={t('admin.resources.name')}>
              <input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t('admin.resources.capacity')}>
              <input type="number" min={1} value={draft.capacity} onChange={(e) => setDraft({ ...draft, capacity: Number(e.target.value) })} style={{ width: 90 }} />
            </Field>
          </div>
          <Field label={t('admin.resources.description')}>
            <input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <Field label={t('admin.resources.mailbox')} hint={t('admin.resources.mailboxHint')}>
            <input type="email" value={draft.mailboxEmail} onChange={(e) => setDraft({ ...draft, mailboxEmail: e.target.value })} placeholder="sala.nome@azienda.it" />
          </Field>
          <div className="row">
            <Field label={t('common.building')}>
              <select value={draft.buildingId} onChange={(e) => setDraft({ ...draft, buildingId: e.target.value, floorId: '' })}>
                <option value="">—</option>
                {buildings.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('common.floor')}>
              <select value={draft.floorId} onChange={(e) => setDraft({ ...draft, floorId: e.target.value })}>
                <option value="">—</option>
                {floors.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
            {draft.kind === 'asset' && (
              <Field label={t('admin.resources.category')}>
                <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="veicolo" />
              </Field>
            )}
          </div>
          <Field label={t('admin.resources.features')}>
            <input value={draft.features} onChange={(e) => setDraft({ ...draft, features: e.target.value })} placeholder="videoconferenza, schermo" />
          </Field>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> {t('admin.resources.active')}
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.checkInRequired} onChange={(e) => setDraft({ ...draft, checkInRequired: e.target.checked })} />{' '}
              {t('admin.resources.checkInRequired')}
            </label>
          </div>
          <div className="row">
            <Field label={t('admin.resources.grace')} hint={editing !== 'new' && editing ? `${t('admin.resources.graceDefault')}: ${editing.policy.checkInGraceMinutes}` : undefined}>
              <input type="number" min={1} max={240} value={draft.checkInGraceMinutes} onChange={(e) => setDraft({ ...draft, checkInGraceMinutes: e.target.value })} />
            </Field>
            <Field label={t('admin.resources.maxDuration')}>
              <input type="number" min={5} value={draft.maxDurationMinutes} onChange={(e) => setDraft({ ...draft, maxDurationMinutes: Number(e.target.value) })} />
            </Field>
            <Field label={t('admin.resources.window')}>
              <input type="number" min={0} max={1080} value={draft.bookingWindowDays} onChange={(e) => setDraft({ ...draft, bookingWindowDays: Number(e.target.value) })} />
            </Field>
          </div>
          <p className="small muted">{t('admin.resources.positionHint')}</p>
          {editing && editing !== 'new' && editing.powershell && (
            <div className="stack" style={{ gap: 4 }}>
              <span className="field-label">{t('admin.resources.powershell')}</span>
              <small className="muted">{t('admin.resources.powershellHint')}</small>
              <pre className="mono card" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                {editing.powershell}
              </pre>
            </div>
          )}
          <ErrorBox error={error} />
        </form>
      </Dialog>

      <Dialog open={!!qr} title={qr ? `${t('admin.resources.qr')} – ${qr.r.name}` : ''} onClose={() => setQr(null)}>
        {qr && (
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <div style={{ width: 240 }} dangerouslySetInnerHTML={{ __html: qr.svg }} />
            <code className="mono">{qr.r.qrUrl}</code>
            <p className="small muted">{t('qr.nfcHint')}</p>
            <div className="row">
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(qr.r.qrUrl);
                  toast(t('common.copied'));
                }}
              >
                {t('common.copy')}
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.post(`/api/admin/resources/${qr.r.id}/regenerate-qr`);
                  setQr(null);
                  list.reload();
                }}
              >
                {t('admin.resources.regenerateQr')}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
