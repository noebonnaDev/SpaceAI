import type { BookingDto, LiveResourceState } from '@ritrovo/shared';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n';

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className={`toast ${x.kind === 'error' ? 'error' : ''}`}>
            {x.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- dialog

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={onClose} style={wide ? { width: 'min(860px, calc(100vw - 32px))' } : undefined}>
      {open && (
        <>
          <div className="modal-head">
            <h2>{title}</h2>
            <button type="button" className="btn ghost small" onClick={onClose} aria-label={t('common.close')}>
              ✕
            </button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- small pieces

export function Spinner({ label }: { label?: string }) {
  return <p className="muted">{label ?? t('common.loading')}</p>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      {(error as Error)?.message ?? t('common.error')}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="btn small" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

const STATUS_TONE: Record<string, string> = {
  pending: 'warning',
  confirmed: 'good',
  tentative: 'info',
  completed: '',
  released: 'critical',
  cancelled: '',
  declined: 'critical',
};
const STATUS_ICON: Record<string, string> = {
  pending: '⏳',
  confirmed: '✓',
  tentative: '◌',
  completed: '■',
  released: '↺',
  cancelled: '✕',
  declined: '⚠',
};

export function StatusBadge({ booking }: { booking: BookingDto }) {
  if (booking.checkedInAt && (booking.status === 'confirmed' || booking.status === 'pending')) {
    return <span className="badge good">✓ {t('status.checkedIn')}</span>;
  }
  return (
    <span className={`badge ${STATUS_TONE[booking.status] ?? ''}`}>
      <span aria-hidden="true">{STATUS_ICON[booking.status]}</span> {t(`status.${booking.status}`)}
      {booking.releaseReason ? ` (${t(`reasons.${booking.releaseReason}`)})` : ''}
    </span>
  );
}

const LIVE_TONE: Record<LiveResourceState['state'], string> = {
  free: 'good',
  booked: 'info',
  occupied: 'critical',
  awaiting_check_in: 'warning',
};
const LIVE_ICON: Record<LiveResourceState['state'], string> = { free: '●', booked: '◐', occupied: '■', awaiting_check_in: '⏳' };

export function LiveBadge({ state }: { state: LiveResourceState['state'] }) {
  return (
    <span className={`badge ${LIVE_TONE[state]}`}>
      <span aria-hidden="true">{LIVE_ICON[state]}</span> {t(`live.${state}`)}
    </span>
  );
}

export function Features({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="chips">
      {list.map((f) => (
        <span key={f} className="badge">
          {t(`features.${f}`) === `features.${f}` ? f : t(`features.${f}`)}
        </span>
      ))}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState((s) => ({ data: s.data, error, loading: false })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((x) => x + 1) };
}
