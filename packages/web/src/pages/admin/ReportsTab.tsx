import type { KpiReport, ResourceKind } from '@ritrovo/shared';
import { useState } from 'react';
import { ColumnChart, HBarList } from '../../components/charts';
import { ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { addDaysLocal, fmtNumber, fmtPercent, todayLocal } from '../../format';
import { t } from '../../i18n';
import { useSession } from '../../session';
import { DateInput } from '../../components/DateTime';

type Preset = 'today' | 'yesterday' | 'last7' | 'last30' | 'last90' | 'custom';

/** KPI report: occupancy, no-show rate, peak hours and utilisation per resource, with CSV export. */
export function ReportsTab() {
  const { api } = useSession();
  const toast = useToast();
  const today = todayLocal();
  const [preset, setPreset] = useState<Preset>('last30');
  const [customFrom, setCustomFrom] = useState(addDaysLocal(today, -7));
  const [customTo, setCustomTo] = useState(today);
  const [kind, setKind] = useState<ResourceKind | ''>('room');
  const [showTable, setShowTable] = useState(false);

  const range = (): [string, string] => {
    switch (preset) {
      case 'today':
        return [today, today];
      case 'yesterday':
        return [addDaysLocal(today, -1), addDaysLocal(today, -1)];
      case 'last7':
        return [addDaysLocal(today, -7), addDaysLocal(today, -1)];
      case 'last30':
        return [addDaysLocal(today, -30), addDaysLocal(today, -1)];
      case 'last90':
        return [addDaysLocal(today, -90), addDaysLocal(today, -1)];
      default:
        return [customFrom, customTo];
    }
  };
  const [from, to] = range();
  const qs = new URLSearchParams({ from, to, ...(kind ? { kind } : {}) }).toString();
  const report = useAsync(() => api.get<KpiReport>(`/api/admin/kpi?${qs}`), [qs]);
  const r = report.data;

  const exportCsv = async () => {
    try {
      await api.download(`/api/admin/kpi.csv?${qs}`, `ritrovo-kpi-${from}_${to}.csv`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* Filters: one row above everything they scope. */}
      <div className="card row">
        <Field label={t('admin.kpi.period')}>
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {(['today', 'yesterday', 'last7', 'last30', 'last90', 'custom'] as Preset[]).map((p) => (
              <option key={p} value={p}>
                {t(`admin.kpi.presets.${p}`)}
              </option>
            ))}
          </select>
        </Field>
        {preset === 'custom' && (
          <>
            <Field label={t('common.from')}>
              <DateInput value={customFrom} onChange={(v) => setCustomFrom(v)} />
            </Field>
            <Field label={t('common.to')}>
              <DateInput value={customTo} min={customFrom} onChange={(v) => setCustomTo(v)} />
            </Field>
          </>
        )}
        <Field label={t('admin.kpi.kind')}>
          <select value={kind} onChange={(e) => setKind(e.target.value as ResourceKind | '')}>
            <option value="">{t('common.all')}</option>
            <option value="room">{t('kinds.room')}</option>
            <option value="desk">{t('kinds.desk')}</option>
            <option value="asset">{t('kinds.asset')}</option>
          </select>
        </Field>
        <span className="spacer" />
        <button className="btn" onClick={() => void exportCsv()}>
          {t('common.exportCsv')}
        </button>
      </div>
      <ErrorBox error={report.error} onRetry={report.reload} />
      {report.loading && !r && <Spinner />}
      {r && (
        <div className="stack" style={{ gap: 16, opacity: report.loading ? 0.6 : 1, transition: 'opacity .2s' }}>
          <div className="grid grid-4">
            <div className="card stat">
              <span className="stat-label">{t('admin.kpi.occupancy')}</span>
              <span className="stat-value hero">{fmtPercent(r.totals.occupancyRate)}</span>
              <span className="stat-hint">{t('admin.kpi.occupancyHint')}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">{t('admin.kpi.noShow')}</span>
              <span className="stat-value">{fmtPercent(r.totals.noShowRate)}</span>
              <span className="stat-hint">{t('admin.kpi.noShowHint', { n: r.totals.noShows, m: r.totals.checkInEligible })}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">{t('admin.kpi.bookings')}</span>
              <span className="stat-value">{fmtNumber(r.totals.bookings)}</span>
              <span className="stat-hint">
                {r.totals.resources} {t(`kindsPlural.${kind || 'all'}`)}
              </span>
            </div>
            <div className="card stat">
              <span className="stat-label">{t('admin.kpi.bookingRate')}</span>
              <span className="stat-value">{fmtPercent(r.totals.bookingRate)}</span>
              <span className="stat-hint">{t('admin.kpi.bookingRateHint')}</span>
            </div>
          </div>
          <div className="grid grid-2">
            <section className="card">
              <h2>{t('admin.kpi.peak')}</h2>
              <p className="small muted">{t('admin.kpi.peakHint')}</p>
              <ColumnChart
                ariaLabel={t('admin.kpi.peak')}
                data={r.peakHours.map((p) => ({ label: `${String(p.hour).padStart(2, '0')}`, value: p.averageOccupancy, detail: `${String(p.hour).padStart(2, '0')}:00–${String(p.hour + 1).padStart(2, '0')}:00` }))}
                format={(v) => fmtPercent(v).replace(',0', '')}
              />
            </section>
            <section className="card">
              <h2>{t('admin.kpi.perResource')}</h2>
              <p className="small muted">{t('admin.kpi.occupancy')}</p>
              <HBarList
                rows={r.perResource.slice(0, 15).map((p) => ({
                  label: p.resourceName,
                  value: p.occupancyRate,
                  title: `${p.bookings} ${t('admin.kpi.bookings').toLowerCase()}, ${p.noShows} no-show`,
                }))}
                format={fmtPercent}
                max={Math.max(0.01, ...r.perResource.map((p) => p.occupancyRate))}
              />
            </section>
          </div>
          <section className="card">
            <div className="card-title">
              <h2>{t('admin.kpi.table')}</h2>
              <button className="btn small" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
                {showTable ? t('common.close') : t('common.details')}
              </button>
            </div>
            <p className="small muted">
              {t('admin.kpi.workingHours', { start: r.workingHours.start, end: r.workingHours.end })} · {t('admin.kpi.privacy')}
            </p>
            {showTable && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>{t('admin.kpi.resource')}</th>
                      <th className="num">{t('admin.kpi.bookings')}</th>
                      <th className="num">{t('admin.kpi.availableMin')}</th>
                      <th className="num">{t('admin.kpi.bookedMin')}</th>
                      <th className="num">{t('admin.kpi.occupiedMin')}</th>
                      <th className="num">{t('admin.kpi.occupancyCol')}</th>
                      <th className="num">{t('admin.kpi.noShowCol')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.perResource.map((p) => (
                      <tr key={p.resourceId}>
                        <td>{p.resourceName}</td>
                        <td className="num">{fmtNumber(p.bookings)}</td>
                        <td className="num">{fmtNumber(Math.round(p.availableMinutes))}</td>
                        <td className="num">{fmtNumber(p.bookedMinutes)}</td>
                        <td className="num">{fmtNumber(p.occupiedMinutes)}</td>
                        <td className="num">{fmtPercent(p.occupancyRate)}</td>
                        <td className="num">
                          {p.noShows} ({fmtPercent(p.noShowRate)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
