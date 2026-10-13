import type { BookingDto, ResourceDto } from '@ritrovo/shared';
import { useState } from 'react';
import { useParams } from 'react-router';
import { BookingList } from '../components/BookingList';
import { ConflictPanel } from '../components/BookingDialog';
import { ErrorBox, Features, Spinner, useAsync, useToast } from '../components/ui';
import { ApiError } from '../api';
import { fmtTime } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

interface QrState {
  resource: ResourceDto;
  agenda: BookingDto[];
  myBooking: BookingDto | null;
  freeNow: boolean;
}

/** Landing page of a resource QR code / NFC tag: status, today's agenda, book now, check-in, check-out. */
export function QrPage() {
  const { token } = useParams();
  const { api } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.get<QrState>(`/api/qr/${token}`), [token]);
  const [conflict, setConflict] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const quickBook = async (minutes: number) => {
    setBusy(true);
    setConflict(null);
    try {
      await api.post(`/api/qr/${token}/book`, { durationMinutes: minutes });
      toast(t('booking.created'));
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(err.details);
      else toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const r = data.resource;
  return (
    <div className="stack" style={{ gap: 20, maxWidth: 640 }}>
      <div className="page-head">
        <div>
          <p className="small muted">{t(`kinds.${r.kind}`)}</p>
          <h1>{r.name}</h1>
          <div className="meta">
            {r.floorName && <span>{r.floorName}</span>}
            {r.kind === 'room' && <span>{t('common.capacity', { n: r.capacity })}</span>}
          </div>
        </div>
        {data.freeNow ? <span className="badge good">● {t('qr.freeNow')}</span> : <span className="badge critical">■ {t('qr.busyNow')}</span>}
      </div>
      <Features list={r.features} />
      {r.description && <p className="muted">{r.description}</p>}
      {data.myBooking && (
        <section className="card">
          <h2>{t('qr.yourBooking')}</h2>
          <BookingList api={api} bookings={[data.myBooking]} onChanged={reload} compact />
        </section>
      )}
      {!data.myBooking && data.freeNow && (
        <section className="card stack">
          <h2>{t('qr.quickBook')}</h2>
          <div className="chips">
            {[30, 60, 120, ...(r.kind === 'room' ? [] : [240])].map((m) => (
              <button key={m} className="btn primary" disabled={busy} onClick={() => void quickBook(m)}>
                {m < 60 ? t('common.minutes', { n: m }) : t('common.hours', { n: m / 60 })}
              </button>
            ))}
          </div>
          {conflict && <ConflictPanel conflict={conflict} onPick={() => setConflict(null)} />}
        </section>
      )}
      <section className="card">
        <h2>{t('qr.agendaToday')}</h2>
        {data.agenda.length === 0 ? (
          <p className="muted">{t('qr.noneToday')}</p>
        ) : (
          data.agenda.map((b) => (
            <div key={b.id} className="row center" style={{ padding: '6px 0' }}>
              <strong className="mono">
                {fmtTime(b.start)}–{fmtTime(b.effectiveEnd ?? b.end)}
              </strong>
              <span>{b.title ?? b.organizerName ?? t('kiosk.meeting')}</span>
            </div>
          ))
        )}
      </section>
      <p className="small muted">{t('qr.nfcHint')}</p>
    </div>
  );
}
