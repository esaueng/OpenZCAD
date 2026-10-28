import { BrandMark } from './BrandMark';
import { useSyncExternalStore } from 'react';

function subscribeOnline(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

export function StartupScreen({
  onBack,
  loadingChunks = false,
  projectName,
  backLabel = 'Back to parts'
}: {
  onBack?(): void;
  loadingChunks?: boolean;
  projectName?: string;
  backLabel?: string;
}) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  return (
    <div className="startup-screen">
      <div className="startup-card">
        <BrandMark />
        <strong>OpenZCAD</strong>
        <div
          role="status"
          aria-live="polite"
          aria-label={projectName ? 'Opening project' : 'Restoring workspace'}
        >
          <span className="startup-progress spin" aria-hidden="true" />
          <span>
            {projectName ? `Opening ${projectName}…` : 'Restoring workspace…'}
          </span>
        </div>
        <p>
          {!online && loadingChunks
            ? 'You’re offline. Connect to finish loading the workspace.'
            : projectName
              ? 'Checking saved copies and preparing your workspace'
              : 'Preparing your model and workspace'}
        </p>
        <button type="button" onClick={onBack} disabled={!onBack}>
          {backLabel}
        </button>
      </div>
    </div>
  );
}
