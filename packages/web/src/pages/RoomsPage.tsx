import type { BuildingDto, ResourceDto } from '@ritrovo/shared';
import { FEATURES } from '@ritrovo/shared';
import { useState } from 'react';
import { BookingDialog } from '../components/BookingDialog';
import { ErrorBox, Features, Field, Spinner, useAsync } from '../components/ui';
import { addMinutesToTime, localToIso, nextQuarter, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';
import { DateInput, TimeInput } from '../components/DateTime';

/** Meeting room search with advanced filters and live availability (Ritrovo + Exchange free/busy). */
export function RoomsPage({ onBehalf = false }: { onBehalf?: boolean }) {
  const { api, can } = useSession();
  const [date, setDate] = useState(todayLocal());
  const [from, setFrom] = useState(nextQuarter());
  const [to, setTo] = useState(addMinutesToTime(nextQuarter(), 60));
  const [people, setPeople] = useState(1);
  const [features, setFeatures] = useState<string[]>([]);
  const [buildingId, setBuildingId] = useState('');
  const [floorId, setFloorId] = useState('');
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [selected, setSelected] = useState<ResourceDto | null>(null);

  const buildings = useAsync(() => api.get<BuildingDto[]>('/api/buildings'), []);
  const valid = from < to;
  const query = new URLSearchParams({ kind: 'room', minCapacity: String(people) });
  if (features.length) query.set('features', features.join(','));
  if (buildingId) query.set('buildingId', buildingId);
  if (floorId) query.set('floorId', floorId);
  if (valid) {
    query.set('start', localToIso(date, from));
    query.set('end', localToIso(date, to));
  }
  const rooms = useAsync(() => api.get<ResourceDto[]>(`/api/resources?${query}`), [query.toString()]);
  const list = (rooms.data ?? []).filter((r) => !onlyAvailable || r.available !== false);
  const floors = buildings.data?.find((b) => b.id === buildingId)?.floors ?? buildings.data?.flatMap((b) => b.floors) ?? [];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <h1>{onBehalf ? t('reception.bookOnBehalf') : t('rooms.title')}</h1>
      </div>
      <section className="card stack" aria-label={t('rooms.filters')}>
        <div className="row">
          <Field label={t('common.date')}>
            <DateInput value={date} onChange={(v) => setDate(v)} />
          </Field>
          <Field label={t('common.from')}>
            <TimeInput value={from} onChange={(v) => setFrom(v)} />
          </Field>
          <Field label={t('common.to')}>
            <TimeInput value={to} onChange={(v) => setTo(v)} />
          </Field>
          <Field label={t('common.people')}>
            <input type="number" min={1} max={200} value={people} onChange={(e) => setPeople(Math.max(1, Number(e.target.value) || 1))} style={{ width: 90 }} />
          </Field>
          <Field label={t('common.building')}>
            <select
              value={buildingId}
              onChange={(e) => {
                setBuildingId(e.target.value);
                setFloorId('');
              }}
            >
              <option value="">{t('common.all')}</option>
              {buildings.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.floor')}>
            <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              <option value="">{t('common.all')}</option>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row center">
          <span className="field-label">{t('common.features')}</span>
          <div className="chips">
            {FEATURES.filter((f) => !['monitor', 'docking', 'scrivania_regolabile', 'finestra'].includes(f)).map((f) => (
              <button
                key={f}
                type="button"
                className="chip-toggle"
                aria-pressed={features.includes(f)}
                onClick={() => setFeatures((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]))}
              >
                {t(`features.${f}`)}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={onlyAvailable} onChange={(e) => setOnlyAvailable(e.target.checked)} /> {t('rooms.onlyAvailable')}
          </label>
        </div>
      </section>

      <ErrorBox error={rooms.error} onRetry={rooms.reload} />
      {rooms.loading && !rooms.data && <Spinner />}
      {rooms.data && <p className="muted small">{list.length === 1 ? t('rooms.resultsOne') : t('rooms.results', { n: list.length })}</p>}
      {rooms.data && list.length === 0 && <div className="card empty">{t('rooms.noResults')}</div>}
      <div className="grid grid-3" style={{ opacity: rooms.loading ? 0.6 : 1 }}>
        {list.map((r) => (
          <article key={r.id} className="card resource-card">
            <div className="row center">
              <h3>{r.name}</h3>
              <span className="spacer" />
              {r.available === undefined ? null : r.available ? (
                <span className="badge good">● {t('common.available')}</span>
              ) : (
                <span className="badge critical">■ {t('common.unavailable')}</span>
              )}
            </div>
            <div className="meta">
              <span>{r.capacity === 1 ? t('common.capacityOne') : t('common.capacity', { n: r.capacity })}</span>
              {r.floorName && <span>{r.floorName}</span>}
              {r.buildingName && <span>{r.buildingName}</span>}
            </div>
            <Features list={r.features} />
            <button className="btn primary" disabled={!valid} onClick={() => setSelected(r)}>
              {t('common.book')}
            </button>
          </article>
        ))}
      </div>
      <BookingDialog
        api={api}
        open={!!selected}
        resource={selected}
        defaults={{ date, from, to }}
        onClose={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          rooms.reload();
        }}
        allowRecurrence
        onBehalf={onBehalf || can('reception')}
        source={onBehalf ? 'reception' : 'web'}
      />
    </div>
  );
}
