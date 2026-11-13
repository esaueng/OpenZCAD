import { Suspense, type ComponentType } from 'react';
import { lazyWithStaleChunkNotice, loadWhenOnline } from '../../lib/staleChunk';
import { ErrorBoundary } from '../ErrorBoundary';
import { WorkspacePending } from '../WorkspaceLoading';
import type { AssemblyPlayerProps } from './AssemblyPlayer';

export interface AssemblyPlayerSlotProps extends AssemblyPlayerProps {
  /** The open project: a failure belongs to it, and the next one retries. */
  projectId: string;
}

/**
 * View mode's assembly playback bar, loaded on demand. A part has nothing
 * to play and the player draws nothing for it, so a failure draws nothing
 * too: a chunk that cannot load reports the workspace's stale-chunk notice
 * (`lazyWithStaleChunkNotice`), and a render failure is remounted once by
 * the boundary. Neither reaches the page's boundary, and opening another
 * project tries again.
 */
export function createAssemblyPlayer(
  load: () => Promise<{ default: ComponentType<AssemblyPlayerProps> }>
): ComponentType<AssemblyPlayerSlotProps> {
  const Lazy = lazyWithStaleChunkNotice(() => loadWhenOnline(load));
  return function AssemblyPlayerSlot({
    projectId,
    ...props
  }: AssemblyPlayerSlotProps) {
    return (
      <ErrorBoundary
        label="Assembly player"
        fallback={null}
        resetKey={projectId}
      >
        <Suspense fallback={<WorkspacePending />}>
          <Lazy {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
