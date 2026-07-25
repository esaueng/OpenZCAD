import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
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
