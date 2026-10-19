import {
  createSketchCompositeId,
  isSketchComposite,
  sketchCompositeMemberIds,
  type EntityId,
  type ProjectDocument,
  type SketchComposite,
  type SketchCompositeData,
  type SketchCompositeId,
  type SketchId,
  type SketchNode
} from '@openzcad/shared';
import { cloneDocument, findSketch } from './index';

/**
 * S04 composite identity: the record that names a drawn rectangle's or
 * polygon's lines as one object. The shape's intent is carried by ordinary
 * relations added in the same transaction; this module only owns the
 * grouping, so it never moves geometry and never enters the solver.
 */

export type SketchCompositeAddInput = {
  sketchId: SketchId;
  composite: SketchCompositeData & {
    edgeIds: EntityId[];
    helperIds?: EntityId[];
  };
  ids?: { compositeId: SketchCompositeId };
};

/**
 * Malformed records refuse the load; a record whose members were edited or
 * removed outside the dissolve path stays loadable and resolves as broken.
 */
export function assertSketchComposites(sketch: SketchNode) {
  if (sketch.composites === undefined) return;
  if (!Array.isArray(sketch.composites))
    throw new Error('Sketch composites must be a list.');
  const ids = new Set<string>();
  const members = new Set<string>();
  for (const composite of sketch.composites) {
    if (!isSketchComposite(composite) || ids.has(composite.compositeId)) {
      throw new Error(
        'Sketch composites need a unique identity, a known kind and ordered sides.'
      );
    }
    ids.add(composite.compositeId);
    for (const member of sketchCompositeMemberIds(composite)) {
      if (members.has(member)) {
        throw new Error(
          `Sketch object ${member} belongs to more than one composite.`
        );
      }
      members.add(member);
    }
  }
}

export function addSketchComposite(
  document: ProjectDocument,
  input: SketchCompositeAddInput
): { document: ProjectDocument; compositeId: SketchCompositeId } {
  const sketch = findSketch(document, input.sketchId);
  if (!sketch) throw new Error(`Sketch ${input.sketchId} not found.`);
  const compositeId = input.ids?.compositeId ?? createSketchCompositeId();
  const composite: SketchComposite = { ...input.composite, compositeId };
  if (composite.helperIds?.length === 0) delete composite.helperIds;
  assertSketchComposites({
    ...sketch,
    composites: [...(sketch.composites ?? []), composite]
  });
  for (const [index, member] of sketchCompositeMemberIds(composite).entries()) {
    const node = sketch.objectIds.includes(member)
      ? document.nodes[member]
      : undefined;
    if (!node || node.kind !== 'sketch-object') {
      throw new Error(`Sketch ${input.sketchId} has no object ${member}.`);
    }
    const side = index < composite.edgeIds.length;
    if (side && node.objectKind !== 'line') {
      throw new Error(
        `A composite's sides must be lines, not a ${node.objectKind}.`
      );
    }
    if (!side && !node.data.construction) {
      throw new Error('A composite helper must be construction geometry.');
    }
  }
  const next = cloneDocument(document);
  findSketch(next, input.sketchId)!.composites = [
    ...(sketch.composites ?? []),
    composite
  ];
  next.version += 1;
  return { document: next, compositeId };
}

/**
 * The composites left once `objectId` is gone: any record that named it is
 * dissolved, since a shape missing a side or its helper is no longer the
 * object the record describes. Returns undefined for "no composites" so a
 * sketch that never had any keeps serializing without the field.
 */
export function compositesWithout(
  sketch: SketchNode,
  objectId: EntityId
): SketchComposite[] | undefined {
  if (!sketch.composites) return undefined;
  const kept = sketch.composites.filter(
    (composite) => !sketchCompositeMemberIds(composite).includes(objectId)
  );
  return kept.length > 0 ? kept : undefined;
}
