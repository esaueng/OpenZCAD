import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { createSketchFeatureIds } from '@openzcad/document-core';
import {
  createId,
  toEntityId,
  type EntityId,
  type SketchId,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';
import { compositeCommands, type CompositeShape } from './composites';
import {
  inferSketchRelations,
  type SketchInferenceObject,
  type SketchInferredRelationKind,
  type SketchSnapHint
} from './inference';

export type DrawnEntityTarget =
  | { kind: 'sketch'; sketchId: SketchId }
  | { kind: 'new-sketch'; name: string; planeRef: SketchPlaneRef };

/** What a drawing gesture completed: one entity, or a held-line composite. */
export type DrawnEntity =
  | { kind: 'object'; data: SketchObjectData }
  | { kind: 'composite'; shape: CompositeShape };

export interface DrawnEntityPlan {
  label: string;
  sketchId: SketchId;
  /** The new objects, in the order they were added. */
  objectIds: EntityId[];
  /** The object and every relation that is always kept. */
  commands: AnyCommand[];
  /**
   * Inferred relations kept only where a solve says they add rank
   * (`settleOptionalRelations`).
   */
  optional: AnyCommand[];
  /** What each relation command infers, for the status line. */
  kinds: Map<AnyCommand, SketchInferredRelationKind>;
}

export interface DrawnEntityOptions {
  autoConstrain: boolean;
  hints?: readonly SketchSnapHint[];
  resolve: (value: unknown) => number;
  construction?: boolean;
}

/**
 * S08: the commands a drawing commit runs: the drawn entity (or a
 * rectangle/polygon composite) and the relations its placement satisfies,
 * as one undo step. `existing` is the sketch the pointer snapped against.
 */
export function drawnEntityCommands(
  drawn: DrawnEntity,
  target: DrawnEntityTarget,
  existing: readonly SketchInferenceObject[],
  options: DrawnEntityOptions
): DrawnEntityPlan {
  let label: string;
  let sketchId: SketchId;
  let objectIds: EntityId[];
  let added: SketchInferenceObject[];
  const commands: AnyCommand[] = [];
  if (drawn.kind === 'composite') {
    const commit = compositeCommands(drawn.shape, target, {
      construction: options.construction
    });
    label = commit.label;
    sketchId = commit.sketchId;
    objectIds = [...commit.edgeIds];
    const payload = commit.commands[0]!.payload as {
      objects: SketchObjectData[];
    };
    added = commit.edgeIds.map((id, index) => ({
      id,
      data: payload.objects[index]!
    }));
    commands.push(...commit.commands);
  } else {
    const data: SketchObjectData = options.construction
      ? { ...drawn.data, construction: true }
      : drawn.data;
    const objectId = toEntityId(createId('ent'));
    label = `Add ${data.objectKind}`;
    objectIds = [objectId];
    added = [{ id: objectId, data }];
    if (target.kind === 'new-sketch') {
      const add = commandFactories.addSketch({
        name: target.name,
        planeRef: target.planeRef,
        objects: [data],
        ids: {
          ...createSketchFeatureIds(0),
          objectNodeId: objectId,
          objectNodeIds: [objectId]
        }
      });
      sketchId = add.payload.ids!.sketchId;
      commands.push(add);
    } else {
      sketchId = target.sketchId;
      commands.push(
        commandFactories.addSketchObjects(
          { sketchId, objects: [data], ids: { objectNodeIds: [objectId] } },
          label
        )
      );
    }
  }
  // Text has no constraint-schema point, nor does a parametric shape; they
  // take no relations.
  const relations = inferSketchRelations(
    existing,
    added,
    options.resolve,
    { autoConstrain: options.autoConstrain, hints: options.hints },
    drawn.kind === 'object'
  );
  const optional: AnyCommand[] = [];
  const kinds = new Map<AnyCommand, SketchInferredRelationKind>();
  for (const relation of relations) {
    const command = commandFactories.addSketchConstraint(
      { sketchId, constraint: relation.data },
      label
    );
    kinds.set(command, relation.kind);
    (relation.optional ? optional : commands).push(command);
  }
  return { label, sketchId, objectIds, commands, optional, kinds };
}

/** The constraint ids a settled command list adds, for showing their glyphs. */
export function addedConstraintIds(commands: readonly AnyCommand[]): string[] {
  return commands.flatMap((command) => {
    if (command.kind !== 'sketch.constraint.add') return [];
    const ids = (command.payload as { ids?: { constraintId: string } }).ids;
    return ids ? [String(ids.constraintId)] : [];
  });
}
