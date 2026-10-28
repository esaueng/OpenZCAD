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

export function StartupScreen({ onBack }: { onBack?(): void }) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  return (
    <div className="startup-screen">
      <div className="startup-card">
        <BrandMark />
        <strong>OpenZCAD</strong>
        <div role="status" aria-live="polite" aria-label="Restoring workspace">
          <span className="startup-progress spin" aria-hidden="true" />
          <span>Restoring workspace…</span>
        </div>
        <p>
          {online
            ? 'Preparing your model and workspace'
            : 'You’re offline. Connect to finish loading the workspace.'}
        </p>
        <button type="button" onClick={onBack} disabled={!onBack}>
          Back to parts
        </button>
      </div>
    </div>
  );
}
