import type { LiveResourceState } from '@ritrovo/shared';
import { useEffect } from 'react';
import { ErrorBox, LiveBadge, Spinner, useAsync } from '../../components/ui';
import { fmtNumber, fmtTime } from '../../format';
import { t } from '../../i18n';
import { useSession } from '../../session';

interface Live {
  states: LiveResourceState[];
  today: { bookings: number; checkedIn: number; noShows: number; openRequests: number };
}

/** Real-time dashboard: today's counters and the live state of every resource (refreshes every 30 seconds). */
export function OverviewTab() {
  const { api } = useSession();
  const live = useAsync(() => api.get<Live>('/api/admin/live'), []);
  useEffect(() => {
    const h = setInterval(live.reload, 30_000);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const d = live.data;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <ErrorBox error={live.error} onRetry={live.reload} />
      {live.loading && !d && <Spinner />}
      {d && (
        <>
          <div className="grid grid-4">
            {[
              [t('admin.overview.bookingsToday'), d.today.bookings],
              [t('admin.overview.checkedIn'), d.today.checkedIn],
              [t('admin.overview.noShows'), d.today.noShows],
              [t('admin.overview.openRequests'), d.today.openRequests],
            ].map(([label, value]) => (
              <div key={label} className="card stat">
                <span className="stat-label">{label}</span>
                <span className="stat-value">{fmtNumber(Number(value))}</span>
              </div>
            ))}
          </div>
          <section className="card">
            <div className="card-title">
              <h2>{t('admin.overview.live')}</h2>
              <button className="btn small" onClick={live.reload}>
                {t('common.refresh')}
              </button>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>{t('admin.kpi.resource')}</th>
                    <th>{t('admin.resources.kind')}</th>
                    <th>{t('common.floor')}</th>
                    <th>{t('common.status')}</th>
                    <th>{t('kiosk.meeting')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.states.map((s) => (
                    <tr key={s.resourceId}>
                      <td>{s.resourceName}</td>
                      <td>{t(`kinds.${s.kind}`)}</td>
                      <td>{s.floorName ?? '—'}</td>
                      <td>
                        <LiveBadge state={s.state} />
                      </td>
                      <td className="small">
                        {s.currentBooking
                          ? `${fmtTime(s.currentBooking.start)}–${fmtTime(s.currentBooking.effectiveEnd ?? s.currentBooking.end)} ${s.currentBooking.organizerName ?? ''}`
                          : s.nextBooking
                            ? t('kiosk.nextAt', { time: fmtTime(s.nextBooking.start) })
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
