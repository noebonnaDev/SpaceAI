import { useRef } from 'react';
import { fmtDate } from '../format';

/**
 * Date field that always shows the Italian format (dd/mm/yyyy) regardless of the browser language,
 * while keeping the native calendar picker (opened with showPicker()).
 */
export function DateInput({
  value,
  onChange,
  min,
  required,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  required?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const open = () => {
    const el = ref.current as (HTMLInputElement & { showPicker?: () => void }) | null;
    if (!el) return;
    try {
      el.showPicker?.();
    } catch {
      el.focus();
    }
  };
  return (
    <span className="date-input">
      <button type="button" className="date-display" onClick={open} aria-label={label ? `${label}: ${value ? fmtDate(value) : ''}` : undefined}>
        <span>{value ? fmtDate(`${value}T12:00:00`) : 'gg/mm/aaaa'}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <input
        ref={ref}
        type="date"
        className="date-native"
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        min={min}
        required={required}
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
    </span>
  );
}

function slots(stepMinutes: number, from = 6 * 60, to = 22 * 60): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m += stepMinutes) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
}

/** 24-hour time selector (HH:mm) independent of the browser's 12/24-hour preference. */
export function TimeInput({
  value,
  onChange,
  step = 15,
  required,
}: {
  value: string;
  onChange: (v: string) => void;
  step?: number;
  required?: boolean;
}) {
  const options = slots(step, 0, 23 * 60 + 45);
  const list = options.includes(value) ? options : [...options, value].sort();
  return (
    <select className="time-input" value={value} required={required} onChange={(e) => onChange(e.target.value)}>
      {list.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}
