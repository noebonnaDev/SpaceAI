import type { ProposalDto, ResourceDto } from '@ritrovo/shared';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { ErrorBox, Field, Spinner, StatusBadge, useAsync, useToast } from '../components/ui';
import { addDaysLocal, fmtDateTime, fmtRange, localToIso, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

interface OptionDraft {
  resourceId: string;
  date: string;
  from: string;
  to: string;
}

/** Booking proposals: up to three tentative holds, the others are released when one is confirmed. */
export function ProposalsPage() {
  const { api } = useSession();
  const toast = useToast();
  const rooms = useAsync(() => api.get<ResourceDto[]>('/api/resources?kind=room'), []);
  const proposals = useAsync(() => api.get<ProposalDto[]>('/api/proposals/mine'), []);
  const tomorrow = addDaysLocal(todayLocal(), 1);
  const [title, setTitle] = useState('');
  const [options, setOptions] = useState<OptionDraft[]>([
    { resourceId: '', date: tomorrow, from: '10:00', to: '11:00' },
    { resourceId: '', date: tomorrow, from: '14:00', to: '15:00' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const update = (i: number, patch: Partial<OptionDraft>) => setOptions((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/proposals', {
        title,
        options: options.map((o) => ({ resourceId: o.resourceId, start: localToIso(o.date, o.from), end: localToIso(o.date, o.to) })),
      });
      toast(t('proposals.created'));
      setTitle('');
      proposals.reload();
    } catch (err) {
      setError(err instanceof ApiError && err.details?.message ? new Error(err.details.message) : err);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (p: ProposalDto, bookingId: string) => {
    try {
      await api.post(`/api/proposals/${p.id}/confirm`, { bookingId });
      toast(t('proposals.confirmed'));
      proposals.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const cancel = async (p: ProposalDto) => {
    try {
      await api.post(`/api/proposals/${p.id}/cancel`);
      proposals.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const statusLabel = (s: ProposalDto['status']) =>
    ({ open: t('proposals.statusOpen'), confirmed: t('proposals.statusConfirmed'), expired: t('proposals.statusExpired'), cancelled: t('proposals.statusCancelled') })[s];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div>
          <h1>{t('proposals.title')}</h1>
          <p>{t('proposals.intro')}</p>
        </div>
      </div>
      <form className="card stack" onSubmit={submit}>
        <h2>{t('proposals.new')}</h2>
        <Field label={t('common.title')}>
          <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('booking.titlePlaceholder')} />
        </Field>
        {options.map((o, i) => (
          <div key={i} className="row">
            <Field label={t('proposals.option', { n: i + 1 })}>
              <select required value={o.resourceId} onChange={(e) => update(i, { resourceId: e.target.value })}>
                <option value="">—</option>
                {rooms.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.capacity})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('common.date')}>
              <input type="date" required value={o.date} onChange={(e) => update(i, { date: e.target.value })} />
            </Field>
            <Field label={t('common.from')}>
              <input type="time" required value={o.from} onChange={(e) => update(i, { from: e.target.value })} />
            </Field>
            <Field label={t('common.to')}>
              <input type="time" required value={o.to} onChange={(e) => update(i, { to: e.target.value })} />
            </Field>
            {options.length > 2 && (
              <button type="button" className="btn ghost" onClick={() => setOptions((x) => x.filter((_, j) => j !== i))} aria-label="Rimuovi opzione">
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row">
          {options.length < 3 && (
            <button type="button" className="btn" onClick={() => setOptions((x) => [...x, { resourceId: '', date: tomorrow, from: '16:00', to: '17:00' }])}>
              {t('proposals.addOption')}
            </button>
          )}
          <span className="spacer" />
          <button className="btn primary" disabled={busy}>
            {busy ? t('common.loading') : t('proposals.create')}
          </button>
        </div>
        <ErrorBox error={error} />
      </form>

      <ErrorBox error={proposals.error} onRetry={proposals.reload} />
      {proposals.loading && !proposals.data && <Spinner />}
      {proposals.data?.length === 0 && <div className="card empty">{t('proposals.empty')}</div>}
      {proposals.data?.map((p) => (
        <section key={p.id} className="card stack">
          <div className="card-title">
            <h2>{p.title}</h2>
            <span className={`badge ${p.status === 'open' ? 'info' : p.status === 'confirmed' ? 'good' : ''}`}>{statusLabel(p.status)}</span>
          </div>
          {p.status === 'open' && <p className="small muted">{t('proposals.expires', { date: fmtDateTime(p.expiresAt) })}</p>}
          {p.options.map((o) => (
            <div key={o.id} className="row center">
              <strong style={{ minWidth: 140 }}>{o.resourceName}</strong>
              <span>{fmtRange(o.start, o.end)}</span>
              <StatusBadge booking={o} />
              <span className="spacer" />
              {p.status === 'open' && o.status === 'tentative' && (
                <button className="btn primary small" onClick={() => void confirm(p, o.id)}>
                  {t('proposals.choose')}
                </button>
              )}
            </div>
          ))}
          {p.status === 'open' && (
            <div>
              <button className="btn danger small" onClick={() => void cancel(p)}>
                {t('proposals.cancel')}
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
