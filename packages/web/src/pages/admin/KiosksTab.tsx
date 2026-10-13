import type { BuildingDto, ResourceDto } from '@ritrovo/shared';
import { useState, type FormEvent } from 'react';
import { ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { fmtDateTime } from '../../format';
import { t } from '../../i18n';
import { useSession } from '../../session';

interface Kiosk {
  id: string;
  name: string;
  kind: 'panel' | 'totem';
  resourceName: string | null;
  buildingName: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

/** Pairing of room door panels and lobby totems (device tokens, revocable). */
export function KiosksTab() {
  const { api } = useSession();
  const toast = useToast();
  const kiosks = useAsync(() => api.get<Kiosk[]>('/api/admin/kiosks'), []);
  const rooms = useAsync(() => api.get<ResourceDto[]>('/api/resources?kind=room'), []);
  const buildings = useAsync(() => api.get<BuildingDto[]>('/api/buildings'), []);
  const [form, setForm] = useState({ name: '', kind: 'panel' as 'panel' | 'totem', resourceId: '', buildingId: '' });
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post<{ pairingUrl: string }>('/api/admin/kiosks', {
        name: form.name,
        kind: form.kind,
        ...(form.kind === 'panel' ? { resourceId: form.resourceId } : { buildingId: form.buildingId }),
      });
      setPairing(res.pairingUrl);
      kiosks.reload();
    } catch (err) {
      setError(err);
    }
  };

  const revoke = async (k: Kiosk) => {
    try {
      await api.post(`/api/admin/kiosks/${k.id}/revoke`);
      kiosks.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <form className="card stack" onSubmit={create}>
        <h2>{t('admin.kiosks.new')}</h2>
        <div className="row">
          <Field label={t('admin.resources.kind')}>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'panel' | 'totem' })}>
              <option value="panel">{t('admin.kiosks.kindPanel')}</option>
              <option value="totem">{t('admin.kiosks.kindTotem')}</option>
            </select>
          </Field>
          <Field label={t('admin.kiosks.name')}>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Tablet Sala Volta" />
          </Field>
          {form.kind === 'panel' ? (
            <Field label={t('admin.kiosks.room')}>
              <select required value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })}>
                <option value="">—</option>
                {rooms.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label={t('common.building')}>
              <select required value={form.buildingId} onChange={(e) => setForm({ ...form, buildingId: e.target.value })}>
                <option value="">—</option>
                {buildings.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <button className="btn primary">{t('common.create')}</button>
        </div>
        <ErrorBox error={error} />
        {pairing && (
          <div className="alert info stack">
            <strong>{t('admin.kiosks.pairingUrl')}</strong>
            <code className="mono" style={{ wordBreak: 'break-all' }}>
              {pairing}
            </code>
            <small>{t('admin.kiosks.pairingHint')}</small>
            <div>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  void navigator.clipboard.writeText(pairing);
                  toast(t('common.copied'));
                }}
              >
                {t('common.copy')}
              </button>
            </div>
          </div>
        )}
      </form>
      <ErrorBox error={kiosks.error} onRetry={kiosks.reload} />
      {kiosks.loading && !kiosks.data && <Spinner />}
      <div className="card table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('admin.kiosks.name')}</th>
              <th>{t('admin.resources.kind')}</th>
              <th>{t('admin.kpi.resource')}</th>
              <th>{t('admin.kiosks.lastSeen')}</th>
              <th>{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {kiosks.data?.map((k) => (
              <tr key={k.id} style={{ opacity: k.revokedAt ? 0.5 : 1 }}>
                <td>{k.name}</td>
                <td>{k.kind === 'panel' ? t('admin.kiosks.kindPanel') : t('admin.kiosks.kindTotem')}</td>
                <td>{k.resourceName ?? k.buildingName}</td>
                <td className="small">{k.lastSeenAt ? fmtDateTime(k.lastSeenAt) : t('admin.kiosks.never')}</td>
                <td>
                  {k.revokedAt ? (
                    <span className="badge">{t('admin.kiosks.revoked')}</span>
                  ) : (
                    <button className="btn danger small" onClick={() => void revoke(k)}>
                      {t('admin.kiosks.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
