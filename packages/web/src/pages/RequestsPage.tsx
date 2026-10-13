import type { FacilityRequestDto, RequestCategory, RequestStatus, ResourceDto } from '@ritrovo/shared';
import { useState, type FormEvent } from 'react';
import { Dialog, ErrorBox, Field, Spinner, useAsync, useToast } from '../components/ui';
import { fmtDateTime } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

const CATEGORIES: RequestCategory[] = ['manutenzione', 'pulizia', 'it', 'arredi', 'altro'];
const STATUSES: RequestStatus[] = ['open', 'in_progress', 'resolved', 'closed'];
const TONE: Record<RequestStatus, string> = { open: 'warning', in_progress: 'info', resolved: 'good', closed: '' };

/** Facility requests ("Care"): employees open, reception and admins handle them. */
export function RequestsPage() {
  const { api, can } = useSession();
  const toast = useToast();
  const staff = can('reception');
  const resources = useAsync(() => api.get<ResourceDto[]>('/api/resources'), []);
  const mine = useAsync(() => api.get<FacilityRequestDto[]>('/api/requests/mine'), []);
  const [filter, setFilter] = useState<RequestStatus | ''>('open');
  const all = useAsync(() => (staff ? api.get<FacilityRequestDto[]>(`/api/requests${filter ? `?status=${filter}` : ''}`) : Promise.resolve([])), [staff, filter]);
  const [form, setForm] = useState({ category: 'manutenzione' as RequestCategory, title: '', description: '', resourceId: '', locationText: '' });
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/requests', {
        category: form.category,
        title: form.title,
        description: form.description || undefined,
        resourceId: form.resourceId || undefined,
        locationText: form.locationText || undefined,
      });
      toast(t('requests.sent'));
      setForm({ ...form, title: '', description: '', resourceId: '', locationText: '' });
      mine.reload();
      all.reload();
    } catch (err) {
      setError(err);
    }
  };

  // Resolving or closing a request asks for a closing note in the app's own dialog.
  const [closing, setClosing] = useState<{ r: FacilityRequestDto; status: RequestStatus; note: string } | null>(null);
  const save = async (r: FacilityRequestDto, status: RequestStatus, note?: string) => {
    try {
      await api.patch(`/api/requests/${r.id}`, { status, ...(note !== undefined ? { resolutionNote: note } : {}) });
      mine.reload();
      all.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const update = (r: FacilityRequestDto, status: RequestStatus) => {
    if (status === 'resolved' || status === 'closed') setClosing({ r, status, note: r.resolutionNote ?? '' });
    else void save(r, status);
  };

  const RequestRow = ({ r, manage }: { r: FacilityRequestDto; manage: boolean }) => (
    <div className="booking-item">
      <div className="booking-time">
        <span className={`badge ${TONE[r.status]}`}>{t(`requests.status.${r.status}`)}</span>
        <small>{fmtDateTime(r.createdAt)}</small>
      </div>
      <div className="booking-body">
        <h3>{r.title}</h3>
        <div className="meta">
          <span>{t(`requests.categories.${r.category}`)}</span>
          {(r.resourceName || r.locationText) && <span>{[r.resourceName, r.locationText].filter(Boolean).join(' – ')}</span>}
          {manage && r.requesterName && (
            <span>
              {t('requests.requester')}: {r.requesterName}
            </span>
          )}
        </div>
        {r.description && <p className="small">{r.description}</p>}
        {r.resolutionNote && (
          <p className="small muted">
            {t('requests.resolution')}: {r.resolutionNote}
          </p>
        )}
      </div>
      <div className="booking-actions">
        {manage ? (
          <select value={r.status} onChange={(e) => update(r, e.target.value as RequestStatus)} aria-label={t('requests.title')} style={{ width: 'auto' }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`requests.status.${s}`)}
              </option>
            ))}
          </select>
        ) : (
          r.status !== 'closed' && (
            <button className="btn small" onClick={() => update(r, 'closed')}>
              {t('requests.close')}
            </button>
          )
        )}
      </div>
    </div>
  );

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div>
          <h1>{t('requests.title')}</h1>
          <p>{t('requests.intro')}</p>
        </div>
      </div>
      <div className="two-col">
        <form className="card stack" onSubmit={submit}>
          <h2>{t('requests.new')}</h2>
          <Field label={t('requests.category')}>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as RequestCategory })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`requests.categories.${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.title')}>
            <input required minLength={3} maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label={t('requests.description')}>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label={t('requests.where')}>
            <select value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })}>
              <option value="">—</option>
              {resources.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {t(`kinds.${r.kind}`)} {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('requests.whereText')}>
            <input value={form.locationText} onChange={(e) => setForm({ ...form, locationText: e.target.value })} />
          </Field>
          <ErrorBox error={error} />
          <button className="btn primary">{t('requests.send')}</button>
        </form>
        <section className="card">
          <h2>{t('requests.mine')}</h2>
          {mine.loading && !mine.data && <Spinner />}
          {mine.data?.length === 0 && <p className="muted">{t('requests.empty')}</p>}
          {mine.data?.map((r) => <RequestRow key={r.id} r={r} manage={false} />)}
        </section>
      </div>
      {staff && (
        <section className="card">
          <div className="card-title">
            <h2>{t('requests.all')}</h2>
            <select value={filter} onChange={(e) => setFilter(e.target.value as RequestStatus | '')} style={{ width: 'auto' }}>
              <option value="">{t('common.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`requests.status.${s}`)}
                </option>
              ))}
            </select>
          </div>
          <ErrorBox error={all.error} onRetry={all.reload} />
          {all.data?.length === 0 && <p className="muted">{t('requests.empty')}</p>}
          {all.data?.map((r) => <RequestRow key={r.id} r={r} manage />)}
        </section>
      )}
      <Dialog
        open={closing !== null}
        title={closing ? `${closing.r.title}: ${t(`requests.status.${closing.status}`)}` : ''}
        onClose={() => setClosing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setClosing(null)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                if (closing) void save(closing.r, closing.status, closing.note.trim());
                setClosing(null);
              }}
            >
              {t('common.save')}
            </button>
          </>
        }
      >
        <Field label={t('requests.resolution')}>
          <textarea id="request-resolution-note" rows={4} value={closing?.note ?? ''} onChange={(e) => closing && setClosing({ ...closing, note: e.target.value })} />
        </Field>
      </Dialog>
    </div>
  );
}
