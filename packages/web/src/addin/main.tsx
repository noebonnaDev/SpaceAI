import { createRoot } from 'react-dom/client';
import { setLanguage } from '../i18n';
import '../styles.css';
import { TaskPaneRoot } from './TaskPane';

setLanguage('it');
const root = createRoot(document.getElementById('root')!);

// Office.js is loaded from Microsoft's CDN in taskpane.html. Outside Outlook (e.g. opened in a browser) it still renders.
if (typeof Office !== 'undefined' && Office.onReady) {
  void Office.onReady(() => root.render(<TaskPaneRoot office={Office} />));
} else {
  root.render(<TaskPaneRoot office={undefined} />);
}
