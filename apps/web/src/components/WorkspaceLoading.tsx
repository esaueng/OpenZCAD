import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react';
import { StartupScreen } from './StartupScreen';
import { AppShell } from './AppShell';

export function WorkspaceAppShell({
  projectId,
  projectName,
  loadingReady,
  onLoadingBack,
  covered = false,
  ...props
}: ComponentProps<typeof AppShell> & {
  projectId: string;
  projectName?: string;
  loadingReady: boolean;
  covered?: boolean;
  onLoadingBack(): void;
}) {
  return (
    <WorkspaceLoading
      key={projectId}
      projectName={projectName}
      ready={loadingReady}
      covered={covered}
      onBack={onLoadingBack}
    >
      <AppShell {...props} />
    </WorkspaceLoading>
  );
}

const PendingWorkspace = createContext<(() => () => void) | null>(null);
const WorkspaceModelReady = createContext(true);

/** The viewer releases its initial pending slot only after it draws the ready
 * model at the restored camera. Unmount/error recovery also releases the slot.
 */
export function useWorkspaceFrameReady() {
  const register = useContext(PendingWorkspace);
  const ready = useContext(WorkspaceModelReady);
  const release = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    release.current = register?.();
    return () => {
      release.current?.();
      release.current = undefined;
    };
  }, [register]);
  return useCallback(() => {
    if (!ready) return;
    release.current?.();
    release.current = undefined;
  }, [ready]);
}

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
  projectName,
  onBack,
  covered = false,
  children
}: {
  ready: boolean;
  projectName?: string;
  covered?: boolean;
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
      <WorkspaceModelReady.Provider value={ready}>
        <div
          className={`workspace-reveal${revealed ? ' is-ready' : ''}`}
          inert={!revealed || covered}
          aria-hidden={!revealed || covered}
        >
          {children}
        </div>
        {!revealed && !covered && (
          <StartupScreen
            projectName={projectName}
            stage={ready ? 'panels' : 'model'}
            onBack={onBack}
            loadingChunks={pending > 0}
          />
        )}
      </WorkspaceModelReady.Provider>
    </PendingWorkspace.Provider>
  );
}
