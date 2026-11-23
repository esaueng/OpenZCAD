/**
 * Re-solves the sketches a change of parameter values drives. The document
 * stores each sketch's solved coordinates and the rebuild extrudes from
 * them, so a relation whose value now reads differently (a dimension, an
 * offset, a pattern's spacing or step) leaves stale geometry behind unless
 * the sketch is solved again and the result stored with the change.
 *
 * Every path that moves parameter values runs this: a parameter set, a
 * configuration row switch or active-row cell, an assistant patch, and the
 * read-only documents built for another row (a share link's row, a view or
 * component on a row, a row's export). The returned commands are
 * `sketch.object.update`s marked `derivedFrom: 'parameter-resolve'`, so a
 * recorded entry replays to the same geometry without a solver and Tweak's
 * undo can tell them from a user's own sketch edit.
 */
import type { AnyCommand } from '@openzcad/command-system';
import {
  getParameterScope,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
// Type-only on purpose: a value import would pull the WASM-bearing module
// into the main bundle and fail the build's bundle-size check.
import type { SketchSolveOutcome } from '@openzcad/kernel-adapter/exact';
import type {
  ParamValue,
  ProjectDocument,
  SketchId,
  SketchNode
} from '@openzcad/shared';
import { ownEntry } from '@openzcad/shared';
import { solveStatusLabel, solvedSketchCommands } from './applySolve';
import { sketchesDrivenByParameterEdit } from './constraints';

export type SolveSketch = (
  document: ProjectDocument,
  sketchId: SketchId
) => Promise<SketchSolveOutcome>;

export type ParameterResolveOutcome =
  | {
      ok: true;
      /** `after` with every driven sketch's solved geometry stored. */
      document: ProjectDocument;
      /** The commands that store it, to run in the same history entry. */
      commands: AnyCommand[];
    }
  | { ok: false; sketch: SketchNode; reason: string };

/** A parameter value reader for one document's own scope and units. */
export function parameterValueReader(
  document: ProjectDocument
): (value: ParamValue) => number | undefined {
  const { scope } = getParameterScope(document);
  return (value) => {
    try {
      return resolveParamValue(value, scope, 'sketch value', document.units);
    } catch {
      return undefined;
    }
  };
}

/**
 * The sketches of `after` that `before` already had and whose relations
 * read differently under `after`'s parameter values. A sketch the change
 * itself adds was authored under the new values and has nothing stale.
 */
export function sketchesDrivenByValueChange(
  before: ProjectDocument,
  after: ProjectDocument
): SketchNode[] {
  return sketchesDrivenByParameterEdit(
    listNodesByKind(after, 'sketch').filter(
      (sketch) => ownEntry(before.nodes, sketch.id)?.kind === 'sketch'
    ),
    parameterValueReader(before),
    parameterValueReader(after)
  );
}

/**
 * Solves each sketch the change from `before` to `after` drives, in turn,
 * and stores the solved geometry. Refuses (naming the sketch) when a solve
 * does not converge or rolls back, so a caller commits nothing rather than
 * geometry the new values contradict. `isCurrent` lets a caller give up
 * between solves once its document has moved on.
 */
export async function resolveSketchesForValueChange(
  before: ProjectDocument,
  after: ProjectDocument,
  solve: SolveSketch,
  isCurrent: () => boolean = () => true
): Promise<ParameterResolveOutcome | null> {
  let document = after;
  const commands: AnyCommand[] = [];
  for (const sketch of sketchesDrivenByValueChange(before, after)) {
    const outcome = await solve(document, sketch.sketchId);
    if (!isCurrent()) return null;
    if (!outcome.converged || outcome.rolledBack) {
      return {
        ok: false,
        sketch,
        reason: `${sketch.name} is ${solveStatusLabel(outcome)}.`
      };
    }
    for (const command of solvedSketchCommands(
      document,
      sketch.sketchId,
      outcome,
      undefined,
      'parameter-resolve'
    )) {
      command.validate(document);
      document = command.apply(document);
      commands.push(command);
    }
  }
  return { ok: true, document, commands };
}

/**
 * The same, for a document that is only shown or exported (another row's
 * build): its geometry is solved but nothing is recorded, and a sketch that
 * does not settle refuses the build with the reason.
 */
export async function resolvedForDisplay(
  before: ProjectDocument,
  after: ProjectDocument,
  solve: SolveSketch
): Promise<ProjectDocument> {
  if (after === before) return after;
  const outcome = await resolveSketchesForValueChange(before, after, solve);
  if (!outcome) return after;
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.document;
}
