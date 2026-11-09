import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  listFeaturesInOrder,
  mirrorBody,
  setParameter,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { onlyDimensionEdits, upstreamSnapshot } from './exact-carry-edit-gate';

/**
 * The carry's edit gate is an explicit allow-list: dimension edits pass,
 * everything else (a turn, a mirror, a feature added) refuses.
 */
const user = toUserId('user_carry_edit_gate');

function turnedPart(
  options: { width?: string | number; turn?: string | number } = {}
) {
  const start = setParameter(createProjectDocument('Gate', user), {
    name: 'w',
    expression: '30'
  });
  const box = addPrimitiveFeature(start, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: options.width ?? 30, height: 18, depth: 24 }
  });
  const turned = transformBody(box, {
    name: 'Turn',
    targetBodyId: box.bodyOrder[0]!,
    translation: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: options.turn ?? 0 }
  }).document;
  return chamferEdges(turned, {
    name: 'Break',
    targetBodyId: box.bodyOrder[0]!,
    edgeHashes: [1234567],
    size: 1
  }).document;
}

const named = (document: ProjectDocument, name: string) =>
  listFeaturesInOrder(document).find((feature) => feature.name === name)!;

function judged(before: ProjectDocument, after: ProjectDocument): boolean {
  const modifier = named(before, 'Break').featureId;
  return onlyDimensionEdits(
    upstreamSnapshot(before, modifier)!,
    upstreamSnapshot(after, modifier)!
  );
}

describe('carry edit gate', () => {
  it('passes an unchanged upstream and a primitive dimension edit', () => {
    const part = turnedPart();
    expect(judged(part, part)).toBe(true);
    const wider = updateFeature(part, {
      featureId: named(part, 'Box').featureId,
      data: { dimensions: { width: 22.5, height: 18, depth: 24 } }
    });
    expect(judged(part, wider)).toBe(true);
  });

  it('refuses a turn, a pivot and a translation of a transform', () => {
    const part = turnedPart();
    const turn = named(part, 'Turn');
    if (turn.data.featureKind !== 'transform') throw new Error('no turn');
    for (const transform of [
      { ...turn.data.transform, rotationDeg: { x: 0, y: 0, z: 180 } },
      { ...turn.data.transform, pivot: { x: 15, y: 9, z: 0 } },
      { ...turn.data.transform, translation: { x: 1, y: 0, z: 0 } }
    ]) {
      expect(
        judged(part, updateFeature(part, { featureId: turn.featureId, data: { transform } }))
      ).toBe(false);
    }
  });

  it('refuses a feature added upstream, such as a mirror', () => {
    const part = turnedPart();
    const box = named(part, 'Box');
    const mirrored = mirrorBody(part, {
      name: 'Mirror',
      targetBodyId: box.bodyId!,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    }).document;
    // Move the mirror before the modifier.
    const order = [...mirrored.featureOrder];
    const mirror = order.pop()!;
    order.splice(order.length - 1, 0, mirror);
    expect(judged(part, { ...mirrored, featureOrder: order })).toBe(false);
  });

  it('lets a parameter change only where every use is a dimension', () => {
    const sized = (document: ProjectDocument) =>
      setParameter(document, { name: 'w', expression: '22.5' });
    const asWidth = turnedPart({ width: 'w' });
    expect(judged(asWidth, sized(asWidth))).toBe(true);
    // The same parameter also turning the part: refused.
    const asTurn = turnedPart({ width: 'w', turn: 'w' });
    expect(judged(asTurn, sized(asTurn))).toBe(false);
  });
});
