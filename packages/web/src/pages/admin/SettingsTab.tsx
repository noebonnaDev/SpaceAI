import { useEffect, useState, type FormEvent } from 'react';
import { ErrorBox, Field, Spinner, useAsync, useToast } from '../../components/ui';
import { t, tList } from '../../i18n';
import { useSession } from '../../session';

interface Settings {
  checkInGraceMinutes: number;
  checkInOpensMinutesBefore: number;
  workingHours: { days: number[]; start: string; end: string };
  retentionDays: number;
  auditRetentionDays: number;
  proposalHoldMinutes: number;
  calendarEntryForUnmanaged: boolean;
  showOccupantNames: boolean;
  kioskShowSubject: boolean;
  kioskShowOrganizer: boolean;
  recurrenceMaxOccurrences: number;
  recurrenceMaxConflicts: number;
}

/** Global booking rules, presence-control rules and data retention. */
export function SettingsTab() {
  const { api } = useSession();
  const toast = useToast();
  const loaded = useAsync(() => api.get<Settings>('/api/admin/settings'), []);
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (loaded.data) setS(loaded.data);
  }, [loaded.data]);
  if (!s) return loaded.error ? <ErrorBox error={loaded.error} /> : <Spinner />;

  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: Number(e.target.value) });
  const bool = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.checked });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      setS(await api.put<Settings>('/api/admin/settings', s));
      toast(t('admin.settings.saved'));
    } catch (err) {
      setError(err);
    }
  };
  const weekdays = tList('booking.weekdays');

  return (
    <form className="stack" style={{ gap: 16 }} onSubmit={save}>
      <section className="card stack">
        <h2>{t('admin.tabs.settings')}</h2>
        <div className="row">
          <Field label={t('admin.settings.grace')}>
            <input type="number" min={1} max={240} value={s.checkInGraceMinutes} onChange={num('checkInGraceMinutes')} />
          </Field>
          <Field label={t('admin.settings.opensBefore')}>
            <input type="number" min={0} max={120} value={s.checkInOpensMinutesBefore} onChange={num('checkInOpensMinutesBefore')} />
          </Field>
          <Field label={t('admin.settings.proposalHold')}>
            <input type="number" min={15} max={10080} value={s.proposalHoldMinutes} onChange={num('proposalHoldMinutes')} />
          </Field>
        </div>
        <div className="row">
          <Field label={t('admin.settings.workStart')}>
            <input type="time" value={s.workingHours.start} onChange={(e) => setS({ ...s, workingHours: { ...s.workingHours, start: e.target.value } })} />
          </Field>
          <Field label={t('admin.settings.workEnd')}>
            <input type="time" value={s.workingHours.end} onChange={(e) => setS({ ...s, workingHours: { ...s.workingHours, end: e.target.value } })} />
          </Field>
          <div className="field">
            <span>{t('admin.settings.workingDays')}</span>
            <div className="chips">
              {weekdays.map((w, i) => (
                <button
                  key={w}
                  type="button"
                  className="chip-toggle"
                  aria-pressed={s.workingHours.days.includes(i + 1)}
                  onClick={() => {
                    const d = s.workingHours.days.includes(i + 1) ? s.workingHours.days.filter((x) => x !== i + 1) : [...s.workingHours.days, i + 1].sort();
                    setS({ ...s, workingHours: { ...s.workingHours, days: d } });
                  }}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="row">
          <Field label={t('admin.settings.maxOccurrences')}>
            <input type="number" min={2} max={260} value={s.recurrenceMaxOccurrences} onChange={num('recurrenceMaxOccurrences')} />
          </Field>
          <Field label={t('admin.settings.maxConflicts')}>
            <input type="number" min={0} max={20} value={s.recurrenceMaxConflicts} onChange={num('recurrenceMaxConflicts')} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.calendarEntryForUnmanaged} onChange={bool('calendarEntryForUnmanaged')} /> {t('admin.settings.calendarEntry')}
        </label>
      </section>
      <section className="card stack">
        <h2>{t('admin.settings.privacy')}</h2>
        <div className="row">
          <Field label={t('admin.settings.retention')}>
            <input type="number" min={30} max={3650} value={s.retentionDays} onChange={num('retentionDays')} />
          </Field>
          <Field label={t('admin.settings.auditRetention')}>
            <input type="number" min={30} max={3650} value={s.auditRetentionDays} onChange={num('auditRetentionDays')} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.showOccupantNames} onChange={bool('showOccupantNames')} /> {t('admin.settings.showNames')}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.kioskShowOrganizer} onChange={bool('kioskShowOrganizer')} /> {t('admin.settings.kioskOrganizer')}
        </label>
        <label className="check">
          <input type="checkbox" checked={s.kioskShowSubject} onChange={bool('kioskShowSubject')} /> {t('admin.settings.kioskSubject')}
        </label>
      </section>
      <ErrorBox error={error} />
      <div>
        <button className="btn primary">{t('common.save')}</button>
      </div>
    </form>
  );
}
