import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  addDatumPlane,
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type FacePlaneSource,
  type FaceTopology,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  faceOffsetBaseline,
  planFaceOffset
} from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { primitiveCylinderRadiusAncestor } from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';
import { faceSketchAttachment } from '../apps/web/src/lib/faceSketchAttachment';

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
  }, 60_000);

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

describe('teeth over part of a cylinder (v55)', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  it('keeps a cap drag off the cylinder’s height: the teeth end at shoulders', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shaft', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 12 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const wall = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    // Teeth over the bottom 4 of the 12: the bottom cap is the gear's.
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      teeth: 20,
      faceWidth: 4,
      targetBodyId: blankId,
      faceHash: wall.hash,
      ...(wall.reference ? { faceReference: wall.reference } : {})
    });
    const document = cut.document;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    document.derived = derived;
    const body = derived.bodyRepresentations[cut.bodyId]!;
    const ring = body.topology!.faces.find(
      (face) => face.reference?.lineageName === 'gear.face.cap.start'
    )!;
    expect(ring).toBeDefined();
    // Growing the cylinder from this end would slide the stored span along
    // it, so the drag is not read as the cylinder's height.
    const plan = planFaceOffset({
      document,
      bodyId: cut.bodyId,
      face: ring,
      faceHash: ring.hash,
      offset: 2
    });
    expect(plan?.kind).not.toBe('primitive-dimension');
  });
});

describe('end caps across whole-face and partial teeth (v55)', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  it('keeps each cap’s name and the datum planes on it through span edits either way', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Shaft', toUserId('user_gear')),
      {
        name: 'Blank',
        primitiveKind: 'cylinder',
        dimensions: { radius: 11, height: 12 }
      }
    );
    const blankId = base.bodyOrder[0]!;
    const blank = (await adapter.syncDocument(base)).bodyRepresentations[
      blankId
    ]!;
    const wall = blank.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    // Whole-face teeth, set module 0.9.
    const cut = gearBody(base, {
      name: 'Teeth',
      gearType: 'external',
      sizing: 'module',
      pitch: 0.9,
      fit: 'module',
      teeth: 20,
      targetBodyId: blankId,
      faceHash: wall.hash,
      ...(wall.reference ? { faceReference: wall.reference } : {})
    });
    let document = cut.document;
    document.derived = await adapter.syncDocument(document);
    const gear = document.derived.bodyRepresentations[cut.bodyId]!;
    // A datum plane on each cap, from the face as a pick gives it.
    const planes: Record<string, FeatureId> = {};
    for (const role of ['start', 'end'] as const) {
      const face = gear.topology!.faces.find(
        (candidate) =>
          candidate.reference?.lineageName === `gear.face.cap.${role}`
      )!;
      const attachment = faceSketchAttachment({
        bodyId: cut.bodyId,
        pickedHash: face.hash,
        face
      });
      if (!attachment.ok) throw new Error(attachment.reason);
      const planed = addDatumPlane(document, {
        name: `Cap ${role}`,
        definition: {
          kind: 'offset',
          source: attachment.planeRef as FacePlaneSource,
          offset: 0
        }
      });
      document = planed.document;
      planes[role] = planed.featureId;
    }
    const gearId = listFeaturesInOrder(document).find(
      (feature) => feature.data.featureKind === 'gear'
    )!.featureId;
    const whole = { clearData: ['faceWidth', 'offset', 'anchor'] };
    // Reaching the start, reaching the end, reaching neither; whole between.
    for (const step of [
      { data: { faceWidth: 6 } },
      whole,
      { data: { faceWidth: 6, anchor: 'end' as const } },
      whole,
      { data: { faceWidth: 6, offset: 3 } },
      whole
    ]) {
      document = updateFeature(document, { featureId: gearId, ...step });
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const names = derived.bodyRepresentations[
        cut.bodyId
      ]!.topology!.faces.map((face) => face.reference?.lineageName);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('gear.face.cap.start');
      expect(names).toContain('gear.face.cap.end');
      expect(derived.datumFrames?.[planes.start!]?.origin.z).toBeCloseTo(0, 6);
      expect(derived.datumFrames?.[planes.end!]?.origin.z).toBeCloseTo(12, 6);
    }
  });

  it('keeps a datum on the body’s part of a split cap as the caps rejoin and split again', async () => {
    for (const [end, z, reach] of [
      ['start', 0, { faceWidth: 6 }],
      ['end', 12, { faceWidth: 6, anchor: 'end' as const }]
    ] as const) {
      const base = addPrimitiveFeature(
        createProjectDocument('Shaft', toUserId('user_gear')),
        {
          name: 'Blank',
          primitiveKind: 'cylinder',
          dimensions: { radius: 11, height: 12 }
        }
      );
      const blankId = base.bodyOrder[0]!;
      const blank = (await adapter.syncDocument(base)).bodyRepresentations[
        blankId
      ]!;
      const wall = blank.topology!.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )!;
      // Teeth 6 long reaching this end: its cap is the ring and the body's
      // part, `cap.<end>.body`.
      const cut = gearBody(base, {
        name: 'Teeth',
        gearType: 'external',
        sizing: 'module',
        pitch: 0.9,
        fit: 'module',
        teeth: 20,
        ...reach,
        targetBodyId: blankId,
        faceHash: wall.hash,
        ...(wall.reference ? { faceReference: wall.reference } : {})
      });
      let document = cut.document;
      document.derived = await adapter.syncDocument(document);
      const part = document.derived.bodyRepresentations[
        cut.bodyId
      ]!.topology!.faces.find(
        (face) => face.reference?.lineageName === `gear.face.cap.${end}.body`
      )!;
      expect(part).toBeDefined();
      const attachment = faceSketchAttachment({
        bodyId: cut.bodyId,
        pickedHash: part.hash,
        face: part
      });
      if (!attachment.ok) throw new Error(attachment.reason);
      const planed = addDatumPlane(document, {
        name: 'Body cap',
        definition: {
          kind: 'offset',
          source: attachment.planeRef as FacePlaneSource,
          offset: 0
        }
      });
      document = planed.document;
      const gearId = listFeaturesInOrder(document).find(
        (feature) => feature.data.featureKind === 'gear'
      )!.featureId;
      const clear = ['faceWidth', 'offset', 'anchor'];
      const other: 'start' | 'end' = end === 'start' ? 'end' : 'start';
      // Whole face (one cap), back (split again), the other end (one cap
      // here), the middle (one cap), back again.
      for (const step of [
        { clearData: clear },
        { data: reach },
        { data: { faceWidth: 6, anchor: other }, clearData: ['offset'] },
        { data: { faceWidth: 6, offset: 3 }, clearData: ['anchor'] },
        { data: { ...reach, offset: 0 }, clearData: ['anchor'] }
      ]) {
        document = updateFeature(document, {
          featureId: gearId,
          ...(step.data ? { data: step.data } : {}),
          ...(step.clearData ? { clearData: step.clearData } : {})
        });
        const derived = await adapter.syncDocument(document);
        expect(derived.warnings, `${end} ${JSON.stringify(step)}`).toEqual([]);
        expect(derived.datumFrames?.[planed.featureId]?.origin.z).toBeCloseTo(
          z,
          6
        );
      }
    }
  });
});
