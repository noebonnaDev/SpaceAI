import './globals';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../web/src/App';
import { devTokenStore, setAfterDevSignOut } from '../../web/src/auth';
import { setLanguage } from '../../web/src/i18n';
import { KioskPage, setKioskTokenOverride } from '../../web/src/pages/KioskPage';
import { TotemPage } from '../../web/src/pages/TotemPage';
import '../../web/src/styles.css';
import './demo.css';
import type { DemoBackend } from './backend';

setLanguage('it');

type View = 'app' | 'panel' | 'totem';

const STEPS: Record<string, string> = {
  start: 'Caricamento del motore del database',
  database: 'Creazione del database PostgreSQL nel browser',
  data: 'Dati di esempio: utenti, sale, postazioni e calendari Exchange simulati',
  jobs: 'Avvio del rilascio automatico e della sincronizzazione',
};

function Boot() {
  const [step, setStep] = useState('start');
  const [backend, setBackend] = useState<DemoBackend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fail = (err: unknown) => {
      if (cancelled) return;
      console.error(err);
      const message = err instanceof Error ? err.message : String(err);
      setError(/WebAssembly|wasm/i.test(message) ? 'questa pagina non può eseguire WebAssembly, che serve al database della demo.' : message);
    };
    // Some failures inside the database engine surface only as unhandled rejections, or not at all: catch both.
    const onRejection = (e: PromiseRejectionEvent) => fail(e.reason);
    window.addEventListener('unhandledrejection', onRejection);
    const timeout = setTimeout(() => fail(new Error('il database non si è avviato entro 60 secondi.')), 60_000);
    (async () => {
      // Fails fast where the page's security policy forbids WebAssembly (the smallest valid module: magic number + version).
      await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
      const [{ startBackend }, { interceptFetch }] = await Promise.all([import('./backend'), import('./fetch-intercept')]);
      const b = await startBackend({ progress: (s) => !cancelled && setStep(s) });
      interceptFetch(b);
      clearTimeout(timeout);
      window.removeEventListener('unhandledrejection', onRejection);
      if (!cancelled) setBackend(b);
    })().catch(fail);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  if (backend) return <DemoRoot backend={backend} />;
  return (
    <div className="demo-boot">
      <div className="demo-boot-card">
        <h1>Ritrovo · demo</h1>
        {error ? (
          <>
            <p className="demo-boot-error">La demo non è partita: {error}</p>
            <p className="muted small">
              La demo esegue un database PostgreSQL nel browser (WebAssembly). Se il browser o la rete aziendale lo bloccano, prova con
              un altro browser aggiornato (Chrome, Edge, Firefox o Safari).
            </p>
          </>
        ) : (
          <>
            <ol className="demo-steps">
              {Object.entries(STEPS).map(([key, label]) => {
                const keys = Object.keys(STEPS);
                const state = keys.indexOf(key) < keys.indexOf(step) ? 'done' : key === step ? 'now' : 'todo';
                return (
                  <li key={key} className={state}>
                    {label}
                  </li>
                );
              })}
            </ol>
            <p className="muted small">Tutto gira nel tuo browser: nessun dato esce da questa pagina.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** The real Ritrovo app plus a small control bar to switch between the employee app, a room panel and the lobby screen. */
function DemoRoot({ backend }: { backend: DemoBackend }) {
  const [view, setView] = useState<View>('app');
  const [appKey, setAppKey] = useState(0);
  const [deviceKey, setDeviceKey] = useState(0);
  // On phones the bar starts folded so it does not cover the app.
  const [open, setOpen] = useState(() => window.innerWidth >= 720);
  const [hint, setHint] = useState<string | null>(null);
  const navigatorRef = useRef<((to: string) => void) | null>(null);
  const admin = useRef<{ token: string; resources: Array<{ id: string; name: string; qrUrl: string }>; buildingId: string } | null>(null);
  const devices = useRef<Record<string, string>>({});

  useEffect(() => {
    // Signing out returns to the user list without reloading the page (which would restart the demo from scratch).
    setAfterDevSignOut(() => setAppKey((k) => k + 1));
  }, []);

  // Admin calls the bar needs (QR tokens, pairing of the simulated devices), straight to the in-page backend.
  const call = async <T,>(method: string, url: string, token?: string, body?: unknown): Promise<T> => {
    const res = await backend.handle(method, url, { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body ? JSON.stringify(body) : null);
    if (res.status >= 400) throw new Error(typeof res.body === 'string' ? res.body : `HTTP ${res.status}`);
    return JSON.parse(String(res.body)) as T;
  };
  const adminData = async () => {
    if (admin.current) return admin.current;
    const { token } = await call<{ token: string }>('POST', '/api/auth/dev-login', undefined, { email: 'giulia.rinaldi@ufficio.example' });
    const resources = await call<Array<{ id: string; name: string; qrUrl: string }>>('GET', '/api/admin/resources', token);
    const buildings = await call<Array<{ id: string }>>('GET', '/api/buildings', token);
    admin.current = { token, resources, buildingId: buildings[0]!.id };
    return admin.current;
  };
  const showDevice = async (kind: 'panel' | 'totem') => {
    const a = await adminData();
    if (!devices.current[kind]) {
      const sala = a.resources.find((r) => r.name === 'Sala Volta')!;
      const created = await call<{ pairingUrl: string }>(
        'POST',
        '/api/admin/kiosks',
        a.token,
        kind === 'panel' ? { name: 'Tablet Sala Volta (demo)', kind: 'panel', resourceId: sala.id } : { name: 'Schermo ingresso (demo)', kind: 'totem', buildingId: a.buildingId },
      );
      devices.current[kind] = created.pairingUrl.split('#t=')[1]!;
    }
    setKioskTokenOverride(devices.current[kind]!);
    setDeviceKey((k) => k + 1);
    setView(kind);
  };
  const scanQr = async (name: string) => {
    const a = await adminData();
    const token = a.resources.find((r) => r.name === name)!.qrUrl.split('/q/')[1]!;
    setView('app');
    // The QR page needs a signed-in user; give the app a moment to mount when coming back from a device view.
    setTimeout(() => {
      if (navigatorRef.current) {
        navigatorRef.current(`/q/${token}`);
        setHint(null);
      } else setHint('Accedi prima con un utente, poi riprova la scansione.');
    }, 50);
  };

  return (
    <>
      {view === 'app' && <App key={appKey} memoryRouter navigatorRef={navigatorRef} />}
      {view === 'panel' && <KioskPage key={`panel-${deviceKey}`} />}
      {view === 'totem' && <TotemPage key={`totem-${deviceKey}`} />}
      <aside className={`demo-bar${open ? '' : ' closed'}`} aria-label="Comandi della demo">
        <button type="button" className="demo-bar-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          Demo {open ? '▾' : '▴'}
        </button>
        {open && (
          <div className="demo-bar-body">
            <p className="demo-bar-note">
              Exchange e i calendari sono simulati; i dati di esempio vivono solo in questa scheda. Ricaricando la pagina si riparte da zero.
            </p>
            <div className="demo-bar-group" role="group" aria-label="Vista">
              <span className="demo-bar-label">Vista</span>
              <button type="button" className={`btn small${view === 'app' ? ' primary' : ''}`} onClick={() => setView('app')}>
                App
              </button>
              <button type="button" className={`btn small${view === 'panel' ? ' primary' : ''}`} onClick={() => void showDevice('panel')}>
                Pannello Sala Volta
              </button>
              <button type="button" className={`btn small${view === 'totem' ? ' primary' : ''}`} onClick={() => void showDevice('totem')}>
                Schermo ingresso
              </button>
            </div>
            <div className="demo-bar-group" role="group" aria-label="Simula">
              <span className="demo-bar-label">Simula</span>
              <button type="button" className="btn small" onClick={() => void scanQr('Proiettore portatile')}>
                QR del proiettore
              </button>
              <button type="button" className="btn small" onClick={() => void scanQr('Sala Galilei')}>
                QR Sala Galilei
              </button>
              {view === 'app' && (
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    devTokenStore.clear();
                    setAppKey((k) => k + 1);
                  }}
                >
                  Cambia utente
                </button>
              )}
            </div>
            {hint && <p className="demo-bar-hint">{hint}</p>}
          </div>
        )}
      </aside>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
