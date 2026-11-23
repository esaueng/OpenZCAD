import type { ProjectDocument } from '@openzcad/shared';

/**
 * Whether the command manager's document moved off `base` while a patch
 * built against it was checked on the exact kernel. `exact` requires the
 * very object the check started from: a copy adopted from the account or a
 * resolved sync conflict can keep the project and version and still carry
 * other content, and commands checked against `base` would overwrite it.
 * Without `exact` (the assistant's patches), only another project or
 * version counts as moved.
 */
export function patchBaseMoved(
  base: ProjectDocument,
  live: ProjectDocument | null | undefined,
  exact: boolean
): boolean {
  if (!live) return true;
  if (exact) return live !== base;
  return live.projectId !== base.projectId || live.version !== base.version;
}

export interface CheckedPatchRun<Checked> {
  /** The command manager's document when the Apply started. */
  base: ProjectDocument;
  /** The command manager's document now. */
  live(): ProjectDocument | null | undefined;
  /** Require the same document object at commit (see patchBaseMoved). */
  exact: boolean;
  /** Why the patch was refused when the document moved. */
  moved: string;
  check(base: ProjectDocument): Promise<Checked>;
  commit(checked: Checked): boolean;
}

/**
 * Checks a patch against `base` and commits it only while the command
 * manager still holds `base`: the guard and the commit run with no await
 * between them, so nothing can replace the document in between. Throws
 * `moved` when it did.
 */
export async function commitCheckedPatch<Checked>(
  run: CheckedPatchRun<Checked>
): Promise<boolean> {
  const checked = await run.check(run.base);
  if (patchBaseMoved(run.base, run.live(), run.exact)) {
    throw new Error(run.moved);
  }
  return run.commit(checked);
}

/**
 * What an Apply that has finished may still report. The workspace status
 * and busy flag belong to the open project: an Apply that ends after another
 * project opened leaves that project's status alone. It clears busy only
 * when it is the latest Apply (a newer one owns the flag) and its own
 * project is still open or no project is opening (an opening clears its own
 * busy flag when it ends; cleared early, the new project's spinner stops
 * while it is still loading). Clearing it otherwise keeps a switch made by
 * a path that never touches busy from leaving the editor locked.
 */
export function patchApplyReport(input: {
  projectId: string;
  openProjectId: string | null | undefined;
  latest: boolean;
  opening: boolean;
}): { status: boolean; clearBusy: boolean } {
  const open = input.openProjectId === input.projectId;
  return {
    status: open,
    clearBusy: input.latest && (open || !input.opening)
  };
}
