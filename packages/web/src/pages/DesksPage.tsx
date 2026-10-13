import type { BuildingDto, DeskMapEntry, ResourceDto } from '@ritrovo/shared';
import { useEffect, useState } from 'react';
import { BookingDialog } from '../components/BookingDialog';
import { ErrorBox, Features, Field, Spinner, useAsync, useToast } from '../components/ui';
import { fmtTime, localToIso, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

interface ColleagueHit {
  userId: string;
  displayName: string;
  resourceId: string;
  resourceName: string;
  floorId: string | null;
  floorName: string | null;
  start: string;
  end: string;
}

/** Desk booking on an interactive floor plan, with favourites and "find a colleague". */
export function DesksPage() {
  const { api } = useSession();
  const toast = useToast();
  const buildings = useAsync(() => api.get<BuildingDto[]>('/api/buildings'), []);
  const floors = (buildings.data ?? []).flatMap((b) => b.floors.map((f) => ({ ...f, buildingName: b.name })));
  const [floorId, setFloorId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [from, setFrom] = useState('09:00');
  const [to, setTo] = useState('18:00');
  const [selected, setSelected] = useState<DeskMapEntry | null>(null);
  const [booking, setBooking] = useState<ResourceDto | null>(null);
  const [colleague, setColleague] = useState('');
  const [hits, setHits] = useState<ColleagueHit[] | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    if (!floorId && floors.length) setFloorId(floors[floors.length > 1 ? 1 : 0]!.id);
  }, [floors.length, floorId]);

  const floor = floors.find((f) => f.id === floorId);
  const valid = from < to;
  const desks = useAsync(
    () =>
      floorId && valid
        ? api.get<DeskMapEntry[]>(`/api/floors/${floorId}/desks?start=${encodeURIComponent(localToIso(date, from))}&end=${encodeURIComponent(localToIso(date, to))}`)
        : Promise.resolve([] as DeskMapEntry[]),
    [floorId, date, from, to],
  );

  const toggleFavorite = async (e: DeskMapEntry) => {
    try {
      if (e.resource.isFavorite) await fetchFav('DELETE', e.resource.id);
      else await fetchFav('PUT', e.resource.id);
      desks.reload();
      setSelected(null);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const fetchFav = (method: 'PUT' | 'DELETE', id: string) => (method === 'PUT' ? api.put(`/api/favorites/${id}`) : api.del(`/api/favorites/${id}`));

  const findColleague = async () => {
    try {
      const res = await api.get<ColleagueHit[]>(`/api/colleagues?q=${encodeURIComponent(colleague)}&date=${date}`);
      setHits(res);
      const first = res[0];
      if (first?.floorId) {
        setFloorId(first.floorId);
        setHighlight(first.resourceId);
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const entries = desks.data ?? [];
  const deskEntries = entries.filter((e) => e.resource.kind === 'desk');

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <h1>{t('desks.title')}</h1>
      </div>
      <section className="card stack">
        <div className="row">
          <Field label={t('common.floor')}>
            <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.buildingName} – {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('common.date')}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('common.from')}>
            <input type="time" step={300} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('common.to')}>
            <input type="time" step={300} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <span className="spacer" />
          <Field label={t('desks.findColleague')}>
            <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <input value={colleague} onChange={(e) => setColleague(e.target.value)} placeholder={t('desks.findPlaceholder')} onKeyDown={(e) => e.key === 'Enter' && void findColleague()} />
              <button type="button" className="btn" disabled={colleague.trim().length < 2} onClick={() => void findColleague()}>
                {t('common.search')}
              </button>
            </div>
          </Field>
        </div>
        {hits && (
          <div className="alert info">
            {hits.length === 0
              ? t('desks.colleagueNotFound')
              : hits.map((h) => (
                  <div key={`${h.userId}-${h.start}`}>
                    {t('desks.colleagueAt', { name: h.displayName, desk: h.resourceName, floor: h.floorName ?? '', from: fmtTime(h.start), to: fmtTime(h.end) })}
                  </div>
                ))}
          </div>
        )}
      </section>

      <ErrorBox error={desks.error ?? buildings.error} onRetry={desks.reload} />
      {(desks.loading && !desks.data) || buildings.loading ? <Spinner /> : null}

      <div className="two-col">
        <section className="card">
          <h2 className="sr-only">{t('desks.map')}</h2>
          {floor?.hasMap ? (
            <div className="floormap" style={{ opacity: desks.loading ? 0.6 : 1 }}>
              <img src={`/api/floors/${floor.id}/map?v=${floor.mapVersion ?? ''}`} alt={`${t('desks.map')} ${floor.name}`} />
              {entries
                .filter((e) => e.resource.mapX !== null && e.resource.mapY !== null)
                .map((e) => (
                  <button
                    key={e.resource.id}
                    type="button"
                    className={`marker ${e.state} ${e.resource.kind === 'room' ? 'room' : ''} ${highlight === e.resource.id ? 'highlight' : ''}`}
                    style={{ left: `${e.resource.mapX! * 100}%`, top: `${e.resource.mapY! * 100}%` }}
                    onClick={() => setSelected(e)}
                    aria-label={`${e.resource.name}: ${e.state === 'free' ? t('desks.legendFree') : e.state === 'mine' ? t('desks.legendMine') : t('desks.legendBooked')}`}
                    title={e.occupantName ? t('desks.occupiedBy', { name: e.occupantName }) : e.resource.name}
                  >
                    {e.resource.kind === 'room' ? '◯' : e.resource.name}
                    {e.resource.isFavorite && <span className="fav">★</span>}
                  </button>
                ))}
            </div>
          ) : (
            <p className="muted">{t('desks.noMap')}</p>
          )}
          <div className="legend">
            <span>
              <i style={{ background: '#0b8a0b' }} /> {t('desks.legendFree')}
            </span>
            <span>
              <i style={{ background: '#7d7a73' }} /> {t('desks.legendBooked')}
            </span>
            <span>
              <i style={{ background: '#1c5cab' }} /> {t('desks.legendMine')}
            </span>
            <span>★ {t('desks.legendFavorite')}</span>
          </div>
        </section>
        <aside className="card">
          {selected ? (
            <div className="stack">
              <h2>
                {t(`kinds.${selected.resource.kind}`)} {selected.resource.name}
              </h2>
              <Features list={selected.resource.features} />
              {selected.state === 'free' && <span className="badge good">● {t('desks.legendFree')}</span>}
              {selected.state === 'booked' && (
                <span className="badge critical">■ {selected.occupantName ? t('desks.occupiedBy', { name: selected.occupantName }) : t('desks.occupied')}</span>
              )}
              {selected.state === 'mine' && <span className="badge info">◆ {t('desks.legendMine')}</span>}
              {selected.state === 'free' && (
                <button className="btn primary" disabled={!valid} onClick={() => setBooking(selected.resource)}>
                  {t('common.book')}
                </button>
              )}
              <button className="btn" onClick={() => void toggleFavorite(selected)}>
                {selected.resource.isFavorite ? `☆ ${t('desks.unfavorite')}` : `★ ${t('desks.favorite')}`}
              </button>
            </div>
          ) : (
            <div className="stack">
              <h2>{t('desks.listView')}</h2>
              <div className="stack" style={{ gap: 4 }}>
                {deskEntries
                  .slice()
                  .sort((a, b) => Number(b.resource.isFavorite ?? false) - Number(a.resource.isFavorite ?? false) || a.resource.name.localeCompare(b.resource.name))
                  .map((e) => (
                    <button key={e.resource.id} className="btn ghost" style={{ justifyContent: 'space-between' }} onClick={() => setSelected(e)}>
                      <span>
                        {e.resource.isFavorite ? '★ ' : ''}
                        {e.resource.name}
                      </span>
                      <span className={`badge ${e.state === 'free' ? 'good' : e.state === 'mine' ? 'info' : 'critical'}`}>
                        {e.state === 'free' ? t('desks.legendFree') : e.state === 'mine' ? t('desks.legendMine') : t('desks.legendBooked')}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </aside>
      </div>
      <BookingDialog
        api={api}
        open={!!booking}
        resource={booking}
        defaults={{ date, from, to }}
        allowMultiDay
        onClose={() => setBooking(null)}
        onDone={() => {
          setBooking(null);
          setSelected(null);
          desks.reload();
        }}
      />
    </div>
  );
}
