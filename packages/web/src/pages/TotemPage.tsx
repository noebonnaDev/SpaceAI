import type { LiveResourceState } from '@ritrovo/shared';
import { useCallback, useEffect, useState } from 'react';
import { fmtTime } from '../format';
import { t } from '../i18n';
import { kioskApi, useClock, useKioskToken, useWakeLock } from './KioskPage';

interface TotemState {
  kind: 'totem';
  deviceName: string;
  rooms: Array<LiveResourceState & { capacity: number }>;
  desks: { total: number; busy: number };
}

/** Lobby totem / digital signage view: availability of all rooms in a building. */
export function TotemPage() {
  const token = useKioskToken();
  const api = kioskApi(token);
  const now = useClock();
  useWakeLock();
  const [state, setState] = useState<TotemState | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState(await api.get<TotemState>('/api/kiosk/state'));
      setOffline(false);
    } catch {
      setOffline(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 30_000);
    return () => clearInterval(h);
  }, [load]);

  if (!token) {
    return (
      <div className="totem">
        <h1>{t('kiosk.pairTitle')}</h1>
        <p>{t('kiosk.pairHint')}</p>
      </div>
    );
  }
  const label = (s: LiveResourceState['state']) =>
    ({ free: t('kiosk.free'), occupied: t('kiosk.occupied'), awaiting_check_in: t('kiosk.awaiting'), booked: t('kiosk.booked') })[s];

  return (
    <div className="totem">
      <div className="kiosk-head">
        <h1 style={{ margin: 0 }}>{t('kiosk.totemTitle')}</h1>
        <div className="kiosk-clock">{now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}</div>
      </div>
      {offline && <p>{t('kiosk.error')}</p>}
      {state && (
        <>
          <p style={{ fontSize: '1.2rem' }}>{t('kiosk.desksFree', { free: state.desks.total - state.desks.busy, total: state.desks.total })}</p>
          <div className="totem-grid">
            {state.rooms.map((r) => (
              <div key={r.resourceId} className={`totem-card ${r.state}`}>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{r.resourceName}</div>
                <div style={{ opacity: 0.85 }}>
                  {r.floorName} · {t('common.capacity', { n: r.capacity })}
                </div>
                <div style={{ fontSize: '1.6rem', fontWeight: 800, margin: '10px 0' }}>{label(r.state)}</div>
                {r.currentBooking && <div>{t('kiosk.until', { time: fmtTime(r.currentBooking.effectiveEnd ?? r.currentBooking.end) })}</div>}
                {!r.currentBooking && r.nextBooking && <div>{t('kiosk.nextAt', { time: fmtTime(r.nextBooking.start) })}</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
