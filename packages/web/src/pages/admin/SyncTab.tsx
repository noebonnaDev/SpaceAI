import { useState } from 'react';
import { ErrorBox, Spinner, useAsync, useToast } from '../../components/ui';
import { fmtDateTime } from '../../format';
import { t } from '../../i18n';
import { useSession } from '../../session';

interface SyncStatus {
  graphMode: 'live' | 'mock';
  webhooksEnabled: boolean;
  deltaIntervalSeconds: number;
  resources: Array<{ resourceId: string; name: string; mailbox: string; lastSyncAt: string | null; lastError: string | null; subscriptionExpiresAt: string | null }>;
}

/** Microsoft Graph synchronisation status (webhooks, delta) per resource mailbox. */
export function SyncTab() {
  const { api } = useSession();
  const toast = useToast();
  const status = useAsync(() => api.get<SyncStatus>('/api/admin/sync'), []);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.post('/api/admin/sync/run');
      toast(t('admin.sync.done'));
      status.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const s = status.data;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <ErrorBox error={status.error} onRetry={status.reload} />
      {status.loading && !s && <Spinner />}
      {s && (
        <>
          <div className="card row center">
            <span>
              {t('admin.sync.mode')}: <strong>{s.graphMode === 'live' ? 'Microsoft Graph' : 'mock (demo)'}</strong>
            </span>
            <span>
              {t('admin.sync.webhooks')}: <strong>{s.webhooksEnabled ? t('admin.sync.enabled') : t('admin.sync.disabled')}</strong>
            </span>
            <span>{t('admin.sync.delta', { n: s.deltaIntervalSeconds })}</span>
            <span className="spacer" />
            <button className="btn primary" disabled={busy} onClick={() => void run()}>
              {t('admin.sync.runNow')}
            </button>
          </div>
          <div className="card table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('admin.kpi.resource')}</th>
                  <th>{t('admin.sync.resource')}</th>
                  <th>{t('admin.sync.lastSync')}</th>
                  <th>{t('admin.sync.subscription')}</th>
                  <th>{t('admin.sync.lastError')}</th>
                </tr>
              </thead>
              <tbody>
                {s.resources.map((r) => (
                  <tr key={r.resourceId}>
                    <td>{r.name}</td>
                    <td className="small">{r.mailbox}</td>
                    <td className="small">{r.lastSyncAt ? fmtDateTime(r.lastSyncAt) : '—'}</td>
                    <td className="small">{r.subscriptionExpiresAt ? fmtDateTime(r.subscriptionExpiresAt) : '—'}</td>
                    <td className="small">{r.lastError ? <span className="badge critical">⚠ {r.lastError}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

interface AuditRow {
  id: number;
  at: string;
  actor_label: string;
  action: string;
  entity: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
}

export function AuditTab() {
  const { api } = useSession();
  const audit = useAsync(() => api.get<AuditRow[]>('/api/admin/audit?limit=200'), []);
  return (
    <div className="card table-wrap">
      <ErrorBox error={audit.error} onRetry={audit.reload} />
      {audit.loading && !audit.data && <Spinner />}
      <table className="data">
        <thead>
          <tr>
            <th>{t('admin.audit.when')}</th>
            <th>{t('admin.audit.who')}</th>
            <th>{t('admin.audit.action')}</th>
            <th>{t('admin.audit.object')}</th>
          </tr>
        </thead>
        <tbody>
          {audit.data?.map((a) => (
            <tr key={a.id}>
              <td className="small">{fmtDateTime(a.at)}</td>
              <td className="small">{a.actor_label}</td>
              <td>{a.action}</td>
              <td className="small mono">{a.details ? JSON.stringify(a.details) : (a.entity ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
