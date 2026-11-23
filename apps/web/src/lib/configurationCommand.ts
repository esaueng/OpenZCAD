/**
 * F06: runs one configuration command from the Configurations panel. A row
 * switch, or a cell of the active row, writes parameter values into the
 * model, so every sketch those values drive is solved again and stored in
 * the same history entry, as a parameter set does. Without it the labels
 * read the row's values while the geometry keeps the last row's.
 *
 * Solving takes time, so a user can pick another row before the first has
 * settled. The last pick wins: each row switch takes a ticket, and one
 * overtaken by a later switch drops quietly instead of committing (or being
 * refused because the first one landed under it).
 */
import {
  isTweakCommand,
  type AnyCommand,
  type CommandManager
} from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import {
  resolveSketchesForValueChange,
  type SolveSketch
} from './sketch/parameterResolve';

export interface ConfigurationCommandDeps {
  /** The live command manager, read again after every await. */
  manager: () => CommandManager | null;
  solve: SolveSketch;
  execute: (command: AnyCommand) => boolean;
  executeTransaction: (
    label: string,
    commands: AnyCommand[],
    permission: 'edit' | 'parameters'
  ) => boolean;
  /**
   * The ticket of the latest row switch, shared by every call for one
   * workspace; a switch whose ticket is no longer the latest drops.
   */
  latestActivation: { current: number };
}

const UNCHANGED = 'The configurations were not changed.';

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : UNCHANGED;
}

/**
 * Checks `command` against the live document first, so a refusal is
 * answered (and nothing is committed) rather than thrown. Resolves to null
 * once it is committed, or once a later row switch has overtaken it, and to
 * the reason otherwise.
 */
export async function runConfigurationCommand(
  command: AnyCommand,
  deps: ConfigurationCommandDeps
): Promise<string | null> {
  const manager = deps.manager();
  if (!manager) return 'Editing is unavailable.';
  const base = manager.document;
  let next: ProjectDocument;
  try {
    command.validate(base);
    next = command.apply(base);
  } catch (error) {
    return message(error);
  }
  const ticket =
    command.kind === 'configuration.activate'
      ? ++deps.latestActivation.current
      : null;
  // A pick of the row already active: its ticket has overtaken any switch
  // still solving, and there is nothing else to do.
  if (ticket !== null && next === base) return null;
  /** Still the manager and project this command was checked against. */
  const sameProject = () => {
    const live = deps.manager();
    return live === manager && live.document.projectId === base.projectId;
  };
  // Overtaken only by a later switch in this same project: one made after
  // the workspace moved to another project says nothing about this one.
  const overtaken = () =>
    ticket !== null &&
    deps.latestActivation.current !== ticket &&
    sameProject();
  const isCurrent = () =>
    !overtaken() && deps.manager() === manager && manager.document === base;
  let resolved: Awaited<ReturnType<typeof resolveSketchesForValueChange>>;
  try {
    resolved = await resolveSketchesForValueChange(
      base,
      next,
      deps.solve,
      isCurrent
    );
  } catch (error) {
    if (overtaken()) return null;
    return message(error);
  }
  if (!resolved || !isCurrent()) {
    // A later row switch decides which row is shown; this one has nothing
    // left to say.
    if (overtaken()) return null;
    // A second click on the row the first one is switching to: by now that
    // row is active and there is nothing left to do. Only for the same
    // manager and project: another project's document answers nothing.
    if (sameProject()) {
      try {
        if (command.apply(manager.document) === manager.document) return null;
      } catch {
        // Refused against the live document: the move is the answer.
      }
    }
    return 'The project changed while the sketches were solved. Try again.';
  }
  if (!resolved.ok) return `${UNCHANGED} ${resolved.reason}`;
  if (resolved.commands.length === 0)
    return deps.execute(command) ? null : UNCHANGED;
  return deps.executeTransaction(
    command.label,
    [command, ...resolved.commands],
    isTweakCommand(command) ? 'parameters' : 'edit'
  )
    ? null
    : UNCHANGED;
}
