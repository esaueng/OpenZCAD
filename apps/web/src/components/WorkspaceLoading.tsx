import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react';
import { StartupScreen } from './StartupScreen';
import { AppShell } from './AppShell';

export function WorkspaceAppShell({
  projectId,
  loadingReady,
  onLoadingBack,
  ...props
}: ComponentProps<typeof AppShell> & {
  projectId: string;
  loadingReady: boolean;
  onLoadingBack(): void;
}) {
  return (
    <WorkspaceLoading
      key={projectId}
      ready={loadingReady}
      onBack={onLoadingBack}
    >
      <AppShell {...props} />
    </WorkspaceLoading>
  );
}

const PendingWorkspace = createContext<(() => () => void) | null>(null);

/** Suspense fallbacks join the initial reveal without coupling their loaders. */
export function useWorkspacePending() {
  const register = useContext(PendingWorkspace);
  useLayoutEffect(() => register?.(), [register]);
}

export function WorkspacePending() {
  useWorkspacePending();
  return null;
}

/** Mount at the final size, prepare offscreen, and reveal once per project. */
export function WorkspaceLoading({
  ready,
  onBack,
  children
}: {
  ready: boolean;
  onBack(): void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const register = useCallback(() => {
    setPending((count) => count + 1);
    return () => setPending((count) => count - 1);
  }, []);

  useEffect(() => {
    if (revealed || !ready || pending > 0) return;
    // Let the viewport draw at its real dimensions before the handoff. A
    // nested lazy panel can register in either frame and cancel this reveal.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setRevealed(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, ready, revealed]);

  return (
    <PendingWorkspace.Provider value={register}>
      <div
        className={`workspace-reveal${revealed ? ' is-ready' : ''}`}
        inert={!revealed}
        aria-hidden={!revealed}
      >
        {children}
      </div>
      {!revealed && (
        <StartupScreen onBack={onBack} loadingChunks={pending > 0} />
      )}
    </PendingWorkspace.Provider>
  );
}
