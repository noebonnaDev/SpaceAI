import type { BookingDto, ResourceDto } from '@ritrovo/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, createApi } from '../api';
import { fmtTime } from '../format';
import { t } from '../i18n';

const KEY = 'ritrovo.kioskToken';

/** Reads the pairing token from the URL fragment (#t=...) once and keeps it on the device. */
export function useKioskToken(): string | null {
  const [token] = useState(() => {
    const m = window.location.hash.match(/t=([A-Za-z0-9_-]+)/);
    if (m) {
      try {
        localStorage.setItem(KEY, m[1]!);
      } catch {
        /* storage unavailable: keep the token for this session only */
      }
      history.replaceState(null, '', window.location.pathname);
      return m[1]!;
    }
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  return token;
}

export const kioskApi = (token: string | null) => createApi(async () => token, 'Kiosk');

/** True when the server rejects the device key (revoked or unknown): the key is forgotten so the screen asks to be paired again. */
export function isUnpaired(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401) return false;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  return true;
}

interface PanelState {
  kind: 'panel';
  deviceName: string;
  now: string;
  resource: ResourceDto;
  state: 'free' | 'booked' | 'occupied' | 'awaiting_check_in';
  current: BookingDto | null;
  checkInCandidate: BookingDto | null;
  agenda: BookingDto[];
}

export function useClock(): Date {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(h);
  }, []);
  return now;
}

export function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, []);
}

/** Full-screen room door panel for a wall-mounted tablet. */
export function KioskPage() {
  const token = useKioskToken();
  const api = kioskApi(token);
  const now = useClock();
  useWakeLock();
  const [state, setState] = useState<PanelState | null>(null);
  const [offline, setOffline] = useState(false);
  const [unpaired, setUnpaired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setState(await api.get<PanelState>('/api/kiosk/state'));
      setOffline(false);
    } catch (err) {
      if (isUnpaired(err)) setUnpaired(true);
      else setOffline(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void load();
    const h = setInterval(() => void load(), 20_000);
    return () => clearInterval(h);
  }, [load]);

  const act = async (url: string, body?: unknown) => {
    setBusy(true);
    setMessage(null);
    try {
      await api.post(url, body ?? {});
      await load();
    } catch (err) {
      if (isUnpaired(err)) setUnpaired(true);
      else setMessage((err as Error).message);
    } finally {
      setBusy(false);
      setTimeout(() => setMessage(null), 6000);
    }
  };

  if (!token || unpaired) {
    return (
      <div className="kiosk unpaired">
        <h1 className="kiosk-room">{t('kiosk.pairTitle')}</h1>
        <p>{t('kiosk.pairHint')}</p>
      </div>
    );
  }
  if (!state) {
    return <div className="kiosk unpaired">{offline ? t('kiosk.error') : t('common.loading')}</div>;
  }

  const label = { free: t('kiosk.free'), occupied: t('kiosk.occupied'), awaiting_check_in: t('kiosk.awaiting'), booked: t('kiosk.booked') }[state.state];
  const upcoming = state.agenda.filter((b) => new Date(b.start) > now);
  const next = upcoming[0];
  const freeUntil = next ? new Date(next.start) : null;
  const minutesFree = freeUntil ? Math.floor((freeUntil.getTime() - now.getTime()) / 60_000) : 24 * 60;
  const canCheckIn = Boolean(state.checkInCandidate && !state.checkInCandidate.checkedInAt);
  const graceLeft =
    state.checkInCandidate && state.resource.policy.checkInRequired
      ? Math.max(0, Math.ceil((new Date(state.checkInCandidate.start).getTime() + state.resource.policy.checkInGraceMinutes * 60_000 - now.getTime()) / 60_000))
      : null;

  return (
    <div className={`kiosk ${state.state}`}>
      <div className="kiosk-head">
        <div className="kiosk-room">{state.resource.name}</div>
        <div className="kiosk-clock" aria-live="off">
          {now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })}
        </div>
      </div>
      <div className="kiosk-main">
        <div className="stack" style={{ gap: 24 }}>
          <div className="kiosk-state" role="status">
            {label}
          </div>
          {state.current && (
            <div style={{ fontSize: '1.5rem' }}>
              {state.current.title ?? t('kiosk.meeting')}
              {state.current.organizerName ? ` · ${state.current.organizerName}` : ''}
              <br />
              {t('kiosk.until', { time: fmtTime(state.current.effectiveEnd ?? state.current.end) })}
            </div>
          )}
          {state.state === 'free' && <div style={{ fontSize: '1.4rem' }}>{next ? t('kiosk.nextAt', { time: fmtTime(next.start) }) : t('kiosk.noMore')}</div>}
          {canCheckIn && graceLeft !== null && <div>{t('kiosk.releaseIn', { n: graceLeft })}</div>}
          <div className="kiosk-actions">
            {canCheckIn && (
              <button className="btn" disabled={busy} onClick={() => void act('/api/kiosk/check-in')}>
                {t('kiosk.checkIn')}
              </button>
            )}
            {state.current?.checkedInAt && (
              <button className="btn secondary" disabled={busy} onClick={() => void act('/api/kiosk/check-out')}>
                {t('kiosk.checkOut')}
              </button>
            )}
            {state.state === 'free' &&
              !canCheckIn &&
              [15, 30, 60]
                .filter((m) => m <= minutesFree)
                .map((m) => (
                  <button key={m} className="btn" disabled={busy} onClick={() => void act('/api/kiosk/book-now', { minutes: m })}>
                    {t('kiosk.bookNow')} · {t('kiosk.bookMinutes', { n: m })}
                  </button>
                ))}
          </div>
          {message && <div className="kiosk-panel">{message}</div>}
          {offline && <div className="kiosk-panel">{t('kiosk.error')}</div>}
        </div>
        <div className="kiosk-panel">
          <h2>{t('kiosk.today')}</h2>
          {state.agenda.length === 0 && <p>{t('kiosk.noMore')}</p>}
          {state.agenda.map((b) => (
            <div key={b.id} className="kiosk-agenda-item">
              <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtTime(b.start)}–{fmtTime(b.effectiveEnd ?? b.end)}
              </strong>
              <span>{b.title ?? b.organizerName ?? t('kiosk.meeting')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
