import type { BookingDto } from '@ritrovo/shared';
import { Link, useParams } from 'react-router';
import { BookingList } from '../components/BookingList';
import { ErrorBox, Spinner, useAsync } from '../components/ui';
import { fmtDayLong } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

/** Linked from the body of the Outlook event ("Dettagli e check-in"). */
export function BookingDetailPage() {
  const { id } = useParams();
  const { api } = useSession();
  const { data, error, loading, reload } = useAsync(() => api.get<BookingDto>(`/api/bookings/${id}`), [id]);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <h1>{data ? (data.title ?? data.resourceName) : t('common.details')}</h1>
        <Link className="btn ghost" to="/prenotazioni">
          {t('nav.mine')}
        </Link>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Spinner />}
      {data && (
        <section className="card">
          <h2>{fmtDayLong(data.start)}</h2>
          <BookingList api={api} bookings={[data]} onChanged={reload} />
        </section>
      )}
    </div>
  );
}
