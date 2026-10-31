import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { primitiveCylinderRadiusAncestor } from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';

/** Every planar face whose normal points along `sense` × Z. */
function caps(body: BodyRepresentation, sense: number): FaceTopology[] {
  return body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      sense * face.geometry.normal!.z > 0.99
  );
}

describe('teeth cut along a cylinder', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;
  let document: ProjectDocument;
  let gearBodyId: BodyId;
  let gear: BodyRepresentation;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const base = addPrimitiveFeature(
      createProjectDocument('Gear blank', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 6 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const wall = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      targetBodyId: blankId,
      faceHash: wall.hash,
      ...(wall.reference ? { faceReference: wall.reference } : {})
    });
    document = cut.document;
    gearBodyId = cut.bodyId;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    document.derived = derived;
    gear = derived.bodyRepresentations[gearBodyId]!;
  });

  afterAll(() => adapter.dispose());

  it('leaves each end cap as one face carrying the gear’s cap role', () => {
    for (const [sense, role] of [
      [1, 'gear.face.cap.end'],
      [-1, 'gear.face.cap.start']
    ] as const) {
      // The cut used to leave the blank's disc and the toothed ring as two
      // coplanar faces, so a pick only ever found half the cap.
      const [cap, ...rest] = caps(gear, sense);
      expect(rest).toEqual([]);
      expect(cap!.reference?.lineageName).toBe(role);
      // A prism's cap is its whole cross-section.
      expect(cap!.geometry!.area).toBeCloseTo(gear.volume / 6, 4);
    }
  });

  it('drags the top cap as the cylinder’s height, re-cutting the teeth', async () => {
    const [top] = caps(gear, 1);
    expect(faceOffsetBaseline(document, gearBodyId, top!, top!.hash)).toEqual({
      total: 6,
      sense: 1
    });
    const plan = planFaceOffset({
      document,
      bodyId: gearBodyId,
      face: top!,
      faceHash: top!.hash,
      offset: 4
    });
    expect(plan?.kind).toBe('primitive-dimension');
    expect(plan?.kind === 'primitive-dimension' && plan.value).toBe(10);
    const manager = new CommandManager(document);
    manager.execute(plan!.command);
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[gearBodyId]!;
    expect(body.bbox.min.z).toBeCloseTo(0, 6);
    expect(body.bbox.max.z).toBeCloseTo(10, 6);
    expect(body.volume).toBeCloseTo((gear.volume / 6) * 10, 3);
    const flanks = body.topology!.faces.filter((face) =>
      face.reference?.lineageName.includes('.flank.')
    );
    expect(flanks).toHaveLength(40);
  });

  it('drags the bottom cap down while the top stays put', async () => {
    const [bottom] = caps(gear, -1);
    const plan = planFaceOffset({
      document,
      bodyId: gearBodyId,
      face: bottom!,
      faceHash: bottom!.hash,
      offset: 2
    });
    expect(plan?.kind).toBe('primitive-dimension');
    const manager = new CommandManager(document);
    manager.execute(plan!.command);
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[gearBodyId]!;
    expect(body.bbox.min.z).toBeCloseTo(-2, 6);
    expect(body.bbox.max.z).toBeCloseTo(6, 6);
  });

  it('leaves the radius to the gear', () => {
    expect(primitiveCylinderRadiusAncestor(document, gearBodyId)).toBeNull();
  });
});
