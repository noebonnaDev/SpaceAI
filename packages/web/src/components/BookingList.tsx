import type { BookingDto } from '@ritrovo/shared';
import { useState } from 'react';
import type { Api } from '../api';
import { fmtDate, fmtTime } from '../format';
import { t } from '../i18n';
import { StatusBadge, useToast } from './ui';

/** Agenda of bookings with check-in, check-out and cancel actions. */
export function BookingList({
  api,
  bookings,
  onChanged,
  showDate,
  compact,
}: {
  api: Api;
  bookings: BookingDto[];
  onChanged: () => void;
  showDate?: boolean;
  compact?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (b: BookingDto, action: 'check-in' | 'check-out' | 'cancel', ok: string) => {
    if (action === 'cancel' && !window.confirm(t('booking.confirmCancel'))) return;
    setBusy(b.id);
    try {
      await api.post(`/api/bookings/${b.id}/${action}`);
      toast(ok);
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancelSeries = async (b: BookingDto) => {
    if (!b.seriesId || !window.confirm(t('booking.confirmCancel'))) return;
    setBusy(b.id);
    try {
      await api.post(`/api/series/${b.seriesId}/cancel`);
      toast(t('booking.cancelled'));
      onChanged();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {bookings.map((b) => (
        <div key={b.id} className="booking-item">
          <div className="booking-time">
            {fmtTime(b.start)}–{fmtTime(b.effectiveEnd ?? b.end)}
            {showDate && <small>{fmtDate(b.start)}</small>}
          </div>
          <div className="booking-body">
            <h3>{b.title ?? b.resourceName}</h3>
            <div className="meta">
              <span>
                {t(`kinds.${b.resourceKind}`)}: <strong>{b.resourceName}</strong>
              </span>
              {!compact && b.bookedForName && b.organizerName && b.bookedForName !== b.organizerName && (
                <span>
                  {t('booking.for')}: {b.bookedForName} ({t('booking.organizer')}: {b.organizerName})
                </span>
              )}
              {!compact && <span>{t(`sources.${b.source}`)}</span>}
              <StatusBadge booking={b} />
              {b.onlineMeetingUrl && (
                <a href={b.onlineMeetingUrl} target="_blank" rel="noreferrer">
                  {t('booking.teamsJoin')}
                </a>
              )}
            </div>
          </div>
          <div className="booking-actions">
            {b.canCheckIn && (
              <button className="btn primary small" disabled={busy === b.id} onClick={() => void act(b, 'check-in', t('booking.checkedIn'))}>
                {t('booking.checkIn')}
              </button>
            )}
            {b.canCheckOut && (
              <button className="btn small" disabled={busy === b.id} onClick={() => void act(b, 'check-out', t('booking.checkedOut'))}>
                {t('booking.checkOut')}
              </button>
            )}
            {b.canCancel && (
              <button className="btn danger small" disabled={busy === b.id} onClick={() => void act(b, 'cancel', t('booking.cancelled'))}>
                {t('booking.cancel')}
              </button>
            )}
            {!compact && b.canCancel && b.seriesId && (
              <button className="btn ghost small" disabled={busy === b.id} onClick={() => void cancelSeries(b)}>
                {t('booking.cancelSeries')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
