import type { BookingDto } from '@ritrovo/shared';
import { useState } from 'react';
import { ErrorBox, Field, Spinner, StatusBadge, useAsync } from '../components/ui';
import { fmtTime, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';
import { RoomsPage } from './RoomsPage';
import { DateInput } from '../components/DateTime';

/** Reception desk: the day's bookings across all resources and booking on behalf of colleagues. */
export function ReceptionPage() {
  const { api } = useSession();
  const [date, setDate] = useState(todayLocal());
  const day = useAsync(() => api.get<BookingDto[]>(`/api/reception/bookings?date=${date}`), [date]);
  const rows = (day.data ?? []).filter((b) => !['cancelled', 'declined'].includes(b.status) && !(b.status === 'released' && b.releaseReason?.startsWith('proposal')));
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="page-head">
        <h1>{t('reception.title')}</h1>
      </div>
      <section className="card">
        <div className="card-title">
          <h2>{t('reception.today')}</h2>
          <Field label={t('common.date')}>
            <DateInput value={date} onChange={(v) => setDate(v)} />
          </Field>
        </div>
        <ErrorBox error={day.error} onRetry={day.reload} />
        {day.loading && !day.data && <Spinner />}
        {day.data && rows.length === 0 && <p className="muted">{t('reception.empty')}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('common.from')}</th>
                  <th>{t('common.to')}</th>
                  <th>{t('admin.kpi.resource')}</th>
                  <th>{t('common.title')}</th>
                  <th>{t('booking.for')}</th>
                  <th>{t('booking.organizer')}</th>
                  <th>{t('booking.source')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td className="num">{fmtTime(b.start)}</td>
                    <td className="num">{fmtTime(b.effectiveEnd ?? b.end)}</td>
                    <td>{b.resourceName}</td>
                    <td>{b.title}</td>
                    <td>{b.bookedForName}</td>
                    <td>{b.organizerName}</td>
                    <td>{t(`sources.${b.source}`)}</td>
                    <td>
                      <StatusBadge booking={b} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <RoomsPage onBehalf />
    </div>
  );
}
