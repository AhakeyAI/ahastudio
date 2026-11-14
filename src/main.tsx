import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './aha-tokens.css';
import './aha-ui.css';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { App } from './App';
import { SettingsWindow } from './components/SettingsWindow';
import { ToastViewport } from './components/ToastViewport';

const params = new URLSearchParams(window.location.search);
const isSettingsView = params.get('view') === 'settings';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      {isSettingsView ? <SettingsWindow /> : <App />}
    </AppErrorBoundary>
    <ToastViewport />
  </StrictMode>,
);
