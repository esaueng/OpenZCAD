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

type LoadingPresentation = 'panel' | 'view-tools';

function LoadingPanel({
  label,
  presentation
}: {
  label: string;
  presentation: LoadingPresentation;
}) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  return (
    <section
      className={
        presentation === 'view-tools'
          ? 'view-mode-bar view-tools-loading'
          : 'error-boundary'
      }
      role="status"
    >
      {presentation === 'view-tools' && (
        <span className="workspace-loading-ring spin" aria-hidden="true" />
      )}
      <strong
        className={
          presentation === 'view-tools' ? 'visually-hidden' : undefined
        }
      >
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
  load: () => Promise<{ default: ComponentType<Props> }>,
  presentation: LoadingPresentation = 'panel'
): ComponentType<Props> {
  // A stable fulfilled payload also renders when reopened offline. Failed
  // browser module downloads can stay cached until navigation, so do not
  // start a known-offline download or promise a React-only retry can fix it.
  const Lazy = lazyWithStaleChunkNotice(() => loadWhenOnline(load));
  return function LazyPanel(props: Props) {
    return (
      <ErrorBoundary label={label}>
        <Suspense
          fallback={<LoadingPanel label={label} presentation={presentation} />}
        >
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
