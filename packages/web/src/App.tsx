import type { PublicConfig, UserDto } from '@ritrovo/shared';
import { useEffect, useState, type MutableRefObject } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router';
import { ApiError } from './api';
import { devSignIn, initAuth, loadPublicConfig, signInWithMicrosoft, signOut } from './auth';
import { Logo } from './components/Logo';
import { ErrorBox, Spinner, ToastProvider } from './components/ui';
import { t } from './i18n';
import { AdminPage } from './pages/admin/AdminPage';
import { AssetsPage } from './pages/AssetsPage';
import { BookingDetailPage } from './pages/BookingDetailPage';
import { DesksPage } from './pages/DesksPage';
import { HomePage } from './pages/HomePage';
import { KioskPage } from './pages/KioskPage';
import { MyBookingsPage } from './pages/MyBookingsPage';
import { ProposalsPage } from './pages/ProposalsPage';
import { QrPage } from './pages/QrPage';
import { ReceptionPage } from './pages/ReceptionPage';
import { RequestsPage } from './pages/RequestsPage';
import { RoomsPage } from './pages/RoomsPage';
import { TotemPage } from './pages/TotemPage';
import { api, SessionProvider, useSession } from './session';

type Boot =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'login'; config: PublicConfig }
  | { phase: 'ready'; config: PublicConfig; user: UserDto };

/** Options used only by the in-browser demo, which runs inside a page it cannot navigate. */
export interface EmbeddedOptions {
  /** Keep routes in memory instead of the address bar. */
  memoryRouter?: boolean;
  /** Receives a function that navigates to an in-app path. */
  navigatorRef?: MutableRefObject<((to: string) => void) | null>;
}

export function App(props: EmbeddedOptions = {}) {
  const path = window.location.pathname;
  // Room panels and totems use a device token, not a user session.
  if (!props.memoryRouter && path.startsWith('/pannello')) return <KioskPage />;
  if (!props.memoryRouter && path.startsWith('/totem')) return <TotemPage />;
  return (
    <ToastProvider>
      <UserApp {...props} />
    </ToastProvider>
  );
}

function NavigatorBridge({ target }: { target: MutableRefObject<((to: string) => void) | null> }) {
  const navigate = useNavigate();
  useEffect(() => {
    target.current = (to) => void navigate(to);
    return () => {
      target.current = null;
    };
  }, [navigate, target]);
  return null;
}

function UserApp({ memoryRouter, navigatorRef }: EmbeddedOptions) {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });

  const start = async () => {
    try {
      const config = await loadPublicConfig();
      const signedIn = await initAuth();
      if (!signedIn) return setBoot({ phase: 'login', config });
      try {
        const user = await api.get<UserDto>('/api/me');
        setBoot({ phase: 'ready', config, user });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return setBoot({ phase: 'login', config });
        throw err;
      }
    } catch (error) {
      setBoot({ phase: 'error', error });
    }
  };

  useEffect(() => {
    void start();
  }, []);

  if (boot.phase === 'loading') {
    return (
      <div className="login">
        <Spinner />
      </div>
    );
  }
  if (boot.phase === 'error') {
    return (
      <div className="login">
        <div className="card login-card">
          <ErrorBox error={boot.error} onRetry={() => void start()} />
        </div>
      </div>
    );
  }
  if (boot.phase === 'login') return <LoginPage config={boot.config} onSignedIn={() => void start()} />;
  return (
    <SessionProvider
      value={{
        user: boot.user,
        config: boot.config,
        refreshUser: (user) => setBoot({ ...boot, user }),
      }}
    >
      {memoryRouter ? (
        <MemoryRouter>
          <Shell />
          {navigatorRef && <NavigatorBridge target={navigatorRef} />}
        </MemoryRouter>
      ) : (
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      )}
    </SessionProvider>
  );
}

function LoginPage({ config, onSignedIn }: { config: PublicConfig; onSignedIn: () => void }) {
  const [users, setUsers] = useState<UserDto[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (config.authMode === 'dev') {
      fetch('/api/auth/dev-users')
        .then((r) => r.json())
        .then(setUsers)
        .catch(setError);
    }
  }, [config.authMode]);

  return (
    <div className="login">
      <div className="card login-card stack">
        <div className="logo">
          <Logo /> {t('app.name')}
        </div>
        <p className="muted">{t('app.tagline')}</p>
        <h1>{t('login.title')}</h1>
        {config.authMode === 'entra' ? (
          <>
            <button
              className="btn primary large"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                signInWithMicrosoft().catch((e) => {
                  setError(e);
                  setBusy(false);
                });
              }}
            >
              {busy ? t('login.signingIn') : t('login.microsoft')}
            </button>
            <p className="small muted">{t('login.microsoftHint')}</p>
          </>
        ) : (
          <>
            <div className="alert warning">{t('app.demoBanner')}</div>
            <h2>{t('login.demoTitle')}</h2>
            <p className="small muted">{t('login.demoHint')}</p>
            <div className="stack" style={{ gap: 6 }}>
              {users.map((u) => (
                <button
                  key={u.id}
                  className="btn user-pick"
                  onClick={async () => {
                    try {
                      await devSignIn(u.email);
                      onSignedIn();
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  <span className="avatar" aria-hidden="true">
                    {initials(u.displayName)}
                  </span>
                  <span className="spacer">
                    {u.displayName}
                    <br />
                    <span className="small muted">{u.department}</span>
                  </span>
                  <span className="badge">{t(`roles.${u.role}`)}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <ErrorBox error={error} />
      </div>
    </div>
  );
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

function Shell() {
  const { user, config, can } = useSession();
  const links: Array<[string, string, boolean]> = [
    ['/', t('nav.home'), true],
    ['/sale', t('nav.rooms'), true],
    ['/postazioni', t('nav.desks'), true],
    ['/risorse', t('nav.assets'), true],
    ['/prenotazioni', t('nav.mine'), true],
    ['/proposte', t('nav.proposals'), true],
    ['/richieste', t('nav.requests'), true],
    ['/reception', t('nav.reception'), can('reception')],
    ['/admin', t('nav.admin'), can('amministratore')],
  ];
  return (
    <div className="shell">
      {config.graphMode === 'mock' && <div className="demo-banner">{t('app.demoBanner')}</div>}
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="logo">
            <Logo /> <span>{t('app.name')}</span>
          </NavLink>
          <nav className="nav" aria-label={t('nav.menu')}>
            {links
              .filter(([, , show]) => show)
              .map(([to, label]) => (
                <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                  {label}
                </NavLink>
              ))}
          </nav>
          <div className="user-menu">
            <span className="avatar" aria-hidden="true">
              {initials(user.displayName)}
            </span>
            <span className="user-name">
              {user.displayName}
              <br />
              <span className="small muted">{t(`roles.${user.role}`)}</span>
            </span>
            <button className="btn ghost small" onClick={() => void signOut()}>
              {t('nav.logout')}
            </button>
          </div>
        </div>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sale" element={<RoomsPage />} />
          <Route path="/postazioni" element={<DesksPage />} />
          <Route path="/risorse" element={<AssetsPage />} />
          <Route path="/prenotazioni" element={<MyBookingsPage />} />
          <Route path="/prenotazioni/:id" element={<BookingDetailPage />} />
          <Route path="/proposte" element={<ProposalsPage />} />
          <Route path="/richieste" element={<RequestsPage />} />
          <Route path="/q/:token" element={<QrPage />} />
          <Route path="/reception" element={can('reception') ? <ReceptionPage /> : <Navigate to="/" />} />
          <Route path="/admin/*" element={can('amministratore') ? <AdminPage /> : <Navigate to="/" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
