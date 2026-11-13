import { useWorkspacePending } from '../WorkspaceLoading';

/**
 * Assemble's sidebar while its chunk loads: the same panel frame in the
 * same place, saying it is loading, so entering Assemble never shows an
 * empty stage. On a project's first reveal it also holds the workspace
 * cover, as every lazy workspace panel does.
 */
export function AssemblyPanelPending() {
  useWorkspacePending();
  return (
    <aside
      className="assembly-panel assembly-panel-pending"
      aria-label="Assembly"
      aria-busy="true"
    >
      <p className="assembly-muted" role="status">
        Loading parts and joints…
      </p>
    </aside>
  );
}
