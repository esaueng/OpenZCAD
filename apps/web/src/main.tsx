import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import type * as LocalProjectStore from './lib/localProjectStore';
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

declare global {
  interface Window {
    /** Production storage functions exposed only in `VITE_E2E=1` builds. */
    __openzcadE2ESourceBlobStore?: Pick<
      typeof LocalProjectStore,
      | 'deleteSourceBlobIfUnreferenced'
      | 'ensureLocalProjectStorage'
      | 'hasSourceBlob'
      | 'putSourceBlobIfAbsent'
      | 'releaseSourceBlobClaim'
      | 'saveLocalProject'
    >;
  }
}

if (import.meta.env.VITE_E2E === '1') {
  void import('./lib/localProjectStore').then((store) => {
    window.__openzcadE2ESourceBlobStore = {
      deleteSourceBlobIfUnreferenced: store.deleteSourceBlobIfUnreferenced,
      ensureLocalProjectStorage: store.ensureLocalProjectStorage,
      hasSourceBlob: store.hasSourceBlob,
      putSourceBlobIfAbsent: store.putSourceBlobIfAbsent,
      releaseSourceBlobClaim: store.releaseSourceBlobClaim,
      saveLocalProject: store.saveLocalProject
    };
  });
}

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
