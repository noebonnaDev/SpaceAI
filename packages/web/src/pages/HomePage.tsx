import type { BookingDto, UserDto } from '@ritrovo/shared';
import { Link } from 'react-router';
import { BookingList } from '../components/BookingList';
import { ErrorBox, Spinner, useAsync, useToast } from '../components/ui';
import { addDaysLocal, fmtDayLong, localToIso, todayLocal } from '../format';
import { t } from '../i18n';
import { useSession } from '../session';

export function HomePage() {
  const { api, user, refreshUser } = useSession();
  const toast = useToast();
  const today = todayLocal();
  const { data, error, loading, reload } = useAsync(
    () => api.get<BookingDto[]>(`/api/bookings/mine?from=${encodeURIComponent(localToIso(today, '00:00'))}&to=${encodeURIComponent(localToIso(addDaysLocal(today, 8), '00:00'))}`),
    [],
  );
  const active = (data ?? []).filter((b) => !['cancelled', 'declined'].includes(b.status));
  const todays = active.filter((b) => b.start < localToIso(addDaysLocal(today, 1), '00:00'));
  const later = active.filter((b) => b.start >= localToIso(addDaysLocal(today, 1), '00:00'));
  const first = user.displayName.split(' ')[0];

  const togglePrivacy = async (hide: boolean) => {
    try {
      refreshUser(await api.patch<UserDto>('/api/me', { hideFromColleagues: hide }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="page-head">
        <div>
          <h1>{t('home.greeting', { name: first ?? '' })}</h1>
          <p>{fmtDayLong(new Date())}</p>
        </div>
      </div>
      <div className="two-col">
        <section className="card">
          <div className="card-title">
            <h2>{t('home.today')}</h2>
          </div>
          {loading && !data ? <Spinner /> : null}
          <ErrorBox error={error} onRetry={reload} />
          {data && todays.length === 0 && <p className="muted">{t('home.nothingToday')}</p>}
          <BookingList api={api} bookings={todays} onChanged={reload} />
          {later.length > 0 && (
            <>
              <hr className="divider" />
              <h3>{t('home.upcoming')}</h3>
              <BookingList api={api} bookings={later} onChanged={reload} showDate compact />
            </>
          )}
        </section>
        <aside className="stack">
          <section className="card stack">
            <h2>{t('home.quick')}</h2>
            <Link className="btn primary" to="/sale">
              {t('nav.rooms')}
            </Link>
            <Link className="btn" to="/postazioni">
              {t('nav.desks')}
            </Link>
            <Link className="btn" to="/risorse">
              {t('nav.assets')}
            </Link>
            <Link className="btn" to="/richieste">
              {t('requests.new')}
            </Link>
          </section>
          <section className="card stack">
            <h2>{t('home.privacy')}</h2>
            <label className="check">
              <input type="checkbox" checked={user.hideFromColleagues} onChange={(e) => void togglePrivacy(e.target.checked)} />
              {t('home.hideMe')}
            </label>
          </section>
        </aside>
      </div>
    </div>
  );
}
