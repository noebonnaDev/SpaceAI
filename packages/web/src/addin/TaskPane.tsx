import type { BookingDto, ConflictPayload, PublicConfig, ResourceDto, ResourceKind, UserDto } from '@ritrovo/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, createApi } from '../api';
import { devSignIn, devTokenStore, loadPublicConfig } from '../auth';
import { ConflictPanel } from '../components/BookingDialog';
import { BookingList } from '../components/BookingList';
import { Logo } from '../components/Logo';
import { ErrorBox, Features, Field, Spinner, ToastProvider, useAsync, useToast } from '../components/ui';
import { addMinutesToTime, fmtDate, fmtTime, localDateOf, localToIso, nextQuarter, todayLocal } from '../format';
import { t } from '../i18n';
import { addinToken } from './addinAuth';
import { addRoomToMeeting, onAppointmentTimeChanged, readContext, type AddinContext } from './office';
import { DateInput, TimeInput } from '../components/DateTime';

const api = createApi(addinToken);

export function TaskPaneRoot({ office }: { office: typeof Office | undefined }) {
  return (
    <ToastProvider>
      <TaskPane office={office} />
    </ToastProvider>
  );
}

function TaskPane({ office }: { office: typeof Office | undefined }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [user, setUser] = useState<UserDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ctx, setCtx] = useState<AddinContext>({ kind: 'none' });

  const signIn = useCallback(async () => {
    setError(null);
    try {
      const cfg = await loadPublicConfig();
      setConfig(cfg);
      if (cfg.authMode === 'dev' && !devTokenStore.get()) return;
      setUser(await api.get<UserDto>('/api/me'));
    } catch (err) {
      setError(err instanceof ApiError ? err : new Error(t('addin.signInFailed')));
    }
  }, []);

  const refreshContext = useCallback(() => {
    readContext(office)
      .then(setCtx)
      .catch(() => setCtx({ kind: 'none' }));
  }, [office]);

  useEffect(() => {
    void signIn();
    refreshContext();
    if (office?.context?.mailbox?.item) onAppointmentTimeChanged(office, refreshContext);
  }, [signIn, refreshContext, office]);

  return (
    <div className="taskpane stack">
      <div className="row center" style={{ gap: 8 }}>
        <Logo size={24} />
        <h1 style={{ margin: 0 }}>{t('addin.title')}</h1>
      </div>
      {config?.graphMode === 'mock' && <div className="alert warning small">{t('app.demoBanner')}</div>}
      <ErrorBox error={error} onRetry={() => void signIn()} />
      {config?.authMode === 'dev' && !user && <DevPicker onDone={() => void signIn()} />}
      {!user && !error && config?.authMode === 'entra' && <Spinner />}
      {user && ctx.kind === 'organizer' && office && <OrganizerView office={office} ctx={ctx} />}
      {user && ctx.kind !== 'organizer' && <QuickBook ctx={ctx} />}
      {user && <MyToday />}
      {config && (
        <a className="small" href={config.publicBaseUrl} target="_blank" rel="noreferrer">
          {t('addin.openApp')}
        </a>
      )}
    </div>
  );
}

function DevPicker({ onDone }: { onDone: () => void }) {
  const users = useAsync(() => fetch('/api/auth/dev-users').then((r) => r.json() as Promise<UserDto[]>), []);
  return (
    <div className="card stack">
      <strong>{t('login.demoTitle')}</strong>
      <select defaultValue="" onChange={(e) => e.target.value && void devSignIn(e.target.value).then(onDone)}>
        <option value="">—</option>
        {users.data?.map((u) => (
          <option key={u.id} value={u.email}>
            {u.displayName} ({t(`roles.${u.role}`)})
          </option>
        ))}
      </select>
    </div>
  );
}

/** Composing a meeting in Outlook: free rooms for the meeting's time, added to the meeting with Office.js. */
function OrganizerView({ office, ctx }: { office: typeof Office; ctx: Extract<AddinContext, { kind: 'organizer' }> }) {
  const toast = useToast();
  const valid = ctx.end > ctx.start;
  const q = `kind=room&onlyAvailable=true&minCapacity=${Math.max(1, ctx.attendees)}&start=${encodeURIComponent(ctx.start.toISOString())}&end=${encodeURIComponent(ctx.end.toISOString())}`;
  const rooms = useAsync(() => (valid ? api.get<ResourceDto[]>(`/api/resources?${q}`) : Promise.resolve([])), [q]);
  const add = async (r: ResourceDto) => {
    if (!r.mailboxEmail) return;
    try {
      await addRoomToMeeting(office, { email: r.mailboxEmail, name: r.name });
      toast(t('addin.added', { name: r.name }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <section className="card stack">
      <h2>{t('addin.freeRooms')}</h2>
      <p className="small muted">
        {t('addin.meetingTime')}: {fmtDate(ctx.start)} {fmtTime(ctx.start)}–{fmtTime(ctx.end)}
      </p>
      {!valid && <p className="muted">{t('addin.noTime')}</p>}
      <ErrorBox error={rooms.error} onRetry={rooms.reload} />
      {rooms.loading && !rooms.data && <Spinner />}
      {rooms.data?.length === 0 && <p className="muted">{t('rooms.noResults')}</p>}
      {rooms.data
        ?.filter((r) => r.mailboxEmail)
        .map((r) => (
          <div key={r.id} className="stack" style={{ gap: 4, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <div className="row center">
              <strong>{r.name}</strong>
              <span className="muted small">{t('common.capacity', { n: r.capacity })}</span>
            </div>
            <Features list={r.features} />
            <button className="btn primary small" onClick={() => void add(r)}>
              {t('addin.addToMeeting')}
            </button>
          </div>
        ))}
    </section>
  );
}

/** Reading a message or a meeting: quick booking of a room, desk or shared resource. */
function QuickBook({ ctx }: { ctx: AddinContext }) {
  const toast = useToast();
  const initial = useMemo(() => {
    if (ctx.kind === 'attendee') return { date: localDateOf(ctx.start), from: fmtTime(ctx.start), to: fmtTime(ctx.end) };
    return { date: todayLocal(), from: nextQuarter(), to: addMinutesToTime(nextQuarter(), 60) };
  }, [ctx]);
  const [kind, setKind] = useState<ResourceKind>('room');
  const [date, setDate] = useState(initial.date);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [conflict, setConflict] = useState<ConflictPayload | null>(null);
  const valid = from < to;
  const q = valid ? `kind=${kind}&onlyAvailable=true&start=${encodeURIComponent(localToIso(date, from))}&end=${encodeURIComponent(localToIso(date, to))}` : '';
  const list = useAsync(() => (q ? api.get<ResourceDto[]>(`/api/resources?${q}`) : Promise.resolve([])), [q]);

  const book = async (resourceId: string, f = from, tt = to) => {
    setConflict(null);
    try {
      const b = await api.post<BookingDto>('/api/bookings', { resourceId, start: localToIso(date, f), end: localToIso(date, tt), source: 'addin' });
      toast(b.status === 'pending' ? t('booking.createdPending') : `${t('booking.created')} ${t('booking.openInOutlook')}`);
      list.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.alternatives) setConflict(err.details);
      else toast((err as Error).message, 'error');
    }
  };

  return (
    <section className="card stack">
      <h2>{t('addin.quickBook')}</h2>
      <div className="chips" role="tablist">
        {(['room', 'desk', 'asset'] as ResourceKind[]).map((k) => (
          <button key={k} type="button" className="chip-toggle" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {t(`kinds.${k}`)}
          </button>
        ))}
      </div>
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
      </div>
      {conflict && <ConflictPanel conflict={conflict} onPick={(a) => void book(a.resourceId, fmtTime(a.start), fmtTime(a.end))} />}
      <ErrorBox error={list.error} onRetry={list.reload} />
      {list.loading && !list.data && <Spinner />}
      {list.data?.slice(0, 12).map((r) => (
        <div key={r.id} className="row center" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>
          <span className="spacer">
            <strong>{r.name}</strong>
            {r.floorName && <span className="muted small"> · {r.floorName}</span>}
          </span>
          <button className="btn primary small" onClick={() => void book(r.id)}>
            {t('addin.bookDirect')}
          </button>
        </div>
      ))}
    </section>
  );
}

function MyToday() {
  const today = todayLocal();
  const mine = useAsync(() => api.get<BookingDto[]>(`/api/bookings/mine?date=${today}`), []);
  const list = (mine.data ?? []).filter((b) => !['cancelled', 'declined', 'released'].includes(b.status));
  return (
    <section className="card">
      <h2>{t('addin.myBookings')}</h2>
      {mine.loading && !mine.data && <Spinner />}
      {mine.data && list.length === 0 && <p className="muted small">{t('home.nothingToday')}</p>}
      <BookingList api={api} bookings={list} onChanged={mine.reload} compact />
    </section>
  );
}
