import type { BookingDto } from '@ritrovo/shared';
import { useState } from 'react';
import { BookingList } from '../components/BookingList';
import { ErrorBox, Spinner, useAsync } from '../components/ui';
import { addDaysLocal, fmtDayLong, localToIso, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

/** Personal agenda across rooms, desks and shared resources. */
export function MyBookingsPage() {
  const { api } = useSession();
  const [period, setPeriod] = useState<'next' | 'past'>('next');
  const today = todayLocal();
  const from = period === 'next' ? today : addDaysLocal(today, -30);
  const to = period === 'next' ? addDaysLocal(today, 31) : addDaysLocal(today, 1);
  const { data, error, loading, reload } = useAsync(
    () => api.get<BookingDto[]>(`/api/bookings/mine?from=${encodeURIComponent(localToIso(from, '00:00'))}&to=${encodeURIComponent(localToIso(to, '00:00'))}`),
    [period],
  );
  const list = (data ?? []).slice().sort((a, b) => (period === 'next' ? a.start.localeCompare(b.start) : b.start.localeCompare(a.start)));
  const groups = new Map<string, BookingDto[]>();
  for (const b of list) {
    const k = fmtDayLong(b.start);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <h1>{t('mine.title')}</h1>
        <div className="tabs" role="tablist" style={{ marginBottom: 0 }}>
          <button role="tab" aria-selected={period === 'next'} onClick={() => setPeriod('next')}>
            {t('mine.next30')}
          </button>
          <button role="tab" aria-selected={period === 'past'} onClick={() => setPeriod('past')}>
            {t('mine.past30')}
          </button>
        </div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Spinner />}
      {data && list.length === 0 && <div className="card empty">{t('mine.empty')}</div>}
      {[...groups.entries()].map(([day, items]) => (
        <section key={day} className="card">
          <h2>{day}</h2>
          <BookingList api={api} bookings={items} onChanged={reload} />
        </section>
      ))}
    </div>
  );
}
