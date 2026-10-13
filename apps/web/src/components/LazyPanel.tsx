import { Suspense, useSyncExternalStore, type ComponentType } from 'react';
import { lazyWithStaleChunkNotice, loadWhenOnline } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';

function subscribeOnline(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

function LoadingPanel({ label }: { label: string }) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  return (
    <section className="error-boundary" role="status">
      <strong>
        {online
          ? `Loading ${label.toLowerCase()}…`
          : `${label} is not loaded yet.`}
      </strong>
      {!online && <span>Connect to the internet to load this panel.</span>}
    </section>
  );
}

/** Download on demand, wait while offline, and contain a failed load locally. */
export function createLazyPanel<Props extends object>(
  label: string,
  load: () => Promise<{ default: ComponentType<Props> }>
): ComponentType<Props> {
  // A stable fulfilled payload also renders when reopened offline. Failed
  // browser module downloads can stay cached until navigation, so do not
  // start a known-offline download or promise a React-only retry can fix it.
  const Lazy = lazyWithStaleChunkNotice(() => loadWhenOnline(load));
  return function LazyPanel(props: Props) {
    return (
      <ErrorBoundary label={label}>
        <Suspense fallback={<LoadingPanel label={label} />}>
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
