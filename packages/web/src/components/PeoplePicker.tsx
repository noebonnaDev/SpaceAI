import { useEffect, useState } from 'react';
import type { Api } from '../api';

export interface Person {
  displayName: string;
  email: string;
  department?: string | null;
}

/** Colleague search (Ritrovo users + Microsoft 365 directory via Graph User.ReadBasic.All). */
export function PeoplePicker({ api, value, onChange }: { api: Api; value: Person | null; onChange: (p: Person | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const h = setTimeout(() => {
      api
        .get<Person[]>(`/api/users/search?q=${encodeURIComponent(q.trim())}`)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(h);
  }, [q, api]);

  if (value) {
    return (
      <div className="row center">
        <span className="badge brand">
          {value.displayName} · {value.email}
        </span>
        <button type="button" className="btn ghost small" onClick={() => onChange(null)}>
          ✕
        </button>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mario Rossi" autoComplete="off" />
      {results.length > 0 && (
        <div className="card" style={{ padding: 6 }}>
          {results.map((p) => (
            <button
              key={p.email}
              type="button"
              className="btn ghost"
              style={{ width: '100%', justifyContent: 'flex-start' }}
              onClick={() => {
                onChange(p);
                setQ('');
                setResults([]);
              }}
            >
              {p.displayName} <span className="muted small">{p.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
