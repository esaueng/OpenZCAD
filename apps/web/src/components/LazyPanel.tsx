import { Suspense, useSyncExternalStore, type ComponentType } from 'react';
import { RotateCw } from 'lucide-react';
import { lazyWithStaleChunkNotice, loadWhenOnline } from '../lib/staleChunk';
import { ErrorBoundary } from './ErrorBoundary';
import { Tooltip } from './Tooltip';
import { useWorkspacePending } from './WorkspaceLoading';

function subscribeOnline(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/**
 * `menu-section` is an optional part of a menu, such as the File menu's
 * mesh cleanup, which renders nothing while there is nothing to clean up.
 * While it loads it draws nothing either: a panel-sized loading card in
 * the menu (168px) pushed the File menu past a 900px window, so the menu
 * opened with a scrollbar and its last section out of view.
 */
type LoadingPresentation =
  'panel' | 'view-tools' | 'tweak-rail' | 'menu-section';
type RailPresentation = Exclude<LoadingPresentation, 'panel' | 'menu-section'>;

/**
 * The rail-shaped surfaces: their slot is a 40px rail (or the View bar), so
 * a panel-sized card there either covered the stage or was squeezed to a
 * word per line. Their loading and failed states keep the rail's shape.
 */
const RAILS: Record<
  RailPresentation,
  { rail: string; loading: string; button?: string }
> = {
  'view-tools': {
    rail: 'view-mode-bar',
    loading: 'view-tools-loading',
    button: 'view-mode-button'
  },
  'tweak-rail': { rail: 'tweak-rail', loading: 'tweak-rail-loading' }
};

function LoadingPanel({
  label,
  presentation
}: {
  label: string;
  presentation: Exclude<LoadingPresentation, 'menu-section'>;
}) {
  useWorkspacePending();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  const rail = presentation === 'panel' ? null : RAILS[presentation];
  return (
    <section
      className={rail ? `${rail.rail} ${rail.loading}` : 'error-boundary'}
      role="status"
    >
      {rail && (
        <span className="workspace-loading-ring spin" aria-hidden="true" />
      )}
      <strong className={rail ? 'visually-hidden' : undefined}>
        {online
          ? `Loading ${label.toLowerCase()}…`
          : `${label} is not loaded yet.`}
      </strong>
      {!online && (
        <span {...(rail ? { className: 'rail-note' } : {})}>
          Connect to the internet to load this panel.
        </span>
      )}
    </section>
  );
}

/**
 * A rail that failed keeps its slot and shape with only its Reload in it.
 * The reason is the button's tooltip and name, not a card over the stage:
 * the reload is optional, and the top bar's chip already offers it.
 */
function FailedRail({
  label,
  presentation
}: {
  label: string;
  presentation: RailPresentation;
}) {
  const rail = RAILS[presentation];
  return (
    <section className={rail.rail} role="status">
      <span className="visually-hidden">{label} did not load.</span>
      <Tooltip
        label="Reload workspace"
        description={`${label} did not load. Reload to restore it.`}
        multiline
      >
        <button
          type="button"
          {...(rail.button ? { className: rail.button } : {})}
          aria-label={`Reload workspace to restore ${label.toLowerCase()}`}
          onClick={() => window.location.reload()}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </Tooltip>
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
      <ErrorBoundary
        label={label}
        {...(presentation === 'panel' || presentation === 'menu-section'
          ? {}
          : {
              fallback: <FailedRail label={label} presentation={presentation} />
            })}
      >
        <Suspense
          fallback={
            presentation === 'menu-section' ? null : (
              <LoadingPanel label={label} presentation={presentation} />
            )
          }
        >
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
