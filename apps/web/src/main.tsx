import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
// Self-hosted rather than fetched from Google Fonts: as a stylesheet in
// <head> that request was render-blocking on every cold visit. Bundled here,
// the @font-face rules ride along in the CSS we already load. Latin subsets
// only, at the two weights the design tokens actually use.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { mark } from './lib/perf';
import './theme/tokens.css';
import './styles/app.css';

mark('bundle.evaluated');

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary label="OpenZCAD workspace">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
