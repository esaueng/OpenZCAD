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
import { validatedFeatureRejection } from '../featureValidation';
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
      throw new Error(
        `${target.featureName}: ${refusal.message} The sketch edit was not saved.`
      );
  }
  return derived;
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
