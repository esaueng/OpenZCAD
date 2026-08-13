import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  draftBody,
  findSketch,
  helicalSweepProfile,
  loftSections,
  resolveParamValue,
  sweepProfile,
  thickenFace
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';
import { createProjectDocument } from '@openzcad/document-core';
import { commandFactories, replayCommands } from '@openzcad/command-system';

function addSection(
  document: ProjectDocument,
  name: string,
  offset: number,
  object: SketchObjectData
): { document: ProjectDocument; section: SketchSectionReference } {
  const result = addSketchFeature(document, {
    name,
    plane: 'XY',
    offset,
    object
  });
  const sketch = findSketch(result.document, result.sketchId)!;
  const objects = sketch.objectIds.map((objectId) => {
    const node = result.document.nodes[objectId];
    if (node?.kind !== 'sketch-object') {
      throw new Error('Expected a sketch object.');
    }
    return { id: node.id, data: node.data };
  });
  const [profile] = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  if (!profile) throw new Error('Expected one closed profile.');
  return {
    document: result.document,
    section: {
      sketchId: result.sketchId,
      profile: {
        profileId: profile.profileId,
        regionFingerprint: profile.regionFingerprint,
        samplePoint: profile.samplePoint,
        sourceArea: profile.area,
        sourceEntityIds: profile.sourceEntityIds
      }
    }
  };
}

describe('advanced exact modeling features', { timeout: 30_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  it('lofts ordered closed sketch sections into a valid exact solid', async () => {
    let document = createProjectDocument('Loft', toUserId('user_loft'));
    const lower = addSection(document, 'Lower', 0, {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const upper = addSection(document, 'Upper', 10, {
      objectKind: 'rectangle',
      width: 8,
      height: 8,
      centerX: 0,
      centerY: 0
    });
    const lofted = loftSections(upper.document, {
      name: 'Loft 1',
      sections: [lower.section, upper.section],
      mode: 'ruled'
    });

    const derived = await adapter.syncDocument(lofted.document);
    const body = derived.bodyRepresentations[lofted.bodyId];
    expect(derived.warnings).toEqual([]);
    expect(body?.source).toBe('loft');
    expect(body?.volume).toBeCloseTo(373.3333333333333, 6);
    expect(body?.exportableStep).toBe(true);
  });

  it('serializes and replays an advanced feature with stable reserved ids', () => {
    let document = createProjectDocument('Replay', toUserId('user_replay'));
    const first = addSection(document, 'First', 0, {
      objectKind: 'circle',
      radius: 2,
      centerX: 0,
      centerY: 0
    });
    document = first.document;
    const second = addSection(document, 'Second', 8, {
      objectKind: 'circle',
      radius: 3,
      centerX: 0,
      centerY: 0
    });
    const command = commandFactories.loftSections({
      name: 'Replay loft',
      sections: [first.section, second.section],
      mode: 'smooth'
    });
    command.validate(second.document);
    const applied = command.apply(second.document);
    const replayed = replayCommands(second.document, [command.serialize()]);
    const bodyId = command.payload.ids!.bodyId;

    expect(replayed.bodyOrder).toContain(bodyId);
    expect(replayed.nodes).toEqual(applied.nodes);
    expect(replayed.featureOrder).toEqual(applied.featureOrder);
  });

  it('sweeps a closed profile along a persisted sketch path', async () => {
    let document = createProjectDocument('Sweep', toUserId('user_sweep'));
    const profile = addSection(document, 'Profile', 0, {
      objectKind: 'rectangle',
      width: 2,
      height: 2,
      centerX: 0,
      centerY: 0
    });
    document = profile.document;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'line',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 20
      }
    });
    const swept = sweepProfile(path.document, {
      name: 'Sweep 1',
      profile: profile.section,
      path: {
        sketchId: path.sketchId,
        entityIds: findSketch(path.document, path.sketchId)!.objectIds
      },
      mode: 'standard'
    });

    const derived = await adapter.syncDocument(swept.document);
    const body = derived.bodyRepresentations[swept.bodyId];
    expect(derived.warnings).toEqual([]);
    expect(body?.source).toBe('sweep');
    expect(body?.volume).toBeCloseTo(80, 6);
  });

  it('builds a parametric helical sweep from a closed profile', async () => {
    const profile = addSection(
      createProjectDocument('Helix', toUserId('user_helix')),
      'Profile',
      0,
      {
        objectKind: 'rectangle',
        width: 2,
        height: 2,
        centerX: 0,
        centerY: 0
      }
    );
    const helical = helicalSweepProfile(profile.document, {
      name: 'Helix 1',
      profile: profile.section,
      axisOrigin: { x: 0, y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 10,
      pitch: 5,
      turns: 3
    });

    const derived = await adapter.syncDocument(helical.document);
    const body = derived.bodyRepresentations[helical.bodyId];
    expect(derived.warnings).toEqual([]);
    expect(body?.source).toBe('helical-sweep');
    expect(body?.volume).toBeGreaterThan(700);
    expect(body?.volume).toBeLessThan(800);
  });

  it('drafts and thickens exact selected faces without mutating their sources', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Modify', toUserId('user_modify')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const sourceBodyId = base.bodyOrder[0]!;
    const source = (await adapter.syncDocument(base)).bodyRepresentations[
      sourceBodyId
    ]!;
    const side = source.topology!.faces.find(
      (face) => (face.geometry?.normal?.x ?? 0) > 0.9
    )!;
    const top = source.topology!.faces.find(
      (face) => (face.geometry?.normal?.z ?? 0) > 0.9
    )!;

    const drafted = draftBody(base, {
      name: 'Draft 1',
      targetBodyId: sourceBodyId,
      faceHashes: [side.hash],
      ...(side.reference ? { faceReferences: [side.reference] } : {}),
      pullDirection: { x: 0, y: 0, z: 1 },
      neutralPoint: { x: 0, y: 0, z: 0 },
      angleDeg: 3
    });
    const draftDerived = await adapter.syncDocument(drafted.document);
    expect(
      draftDerived.bodyRepresentations[drafted.bodyId]?.volume
    ).toBeCloseTo(1026.2038896415208, 6);
    expect(draftDerived.bodyRepresentations[sourceBodyId]?.consumed).toBe(true);

    const thickened = thickenFace(base, {
      name: 'Thicken 1',
      targetBodyId: sourceBodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      thickness: 2
    });
    const thickenDerived = await adapter.syncDocument(thickened.document);
    expect(
      thickenDerived.bodyRepresentations[thickened.bodyId]?.volume
    ).toBeCloseTo(200, 6);
    expect(thickenDerived.bodyRepresentations[sourceBodyId]?.consumed).toBe(
      false
    );
  });
});
