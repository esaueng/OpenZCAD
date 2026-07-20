import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './theme/tokens.css';
import './styles/app.css';

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
