import type { ResourceDto } from '@ritrovo/shared';
import { useState } from 'react';
import { BookingDialog } from '../components/BookingDialog';
import { ErrorBox, Features, Field, Spinner, useAsync } from '../components/ui';
import { addMinutesToTime, localToIso, nextQuarter, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';
import { DateInput, TimeInput } from '../components/DateTime';

/** Shared resources (projectors, company cars, kits...). */
export function AssetsPage() {
  const { api } = useSession();
  const [date, setDate] = useState(todayLocal());
  const [from, setFrom] = useState(nextQuarter());
  const [to, setTo] = useState(addMinutesToTime(nextQuarter(), 120));
  const [selected, setSelected] = useState<ResourceDto | null>(null);
  const valid = from < to;
  const q = new URLSearchParams({ kind: 'asset' });
  if (valid) {
    q.set('start', localToIso(date, from));
    q.set('end', localToIso(date, to));
  }
  const assets = useAsync(() => api.get<ResourceDto[]>(`/api/resources?${q}`), [q.toString()]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <h1>{t('assets.title')}</h1>
      </div>
      <section className="card row">
        <Field label={t('common.date')}>
          <DateInput value={date} onChange={(v) => setDate(v)} />
        </Field>
        <Field label={t('common.from')}>
          <TimeInput value={from} onChange={(v) => setFrom(v)} />
        </Field>
        <Field label={t('common.to')}>
          <TimeInput value={to} onChange={(v) => setTo(v)} />
        </Field>
      </section>
      <ErrorBox error={assets.error} onRetry={assets.reload} />
      {assets.loading && !assets.data && <Spinner />}
      {assets.data?.length === 0 && <div className="card empty">{t('assets.noResults')}</div>}
      <div className="grid grid-3">
        {(assets.data ?? []).map((r) => (
          <article key={r.id} className="card resource-card">
            <div className="row center">
              <h3>{r.name}</h3>
              <span className="spacer" />
              {r.available !== undefined &&
                (r.available ? <span className="badge good">● {t('common.available')}</span> : <span className="badge critical">■ {t('common.unavailable')}</span>)}
            </div>
            {r.description && <p className="small muted">{r.description}</p>}
            <Features list={r.features} />
            <button className="btn primary" disabled={!valid || r.available === false} onClick={() => setSelected(r)}>
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
        allowRecurrence
        onClose={() => setSelected(null)}
        onDone={() => {
          setSelected(null);
          assets.reload();
        }}
      />
    </div>
  );
}
