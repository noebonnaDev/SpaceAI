import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setLanguage } from './i18n';
import './styles.css';

let lang = 'it';
try {
  lang = localStorage.getItem('ritrovo.lang') ?? 'it';
} catch {
  /* storage blocked: default language */
}
setLanguage(lang);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: offline shell for the installed app. API responses (personal data) are never cached.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
