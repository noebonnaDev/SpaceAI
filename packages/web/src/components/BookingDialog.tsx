import type { AlternativeSlot, BookingDto, ConflictPayload, ResourceDto } from '@ritrovo/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api } from '../api';
import { addDaysLocal, fmtDate, fmtDateTime, fmtTime, isoWeekday, localToIso } from '../format';
import { t, tList } from '../i18n';
import { Dialog, ErrorBox, Field, useToast } from './ui';
import { PeoplePicker, type Person } from './PeoplePicker';

export interface BookingDefaults {
  date: string;
  from: string;
  to: string;
  title?: string;
}

interface Props {
  api: Api;
  open: boolean;
  resource: ResourceDto | null;
  defaults: BookingDefaults;
  onClose: () => void;
  onDone: (bookings: BookingDto[]) => void;
  allowRecurrence?: boolean;
  allowMultiDay?: boolean;
  onBehalf?: boolean;
  source?: 'web' | 'addin' | 'reception';
}

type RecType = 'none' | 'daily' | 'weekly';

export function BookingDialog({ api, open, resource, defaults, onClose, onDone, allowRecurrence, allowMultiDay, onBehalf, source = 'web' }: Props) {
  const toast = useToast();
  const [title, setTitle] = useState(defaults.title ?? '');
  const [date, setDate] = useState(defaults.date);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [teams, setTeams] = useState(false);
  const [attendees, setAttendees] = useState('');
  const [bookedFor, setBookedFor] = useState<Person | null>(null);
  const [rec, setRec] = useState<RecType>('none');
  const [interval, setInterval] = useState(1);
  const [days, setDays] = useState<number[]>([]);
  const [until, setUntil] = useState(addDaysLocal(defaults.date, 28));
  const [multiDay, setMultiDay] = useState(false);
  const [toDate, setToDate] = useState(addDaysLocal(defaults.date, 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<ConflictPayload | null>(null);
  const [occChoice, setOccChoice] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setTitle(defaults.title ?? '');
    setDate(defaults.date);
    setFrom(defaults.from);
    setTo(defaults.to);
    setDays([isoWeekday(defaults.date)]);
    setUntil(addDaysLocal(defaults.date, 28));
    setToDate(addDaysLocal(defaults.date, 4));
    setRec('none');
    setMultiDay(false);
    setConflict(null);
    setError(null);
    setOccChoice({});
    setBookedFor(null);
  }, [open, defaults.date, defaults.from, defaults.to, defaults.title, resource?.id]);

  if (!resource) return null;
  const isRoom = resource.kind === 'room';

  const base = (resourceId = resource.id, f = from, tt = to) => ({
    resourceId,
    start: localToIso(date, f),
    end: localToIso(date, tt),
    title: title.trim() || undefined,
    isOnlineMeeting: isRoom ? teams : undefined,
    attendeeEmails: attendees
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    bookedForEmail: bookedFor?.email,
    bookedForName: bookedFor?.displayName,
    source: bookedFor ? 'reception' : source,
  });

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409 && err.details?.alternatives) {
      setConflict(err.details as ConflictPayload);
      setError(null);
    } else {
      setError(err);
    }
  };

  async function submitSingle(resourceId = resource!.id, f = from, tt = to) {
    setBusy(true);
    setError(null);
    try {
      const b = await api.post<BookingDto>('/api/bookings', base(resourceId, f, tt));
      toast(b.status === 'pending' ? t('booking.createdPending') : t('booking.created'));
      onDone([b]);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitRecurring(strategy: 'ask' | 'skip') {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ bookings: BookingDto[]; skipped: { start: string }[]; alternatives: BookingDto[] }>(
        '/api/bookings/recurring',
        {
          ...base(),
          recurrence: { type: rec, interval, daysOfWeek: rec === 'weekly' ? days : undefined, until },
          conflictStrategy: strategy,
          alternatives: strategy === 'skip' ? Object.fromEntries(Object.entries(occChoice).filter(([, v]) => v)) : undefined,
        },
      );
      toast(t('booking.seriesCreated', { n: res.bookings.length + res.alternatives.length }));
      if (res.skipped.length) toast(t('booking.skippedDates', { dates: res.skipped.map((s) => fmtDate(s.start)).join(', ') }));
      onDone([...res.bookings, ...res.alternatives]);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitMultiDay() {
    const dates: string[] = [];
    for (let d = date; d <= toDate && dates.length < 31; d = addDaysLocal(d, 1)) if (isoWeekday(d) <= 5) dates.push(d);
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ created: BookingDto[]; failed: { date: string; message: string }[] }>('/api/bookings/multi-day', {
        resourceId: resource!.id,
        dates,
        startTime: from,
        endTime: to,
        title: title.trim() || undefined,
        source: source === 'addin' ? 'addin' : 'web',
      });
      toast(t('booking.multiCreated', { n: res.created.length }));
      if (res.failed.length) toast(t('booking.multiFailed', { list: res.failed.map((f) => fmtDate(f.date)).join(', ') }), 'error');
      onDone(res.created);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details === null) {
        setError(new Error(t('booking.multiFailed', { list: dates.map(fmtDate).join(', ') })));
      } else handleError(err);
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setConflict(null);
    if (multiDay) void submitMultiDay();
    else if (rec !== 'none') void submitRecurring('ask');
    else void submitSingle();
  };

  const pickAlternative = (alt: AlternativeSlot) => {
    setConflict(null);
    if (alt.resourceId === resource.id) {
      const f = fmtTime(alt.start);
      const tt = fmtTime(alt.end);
      setFrom(f);
      setTo(tt);
      void submitSingle(resource.id, f, tt);
    } else {
      void submitSingle(alt.resourceId);
    }
  };

  const weekdays = tList('booking.weekdays');

  return (
    <Dialog
      open={open}
      title={t('rooms.bookTitle', { name: resource.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {conflict?.code === 'RECURRENCE_CONFLICT' ? (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void submitRecurring('skip')}>
              {t('booking.recurrenceSkip')}
            </button>
          ) : (
            <button type="submit" form="booking-form" className="btn primary" disabled={busy}>
              {busy ? t('common.loading') : t('common.book')}
            </button>
          )}
        </>
      }
    >
      <form id="booking-form" className="stack" onSubmit={onSubmit}>
        <Field label={t('common.title')}>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('booking.titlePlaceholder')} maxLength={200} />
        </Field>
        <div className="row">
          <Field label={t('common.date')}>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={t('common.from')}>
            <input type="time" required step={300} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label={t('common.to')}>
            <input type="time" required step={300} value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        {isRoom && (
          <>
            <label className="check">
              <input type="checkbox" checked={teams} onChange={(e) => setTeams(e.target.checked)} /> {t('booking.teams')}
            </label>
            <Field label={t('booking.attendees')}>
              <input value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="nome.cognome@azienda.it" />
            </Field>
          </>
        )}
        {onBehalf && (
          <Field label={t('booking.bookedFor')} hint={t('booking.bookedForHint')}>
            <PeoplePicker api={api} value={bookedFor} onChange={setBookedFor} />
          </Field>
        )}
        {allowMultiDay && (
          <>
            <label className="check">
              <input type="checkbox" checked={multiDay} onChange={(e) => setMultiDay(e.target.checked)} /> {t('booking.multiDay')}
            </label>
            {multiDay && (
              <Field label={t('booking.toDate')} hint={t('booking.multiDayHint')}>
                <input type="date" value={toDate} min={date} onChange={(e) => setToDate(e.target.value)} />
              </Field>
            )}
          </>
        )}
        {allowRecurrence && !multiDay && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <Field label={t('booking.recurrence')}>
              <select value={rec} onChange={(e) => setRec(e.target.value as RecType)}>
                <option value="none">{t('booking.recurrenceNone')}</option>
                <option value="daily">{t('booking.recurrenceDaily')}</option>
                <option value="weekly">{t('booking.recurrenceWeekly')}</option>
              </select>
            </Field>
            {rec !== 'none' && (
              <div className="row">
                <Field label={`${t('booking.every')} (${rec === 'weekly' ? t('booking.weeks') : t('booking.days')})`}>
                  <input type="number" min={1} max={12} value={interval} onChange={(e) => setInterval(Number(e.target.value) || 1)} />
                </Field>
                <Field label={t('booking.until')}>
                  <input type="date" value={until} min={date} onChange={(e) => setUntil(e.target.value)} />
                </Field>
              </div>
            )}
            {rec === 'weekly' && (
              <div className="chips" role="group" aria-label={t('booking.recurrence')}>
                {weekdays.map((w, i) => (
                  <button
                    key={w}
                    type="button"
                    className="chip-toggle"
                    aria-pressed={days.includes(i + 1)}
                    onClick={() => setDays((d) => (d.includes(i + 1) ? d.filter((x) => x !== i + 1) : [...d, i + 1].sort()))}
                  >
                    {w}
                  </button>
                ))}
              </div>
            )}
          </fieldset>
        )}
        {resource.policy.checkInRequired && <p className="small muted">{t('booking.releaseHint', { n: resource.policy.checkInGraceMinutes })}</p>}
        <ErrorBox error={error} />
        {conflict && conflict.code !== 'RECURRENCE_CONFLICT' && <ConflictPanel conflict={conflict} onPick={pickAlternative} />}
        {conflict?.code === 'RECURRENCE_CONFLICT' && (
          <div className="alert warning stack">
            <strong>{t('booking.recurrenceConflictTitle')}</strong>
            <span>{conflict.message}</span>
            {conflict.occurrences
              ?.filter((o) => o.conflict)
              .map((o) => (
                <div key={o.start} className="row center">
                  <span style={{ minWidth: 150 }}>{fmtDateTime(o.start)}</span>
                  <select value={occChoice[o.start] ?? ''} onChange={(e) => setOccChoice((c) => ({ ...c, [o.start]: e.target.value }))} style={{ maxWidth: 280 }}>
                    <option value="">{t('booking.recurrenceKeepSkipped')}</option>
                    {o.alternatives.map((a) => (
                      <option key={a.resourceId} value={a.resourceId}>
                        {t('booking.recurrenceAlternative')}: {a.resourceName}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
          </div>
        )}
      </form>
    </Dialog>
  );
}

export function ConflictPanel({ conflict, onPick }: { conflict: ConflictPayload; onPick: (a: AlternativeSlot) => void }) {
  return (
    <div className="alert warning stack" role="alert">
      <strong>{t('booking.conflictTitle')}</strong>
      <span>{conflict.message}</span>
      {conflict.alternatives.resources.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">{t('booking.alternativesRooms')}</span>
          <div className="chips">
            {conflict.alternatives.resources.map((a) => (
              <button key={a.resourceId} type="button" className="btn small" onClick={() => onPick(a)}>
                {a.resourceName}
              </button>
            ))}
          </div>
        </div>
      )}
      {conflict.alternatives.times.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">{t('booking.alternativesTimes')}</span>
          <div className="chips">
            {conflict.alternatives.times.map((a) => (
              <button key={a.start} type="button" className="btn small" onClick={() => onPick(a)}>
                {fmtTime(a.start)}–{fmtTime(a.end)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
