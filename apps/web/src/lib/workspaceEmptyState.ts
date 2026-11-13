/**
 * When the stage invites a first step.
 *
 * A project that opens empty has an empty Objects list, an empty Parameters
 * panel and a blank viewport; the tool rail is there, but nothing on the
 * stage says where to begin. The invitation stands in the viewport for
 * exactly as long as that is true: Build mode, nothing modeled, no command
 * under way. Kept pure so the rule is tested without the workspace.
 */
export interface WorkspaceEmptyStateInput {
  /** Build is the only workspace that creates; the others read or adjust. */
  buildMode: boolean;
  /** Features in the history, built or not. */
  featureCount: number;
  /** Bodies on the stage, however they got there. */
  bodyCount: number;
  /**
   * A tool is armed or a command is under way: a tool from the rail, an
   * in-place command, a sketch, a measurement, a repair pick.
   */
  commandActive: boolean;
  /** Why the project cannot be edited here, when it cannot. */
  editDisabledReason: string | null;
}

export function showsWorkspaceEmptyState({
  buildMode,
  featureCount,
  bodyCount,
  commandActive,
  editDisabledReason
}: WorkspaceEmptyStateInput): boolean {
  return (
    buildMode &&
    featureCount === 0 &&
    bodyCount === 0 &&
    !commandActive &&
    // An invitation nobody can accept is noise: a read-only seat or a
    // project open in another tab already says why on its own surfaces.
    editDisabledReason === null
  );
}
