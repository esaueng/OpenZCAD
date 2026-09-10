import {
  createBodyFeatureIds,
  listFeaturesInOrder
} from '@openzcad/document-core';
import type {
  BodyId,
  ParamValue,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';
import { commandFactories, composeCommands, type AnyCommand } from './index';

export interface ImportedOpeningRecipe {
  name: string;
  targetBodyId: BodyId;
  sourceWidth: number;
  editedWidth: number;
  width: ParamValue;
  axis: 'x' | 'y' | 'z';
  /** Negative-side region first, positive-side region second. */
  regions: [{ min: Vector3; max: Vector3 }, { min: Vector3; max: Vector3 }];
}

/** Compile an explicit localized opening construction into ordinary history. */
export function importedOpeningCommand(
  document: ProjectDocument,
  input: ImportedOpeningRecipe
): { command: AnyCommand; bodyId: BodyId } {
  if (
    !Number.isFinite(input.editedWidth) ||
    input.editedWidth <= input.sourceWidth
  )
    throw new Error('Edited opening width must exceed the source width.');
  if (!Number.isFinite(input.sourceWidth) || input.sourceWidth <= 0)
    throw new Error('Source opening width must be positive.');
  if (!['x', 'y', 'z'].includes(input.axis) || input.regions.length !== 2)
    throw new Error('An opening recipe needs an axis and two ordered regions.');
  for (const region of input.regions) {
    for (const axis of ['x', 'y', 'z'] as const) {
      if (
        !Number.isFinite(region.min[axis]) ||
        !Number.isFinite(region.max[axis]) ||
        region.min[axis] >= region.max[axis]
      )
        throw new Error('Opening region bounds must be finite and increasing.');
    }
  }
  if (input.regions[0].max[input.axis] > input.regions[1].min[input.axis])
    throw new Error('Opening regions must not overlap along the opening axis.');
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (f) =>
      f.bodyId === input.targetBodyId && f.data.featureKind === 'imported-step'
  );
  const source = features[index];
  if (!source || source.data.featureKind !== 'imported-step')
    throw new Error('Opening recipes require an imported STEP source.');
  if (
    features
      .slice(index + 1)
      .some(
        (f) =>
          ('targetBodyId' in f.data &&
            f.data.targetBodyId === input.targetBodyId) ||
          ('targetBodyIds' in f.data &&
            f.data.targetBodyIds.includes(input.targetBodyId))
      )
  )
    throw new Error('Opening recipes require an unmodified imported source.');
  const commands: AnyCommand[] = [];
  let current = input.targetBodyId;
  for (const [index, region] of input.regions.entries()) {
    const side = index === 0 ? 'Negative' : 'Positive';
    const copy = createBodyFeatureIds();
    commands.push(
      commandFactories.importStep({
        name: `${input.name}: ${side} source`,
        ...source.data,
        ids: copy
      })
    );
    const translation = {
      x: 0 as ParamValue,
      y: 0 as ParamValue,
      z: 0 as ParamValue
    };
    translation[input.axis] =
      `${index === 0 ? -1 : 1} * (require_one_of((${input.width}), ${input.sourceWidth}, ${input.editedWidth}) - ${input.sourceWidth}) / 2`;
    commands.push(
      commandFactories.transformBody({
        name: `${input.name}: ${side} displacement`,
        targetBodyId: copy.bodyId,
        translation
      })
    );
    const mask = createBodyFeatureIds();
    commands.push(
      commandFactories.addPrimitive({
        name: `${input.name}: ${side} region`,
        primitiveKind: 'box',
        dimensions: {
          width: region.max.x - region.min.x,
          height: region.max.y - region.min.y,
          depth: region.max.z - region.min.z
        },
        ids: mask
      })
    );
    commands.push(
      commandFactories.transformBody({
        name: `${input.name}: ${side} region placement`,
        targetBodyId: mask.bodyId,
        translation: region.min
      })
    );
    const activeWhen = `require_one_of((${input.width}), ${input.sourceWidth}, ${input.editedWidth}) - ${input.sourceWidth}`;
    const outside = createBodyFeatureIds();
    const inside = createBodyFeatureIds();
    const retained = createBodyFeatureIds();
    const result = createBodyFeatureIds();
    commands.push(
      commandFactories.booleanBodies({
        name: `${input.name}: ${side} outside`,
        activeWhen,
        operation: 'subtract',
        targetBodyIds: [current, mask.bodyId],
        ids: outside
      })
    );
    commands.push(
      commandFactories.booleanBodies({
        name: `${input.name}: ${side} inside`,
        activeWhen,
        operation: 'intersect',
        targetBodyIds: [current, mask.bodyId],
        ids: inside
      })
    );
    commands.push(
      commandFactories.booleanBodies({
        name: `${input.name}: ${side} retained`,
        activeWhen,
        operation: 'intersect',
        targetBodyIds: [inside.bodyId, copy.bodyId],
        ids: retained
      })
    );
    commands.push(
      commandFactories.booleanBodies({
        name: `${input.name}: ${side} reassembly`,
        activeWhen,
        operation: 'union',
        targetBodyIds: [outside.bodyId, retained.bodyId],
        ids: result
      })
    );
    current = result.bodyId;
  }
  return { command: composeCommands(input.name, commands), bodyId: current };
}
