import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import type { SketchSolveOutcome } from '@openzcad/kernel-adapter/exact';
import type {
  EntityId,
  ProjectDocument,
  SketchId,
  SketchObjectData
} from '@openzcad/shared';
import { affectedFeatureTargets } from '../affectedFeatureTargets';
import {
  FeatureBuildError,
  validatedFeatureRejection
} from '../featureValidation';
import { solvedSketchCommands, solveStatusLabel } from './applySolve';

function apply(document: ProjectDocument, commands: AnyCommand[]) {
  return commands.reduce((current, command) => {
    command.validate(current);
    return command.apply(current);
  }, document);
}

/** Check the same exact downstream branch that a sketch edit will rebuild. */
export async function checkSketchEdit(
  base: ProjectDocument,
  sketchId: SketchId,
  commands: AnyCommand[],
  derive: (document: ProjectDocument) => Promise<ProjectDocument['derived']>
) {
  const document = apply(base, commands);
  const source = listFeaturesInOrder(document).find(
    (feature) =>
      feature.data.featureKind === 'sketch' &&
      feature.data.sketchId === sketchId
  );
  const targets = source
    ? affectedFeatureTargets(document, source.featureId)
    : [];
  if (!targets.length) return undefined;
  const derived = await derive(document);
  for (const target of targets) {
    const refusal = validatedFeatureRejection({
      ...target,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings,
      bodyPresent: Boolean(derived.bodyRepresentations[target.resultBodyId]),
      documentMoved: false
    });
    if (refusal)
      throw new FeatureBuildError(
        `${target.featureName}: ${refusal.message} The sketch edit was not saved.`,
        target.featureId,
        target.featureName
      );
  }
  return derived;
}

/** The live interaction state re-read after an async validate. Only the sketch branch carries a session. */
export type SketchEditSession = {
  mode: string;
  session?: {
    sketchId: string | null;
    selectedObjectId: string | null;
  };
};

/**
 * The race guard in `commitSketchEdit` (App.tsx): after validation awaits a
 * worker round-trip, the edit applies only when the live document and sketch
 * session still match the validated base. Returns the user-facing message
 * when the edit must be refused, or null when it may proceed. Nothing is
 * committed either way — the message is the whole point, so a typed edit can
 * never vanish silently.
 *
 * The parameter shape is structural on purpose: the live interaction state is
 * a wide union, and only the sketch branch carries a session.
 */
export function sketchEditRaceRefusal(
  base: { projectId: string; version: number },
  sketchId: SketchId,
  live: { projectId: string; version: number } | null | undefined,
  current: SketchEditSession,
  objectId?: string
): string | null {
  if (
    !live ||
    live.projectId !== base.projectId ||
    live.version !== base.version ||
    current.mode !== 'sketch' ||
    current.session?.sketchId !== sketchId ||
    (objectId !== undefined && current.session?.selectedObjectId !== objectId)
  ) {
    return 'The sketch changed while applying the edit; no change was saved. Retry.';
  }
  return null;
}

/** Solve an entity edit without silently replacing the values the user entered. */
export async function sketchEntityEditCommands(
  base: ProjectDocument,
  sketchId: SketchId,
  objectId: EntityId,
  data: SketchObjectData,
  solve: (
    document: ProjectDocument,
    sketchId: SketchId
  ) => Promise<SketchSolveOutcome>
): Promise<AnyCommand[]> {
  const before = base.nodes[objectId];
  if (before?.kind !== 'sketch-object')
    throw new Error('The selected geometry is no longer available.');
  const commands = [
    commandFactories.updateSketchObject(
      { sketchId, objectId, data },
      `Edit ${data.objectKind}`
    )
  ];
  const prospective = apply(base, commands);
  if (!findSketch(prospective, sketchId)?.constraints?.length) return commands;
  const outcome = await solve(prospective, sketchId);
  if (!outcome.converged || outcome.rolledBack) {
    throw new Error(
      `${solveStatusLabel(outcome)}. Edit or remove the listed constraints before changing this geometry.`
    );
  }
  const solved = solvedSketchCommands(prospective, sketchId, outcome);
  const result = apply(prospective, solved).nodes[objectId];
  const scope = getParameterScope(prospective).scope;
  if (result?.kind === 'sketch-object') {
    for (const [key, requested] of Object.entries(data)) {
      const previous = (before.data as unknown as Record<string, unknown>)[key];
      const actual = (result.data as unknown as Record<string, unknown>)[key];
      if (
        requested === previous ||
        requested === actual ||
        !(typeof requested === 'number' || typeof requested === 'string') ||
        !(typeof actual === 'number' || typeof actual === 'string')
      )
        continue;
      // Match the solve-to-command boundary's tolerance. Expressions which
      // resolve to the requested result remain valid driving inputs.
      if (
        Math.abs(
          resolveParamValue(requested, scope) - resolveParamValue(actual, scope)
        ) > 1e-9
      ) {
        throw new Error(
          'A constraint controls a value you changed. Edit its dimension below or remove that constraint; no change was saved.'
        );
      }
    }
  }
  return [...commands, ...solved];
}
