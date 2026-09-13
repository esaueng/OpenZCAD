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

/**
 * The data keys a feature actually stores. An optional field that was not
 * asked for has to be absent, not present-and-undefined: that absence is what
 * keeps a document written before the field existed replaying unchanged.
 */
function featureDataKeys(document: ProjectDocument, name: string): string[] {
  const node = Object.values(document.nodes).find(
    (candidate) => candidate.kind === 'feature' && candidate.name === name
  );
  if (node?.kind !== 'feature') {
    throw new Error(`Feature "${name}" not found.`);
  }
  return Object.keys(node.data);
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

  it('closes a loft to an apex point, and leaves an unapexed loft alone', async () => {
    // The same two sections as the loft above. Without apex points the feature
    // data carries none of the new keys and the volume is the flat-capped
    // 373.3333 that loft has always produced.
    let document = createProjectDocument('Apex loft', toUserId('user_apex'));
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
    const flat = loftSections(upper.document, {
      name: 'Flat loft',
      sections: [lower.section, upper.section],
      mode: 'ruled'
    });
    expect(featureDataKeys(flat.document, 'Flat loft')).toEqual([
      'featureKind',
      'sections',
      'mode'
    ]);
    const flatDerived = await adapter.syncDocument(flat.document);
    expect(flatDerived.warnings).toEqual([]);
    expect(flatDerived.bodyRepresentations[flat.bodyId]?.volume).toBeCloseTo(
      373.3333333333333,
      6
    );

    // An apex 5 above the upper section closes that end to a point: exactly
    // one pyramid of base 8 x 8 and height 5 more material (64 * 5 / 3 =
    // 106.6667), and the body now reaches up to z = 15.
    const apexed = loftSections(upper.document, {
      name: 'Apex loft',
      sections: [lower.section, upper.section],
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 15 }
    });
    const apexDerived = await adapter.syncDocument(apexed.document);
    const apexBody = apexDerived.bodyRepresentations[apexed.bodyId];
    expect(apexDerived.warnings).toEqual([]);
    expect(apexBody?.source).toBe('loft');
    expect(apexBody?.bbox.max.z).toBeCloseTo(15, 6);
    expect(apexBody?.volume).toBeCloseTo(480, 3);
  });

  it('refuses a loft apex point that lies on its section plane', async () => {
    let document = createProjectDocument('Flat apex', toUserId('user_flat'));
    const lower = addSection(document, 'Lower', 0, {
      objectKind: 'circle',
      radius: 2,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const upper = addSection(document, 'Upper', 10, {
      objectKind: 'circle',
      radius: 3,
      centerX: 0,
      centerY: 0
    });
    // The kernel takes an apex on the section plane without complaint and
    // returns the un-apexed loft, so the degenerate case is refused by name.
    const refused = loftSections(upper.document, {
      name: 'Flat apex loft',
      sections: [lower.section, upper.section],
      mode: 'ruled',
      endPoint: { x: 1, y: 1, z: 10 }
    });
    const derived = await adapter.syncDocument(refused.document);
    expect(derived.warnings.join(' ')).toMatch(
      /lies on the plane of the section it closes/
    );
    expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
  });

  it('refuses a loft apex point in smooth mode by name', async () => {
    let document = createProjectDocument('Smooth apex', toUserId('user_smooth'));
    const lower = addSection(document, 'Lower', 0, {
      objectKind: 'circle',
      radius: 2,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const upper = addSection(document, 'Upper', 10, {
      objectKind: 'circle',
      radius: 3,
      centerX: 0,
      centerY: 0
    });
    const refused = loftSections(upper.document, {
      name: 'Smooth apex loft',
      sections: [lower.section, upper.section],
      mode: 'smooth',
      endPoint: { x: 0, y: 0, z: 15 }
    });
    const derived = await adapter.syncDocument(refused.document);
    expect(derived.warnings.join(' ')).toMatch(
      /A loft apex point is available in Ruled mode only/
    );
    expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
  });

  it('turns a swept profile onto a guide rail without changing its volume', async () => {
    let document = createProjectDocument('Guided', toUserId('user_guided'));
    const profile = addSection(document, 'Profile', 0, {
      objectKind: 'rectangle',
      width: 4,
      height: 2,
      centerX: 0,
      centerY: 0
    });
    document = profile.document;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    document = path.document;
    const rail = addSketchFeature(document, {
      name: 'Rail',
      plane: 'XZ',
      offset: 10,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    const pathReference = {
      sketchId: path.sketchId,
      entityIds: findSketch(rail.document, path.sketchId)!.objectIds
    };
    const railReference = {
      sketchId: rail.sketchId,
      entityIds: findSketch(rail.document, rail.sketchId)!.objectIds
    };

    const plain = sweepProfile(rail.document, {
      name: 'Plain sweep',
      profile: profile.section,
      path: pathReference,
      mode: 'standard'
    });
    expect(featureDataKeys(plain.document, 'Plain sweep')).toEqual([
      'featureKind',
      'profile',
      'path',
      'mode'
    ]);
    const plainDerived = await adapter.syncDocument(plain.document);
    const plainBody = plainDerived.bodyRepresentations[plain.bodyId];
    expect(plainDerived.warnings).toEqual([]);
    // The rotation-minimizing frame holds the profile's 4 mm width on x.
    expect(plainBody?.volume).toBeCloseTo(160, 6);
    expect(plainBody?.bbox.max.x).toBeCloseTo(2, 6);
    expect(plainBody?.bbox.max.y).toBeCloseTo(1, 6);

    const guided = sweepProfile(rail.document, {
      name: 'Guided sweep',
      profile: profile.section,
      path: pathReference,
      mode: 'standard',
      guide: railReference
    });
    const guidedDerived = await adapter.syncDocument(guided.document);
    const guidedBody = guidedDerived.bodyRepresentations[guided.bodyId];
    expect(guidedDerived.warnings).toEqual([]);
    expect(guidedBody?.source).toBe('sweep');
    // Tracking a rail offset along y turns the profile a quarter turn: the
    // same swept volume, with its width now on y.
    expect(guidedBody?.volume).toBeCloseTo(160, 6);
    expect(guidedBody?.bbox.max.x).toBeCloseTo(1, 6);
    expect(guidedBody?.bbox.max.y).toBeCloseTo(2, 6);
  });

  it('refuses a guide rail the kernel cannot take as one curve', async () => {
    let document = createProjectDocument('Wide rail', toUserId('user_rail'));
    const profile = addSection(document, 'Profile', 0, {
      objectKind: 'rectangle',
      width: 4,
      height: 2,
      centerX: 0,
      centerY: 0
    });
    document = profile.document;
    const path = addSketchFeature(document, {
      name: 'Path',
      plane: 'XZ',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    });
    document = path.document;
    // A half-turn arc: the path builder splits it into two quarter-turn
    // curves, and the kernel's guided sweep takes exactly one.
    const rail = addSketchFeature(document, {
      name: 'Rail',
      plane: 'XZ',
      offset: 10,
      object: {
        objectKind: 'arc',
        centerX: 0,
        centerY: 0,
        radius: 10,
        startAngleDeg: 0,
        endAngleDeg: 180
      }
    });
    const refused = sweepProfile(rail.document, {
      name: 'Refused sweep',
      profile: profile.section,
      path: {
        sketchId: path.sketchId,
        entityIds: findSketch(rail.document, path.sketchId)!.objectIds
      },
      mode: 'standard',
      guide: {
        sketchId: rail.sketchId,
        entityIds: findSketch(rail.document, rail.sketchId)!.objectIds
      }
    });
    const derived = await adapter.syncDocument(refused.document);
    expect(derived.warnings.join(' ')).toMatch(
      /A sweep guide rail must be a single curve, but this rail resolves to 2 curves/
    );
    expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
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
