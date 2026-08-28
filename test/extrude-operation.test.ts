import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId,
  getLatestSketchId,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  classifyExtrudeOperation,
  type ExtrudeInferenceBody
} from '@openzcad/kernel-adapter';
import { toBodyId, toUserId, type ProjectDocument } from '@openzcad/shared';
import { resolveExtrudeOperation } from '../apps/web/src/lib/extrudeInference';

function inferenceBody(
  id: string,
  volume: number,
  min = 0,
  max = 10
): ExtrudeInferenceBody {
  return {
    bodyId: toBodyId(id),
    name: id,
    volume,
    bbox: {
      min: { x: min, y: min, z: min },
      max: { x: max, y: max, z: max }
    }
  };
}

describe('extrude operation inference', () => {
  const extrusion = inferenceBody('extrusion', 100, 2, 8);
  const target = inferenceBody('target', 1_000);

  it('classifies enclosure as cut and partial overlap as add', () => {
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume }
      ])
    ).toMatchObject({
      operation: 'cut',
      targetBodyId: target.bodyId,
      reason: 'enclosed'
    });
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume + 50 }
      ])
    ).toMatchObject({
      operation: 'add',
      targetBodyId: target.bodyId,
      reason: 'partial-overlap'
    });
  });

  it('keeps tangency, coincidence, multiple targets, and refusals conservative', () => {
    expect(
      classifyExtrudeOperation(
        extrusion,
        [{ target, unionVolume: target.volume + extrusion.volume }],
        [],
        1
      )
    ).toMatchObject({ operation: 'new-body', reason: 'no-overlap' });

    const coincident = inferenceBody('coincident', extrusion.volume, 2, 8);
    expect(
      classifyExtrudeOperation(extrusion, [
        { target: coincident, unionVolume: extrusion.volume }
      ])
    ).toMatchObject({ operation: 'new-body', reason: 'coincident' });

    const second = inferenceBody('second', 500);
    expect(
      classifyExtrudeOperation(extrusion, [
        { target, unionVolume: target.volume },
        { target: second, unionVolume: second.volume }
      ])
    ).toMatchObject({ operation: 'new-body', reason: 'multiple-overlap' });

    expect(classifyExtrudeOperation(extrusion, [], [target], 1)).toMatchObject({
      operation: 'new-body',
      reason: 'exact-measurement-refused'
    });
  });
});

function baseSketchDocument(offset: number): {
  document: ProjectDocument;
  targetBodyId: ReturnType<typeof toBodyId>;
} {
  let document = createProjectDocument(
    'Stored extrusion operation',
    toUserId('user_extrude_operation')
  );
  document = addPrimitiveFeature(document, {
    name: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 10 }
  });
  const targetBodyId = getLatestBodyId(document)!;
  document = addSketchFeature(document, {
    name: 'Profile',
    plane: 'XY',
    offset,
    object: {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 10,
      centerY: 10
    }
  }).document;
  return { document, targetBodyId };
}

function extrudeDocument(
  operation: 'new-body' | 'add' | 'cut' | undefined,
  offset: number,
  distance: number
): { document: ProjectDocument; targetBodyId: ReturnType<typeof toBodyId> } {
  const created = baseSketchDocument(offset);
  const document = extrudeSketch(created.document, {
    name: 'Extrude',
    sketchId: getLatestSketchId(created.document)!,
    distance,
    ...(operation === undefined ? {} : { operation }),
    ...(operation === 'add' || operation === 'cut'
      ? { targetBodyId: created.targetBodyId }
      : {})
  }).document;
  return { document, targetBodyId: created.targetBodyId };
}

describe('stored extrude operations', { timeout: 30_000 }, () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  it('stores and replays an enclosed cut without exposing its consumed target', async () => {
    const { document, targetBodyId } = extrudeDocument('cut', 2, 4);
    const feature = listFeaturesInOrder(document).at(-1)!;
    expect(feature.data).toMatchObject({
      featureKind: 'extrude',
      operation: 'cut',
      targetBodyId
    });

    const derived = await kernel.syncDocument(document);
    const result = derived.bodyRepresentations[feature.bodyId!]!;
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[targetBodyId]?.consumed).toBe(true);
    expect(result.consumed).toBe(false);
    expect(result.volume).toBeCloseTo(3_936, 3);
  });

  it('requires a canonical target for command-created add and cut features', () => {
    const created = extrudeDocument(undefined, 2, 4);
    const sketchId = getLatestSketchId(created.document)!;
    const manager = new CommandManager(created.document);

    expect(() =>
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Invalid cut',
          sketchId,
          distance: 2,
          operation: 'cut'
        })
      )
    ).toThrow(/requires a stored target body/);
    expect(() =>
      manager.execute(
        commandFactories.extrudeSketch({
          name: 'Invalid new body',
          sketchId,
          distance: 2,
          operation: 'new-body',
          targetBodyId: created.targetBodyId
        })
      )
    ).toThrow(/cannot store a target body/);
  });

  it('resolves the live preview operation once from exact geometry', async () => {
    for (const expectation of [
      { offset: 2, distance: 4, operation: 'cut' },
      { offset: 8, distance: 4, operation: 'add' },
      { offset: 10, distance: 4, operation: 'new-body' },
      { offset: 10, distance: -4, operation: 'cut' }
    ] as const) {
      const base = baseSketchDocument(expectation.offset).document;
      const resolved = await resolveExtrudeOperation({
        base,
        input: {
          name: 'Preview',
          sketchId: getLatestSketchId(base)!,
          distance: expectation.distance
        },
        derive: (document) => kernel.syncDocument(document)
      });
      expect(resolved.inference.operation).toBe(expectation.operation);
      expect(resolved.command.payload.operation).toBe(expectation.operation);
    }
  });

  it('cuts when a face-attached drag runs into its body, even on partial overlap', async () => {
    // z 8..12 over a 10-tall box: volume alone reads "add" — the direction
    // hint is what encodes that a profile dragged into the body is a cut.
    const { document: base, targetBodyId } = baseSketchDocument(8);
    const resolved = await resolveExtrudeOperation({
      base,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(base)!,
        distance: 4
      },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: targetBodyId, direction: 'into' }
    });
    expect(resolved.inference).toMatchObject({
      operation: 'cut',
      reason: 'into-face-body',
      targetBodyId
    });
    expect(resolved.command.payload.operation).toBe('cut');
  });

  it('joins a boss grown off the face it was sketched on', async () => {
    // z 10..14 on a box that ends at z 10: the two meet exactly at the
    // sketched face and share no volume, so measurement alone says new-body.
    // Growing away from that face means join, and the exact rebuild has to
    // accept an add whose operands only touch.
    const { document: base, targetBodyId } = baseSketchDocument(10);
    const resolved = await resolveExtrudeOperation({
      base,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(base)!,
        distance: 4
      },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: targetBodyId, direction: 'away' }
    });
    expect(resolved.inference).toMatchObject({
      operation: 'add',
      reason: 'onto-face-body',
      targetBodyId
    });
    expect(resolved.command.payload.operation).toBe('add');
    // The union is one body, not a pair of lumps: the box plus the boss.
    const result = resolved.derived.bodyRepresentations[
      resolved.command.payload.ids!.bodyId
    ];
    expect(result?.consumed).toBe(false);
    expect(result?.volume).toBeCloseTo(20 * 20 * 10 + 4 * 4 * 4, 3);
    expect(resolved.derived.warnings).toEqual([]);
  });

  it('still refuses a stored add whose extrusion sits away from its target', async () => {
    // The hint must not paper over real separation: an offset plane well
    // clear of the box has nothing to join, and the rebuild says so.
    const { document: base, targetBodyId } = baseSketchDocument(40);
    await expect(
      resolveExtrudeOperation({
        base,
        input: {
          name: 'Preview',
          sketchId: getLatestSketchId(base)!,
          distance: 4
        },
        derive: (document) => kernel.syncDocument(document),
        faceAttachment: { bodyId: targetBodyId, direction: 'away' }
      })
    ).rejects.toThrow(/did not produce an exact result body/);
  });

  it('keeps the classifier result when the drag overlaps a different body', async () => {
    // The hint only overrides toward the face's own body — an overlap with
    // some other solid keeps the measured operation.
    const { document: base } = baseSketchDocument(8);
    const resolved = await resolveExtrudeOperation({
      base,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(base)!,
        distance: 4
      },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: toBodyId('body_unrelated'), direction: 'into' }
    });
    expect(resolved.inference.operation).toBe('add');
    expect(resolved.command.payload.operation).toBe('add');
  });

  it('resolves a negative free-plane preview as a new body', async () => {
    let base = createProjectDocument(
      'Negative free-plane preview',
      toUserId('user_negative_free_plane')
    );
    base = addSketchFeature(base, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 4,
        height: 4,
        centerX: 0,
        centerY: 0
      }
    }).document;

    const resolved = await resolveExtrudeOperation({
      base,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(base)!,
        distance: -4
      },
      derive: (document) => kernel.syncDocument(document)
    });

    expect(resolved.inference).toMatchObject({
      operation: 'new-body',
      reason: 'no-live-body'
    });
    expect(resolved.command.payload.distance).toBe(-4);
  });

  it('ignores an exact zero-overlap candidate whose bounds overlap', async () => {
    let document = createProjectDocument(
      'Extrude overlap decoy',
      toUserId('user_extrude_overlap_decoy')
    );
    document = addPrimitiveFeature(document, {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const targetBodyId = getLatestBodyId(document)!;
    document = addPrimitiveFeature(document, {
      name: 'Decoy',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 4 }
    });
    const decoyBodyId = getLatestBodyId(document)!;
    document = transformBody(document, {
      name: 'Place decoy',
      targetBodyId: decoyBodyId,
      translation: { x: 13.5, y: 13.5, z: 2 }
    }).document;
    document = addSketchFeature(document, {
      name: 'Round cut',
      plane: 'XY',
      offset: 2,
      object: {
        objectKind: 'circle',
        radius: 4,
        centerX: 10,
        centerY: 10
      }
    }).document;

    const resolved = await resolveExtrudeOperation({
      base: document,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(document)!,
        distance: 4
      },
      derive: (candidate) => kernel.syncDocument(candidate)
    });

    expect(resolved.inference).toMatchObject({
      operation: 'cut',
      targetBodyId,
      reason: 'enclosed'
    });
  });

  it('does not treat a pre-existing overlap warning as a new measurement', async () => {
    let document = createProjectDocument(
      'Spoofed overlap warning',
      toUserId('user_extrude_warning_spoof')
    );
    document = addPrimitiveFeature(document, {
      name: 'Base',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Decoy',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 4 }
    });
    document = transformBody(document, {
      name: 'Place decoy',
      targetBodyId: getLatestBodyId(document)!,
      translation: { x: 13.5, y: 13.5, z: 2 }
    }).document;
    document = addSketchFeature(document, {
      name: 'Round cut',
      plane: 'XY',
      offset: 2,
      object: {
        objectKind: 'circle',
        radius: 4,
        centerX: 10,
        centerY: 10
      }
    }).document;
    const spoof =
      'Feature "Preview": Stored add extrusion no longer overlaps Decoy Body; operation was not re-inferred.';

    const resolved = await resolveExtrudeOperation({
      base: document,
      input: {
        name: 'Preview',
        sketchId: getLatestSketchId(document)!,
        distance: 4
      },
      derive: async (candidate) => ({
        ...(await kernel.syncDocument(candidate)),
        warnings: [spoof]
      })
    });

    expect(resolved.inference).toMatchObject({
      operation: 'new-body',
      reason: 'exact-measurement-refused'
    });
  });

  it('stores a partial-overlap add and preserves the legacy new-body default', async () => {
    const added = extrudeDocument('add', 8, 4);
    const addFeature = listFeaturesInOrder(added.document).at(-1)!;
    const addDerived = await kernel.syncDocument(added.document);
    expect(addDerived.warnings).toEqual([]);
    expect(
      addDerived.bodyRepresentations[addFeature.bodyId!]!.volume
    ).toBeCloseTo(4_032, 3);
    expect(addDerived.bodyRepresentations[added.targetBodyId]?.consumed).toBe(
      true
    );

    const legacy = extrudeDocument(undefined, 2, 4);
    const legacyFeature = listFeaturesInOrder(legacy.document).at(-1)!;
    const legacyDerived = await kernel.syncDocument(legacy.document);
    expect(legacyFeature.data).not.toHaveProperty('operation');
    expect(legacyDerived.warnings).toEqual([]);
    expect(
      legacyDerived.bodyRepresentations[legacy.targetBodyId]?.consumed
    ).toBe(false);
    expect(
      legacyDerived.bodyRepresentations[legacyFeature.bodyId!]?.consumed
    ).toBe(false);
  });

  it('fails visibly instead of re-inferring when an edit removes stored overlap', async () => {
    const created = extrudeDocument('add', 8, 4);
    const baseFeature = listFeaturesInOrder(created.document)[0]!;
    const extrudeFeature = listFeaturesInOrder(created.document).at(-1)!;
    const edited = updateFeature(created.document, {
      featureId: baseFeature.featureId,
      data: { dimensions: { depth: 5 } }
    });
    const derived = await kernel.syncDocument(edited);

    expect(derived.bodyRepresentations[extrudeFeature.bodyId!]).toBeUndefined();
    expect(derived.bodyRepresentations[created.targetBodyId]?.consumed).toBe(
      false
    );
    expect(derived.warnings).toContain(
      'Feature "Extrude": Stored add extrusion no longer overlaps Base Body; operation was not re-inferred.'
    );
  });

  /**
   * The real app's boss: a sketch genuinely attached to a body face
   * (planeRef.type === 'face'), grown away from it. The earlier coverage
   * built a canonical-plane sketch and passed the attachment hint by hand,
   * which proved the document layer accepts a tangent add without proving
   * this path ever reaches it.
   */
  it('joins a boss grown off a real face-attached sketch', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument(
        'Face boss',
        toUserId('user_face_attached_boss')
      ),
      {
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 10 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;
    const baseDerived = await kernel.syncDocument(base);
    const topFace = baseDerived.bodyRepresentations[
      targetBodyId
    ]!.topology!.faces.find(
      (face) => face.reference?.lineageName === 'primitive.box.face.z-max'
    )!;
    const geometry = topFace.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...base, derived: baseDerived },
      {
        name: 'Boss profile',
        planeRef: {
          type: 'face',
          bodyId: targetBodyId,
          faceHash: topFace.hash,
          // The app always carries the v5 lineage reference; without it the
          // rebuild falls back to the stored migration frame and warns.
          ...(topFace.reference ? { faceReference: topFace.reference } : {}),
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            origin: { ...geometry.center },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { ...geometry.normal! }
          }
        },
        objects: [
          {
            objectKind: 'circle',
            radius: 3,
            centerX: 0,
            centerY: 0
          }
        ]
      }
    );

    const resolved = await resolveExtrudeOperation({
      base: withSketch,
      input: { name: 'Boss', sketchId, distance: 6 },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: targetBodyId, direction: 'away' }
    });

    expect(resolved.inference).toMatchObject({
      operation: 'add',
      reason: 'onto-face-body',
      targetBodyId
    });
    const result =
      resolved.derived.bodyRepresentations[
        resolved.command.payload.ids!.bodyId
      ];
    expect(result?.consumed).toBe(false);
    expect(resolved.derived.warnings).toEqual([]);
  });

  /**
   * The same boss, but grown off a body that is itself an extrusion rather
   * than a primitive. This is what the workspace actually produces — sketch,
   * extrude, then sketch on the result's face — and it is the shape the
   * primitive-target coverage above does not reach.
   */
  it('joins a boss grown off an extruded body face', async () => {
    let base = createProjectDocument(
      'Extruded face boss',
      toUserId('user_extruded_face_boss')
    );
    base = addSketchFeature(base, {
      name: 'Base profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
    }).document;
    const baseExtrude = extrudeSketch(base, {
      name: 'Base extrude',
      sketchId: getLatestSketchId(base)!,
      distance: 18
    });
    const targetBodyId = baseExtrude.bodyId;
    const targetDerived = await kernel.syncDocument(baseExtrude.document);
    const faces = targetDerived.bodyRepresentations[
      targetBodyId
    ]!.topology!.faces.filter((face) => face.geometry?.surfaceType === 'plane');
    // The cap the boss grows from: the planar face highest along +Z.
    const topFace = faces.reduce((best, face) =>
      (face.geometry!.center.z ?? 0) > (best.geometry!.center.z ?? 0)
        ? face
        : best
    );
    const geometry = topFace.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...baseExtrude.document, derived: targetDerived },
      {
        name: 'Boss profile',
        planeRef: {
          type: 'face',
          bodyId: targetBodyId,
          faceHash: topFace.hash,
          ...(topFace.reference ? { faceReference: topFace.reference } : {}),
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          frame: {
            // The disc's true centre. `geometry.center` is the surface's
            // reference point and sits on the rim of a round face.
            origin: { x: 0, y: 0, z: geometry.center.z },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { ...geometry.normal! }
          }
        },
        objects: [
          { objectKind: 'circle', radius: 3, centerX: 0, centerY: 0 }
        ]
      }
    );

    const resolved = await resolveExtrudeOperation({
      base: withSketch,
      input: { name: 'Boss', sketchId, distance: 6 },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: targetBodyId, direction: 'away' }
    });

    expect(resolved.inference).toMatchObject({
      operation: 'add',
      reason: 'onto-face-body',
      targetBodyId
    });
    const result =
      resolved.derived.bodyRepresentations[
        resolved.command.payload.ids!.bodyId
      ];
    expect(result?.consumed).toBe(false);
  });

  /**
   * A boss whose profile hangs off the rim of the face it was sketched on:
   * part of it sits over the body, part over nothing. It still touches, so it
   * still joins — this is the shape a user draws when they eyeball a boss
   * near an edge, and the one that first exposed the silent new-body
   * fallback in the workspace.
   */
  // KNOWN DEFECT, kept as an expected failure so it is tracked rather than
  // forgotten. A face sketch's basis resolves its origin from the face's
  // surface reference point, and on a round face that point sits on the rim,
  // not the centre. Profile coordinates are therefore offset by the rim
  // distance: the circle below is authored at (9, 0) and lands at (9, 10),
  // clear of the body, so the add is correctly refused for geometry the user
  // never asked for. The union logic itself is fine — the two tests above
  // pass. Same `geometry.center` trap as the sketch-entry framing fix.
  it.fails('joins a boss whose profile overhangs the face rim', async () => {
    let base = createProjectDocument(
      'Overhanging boss',
      toUserId('user_overhanging_boss')
    );
    base = addSketchFeature(base, {
      name: 'Base profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
    }).document;
    const baseExtrude = extrudeSketch(base, {
      name: 'Base extrude',
      sketchId: getLatestSketchId(base)!,
      distance: 18
    });
    const targetBodyId = baseExtrude.bodyId;
    const targetDerived = await kernel.syncDocument(baseExtrude.document);
    const topFace = targetDerived.bodyRepresentations[targetBodyId]!
      .topology!.faces.filter((face) => face.geometry?.surfaceType === 'plane')
      .reduce((best, face) =>
        (face.geometry!.center.z ?? 0) > (best.geometry!.center.z ?? 0)
          ? face
          : best
      );
    const geometry = topFace.geometry!;
    const { document: withSketch, sketchId } = addSketchFeature(
      { ...baseExtrude.document, derived: targetDerived },
      {
        name: 'Boss profile',
        planeRef: {
          type: 'face',
          bodyId: targetBodyId,
          faceHash: topFace.hash,
          ...(topFace.reference ? { faceReference: topFace.reference } : {}),
          sourceArea: geometry.area,
          sourceCenter: { x: 0, y: 0, z: geometry.center.z },
          sourceNormal: geometry.normal!,
          frame: {
            // The disc's true centre, so the profile below is placed
            // relative to the face rather than to a rim reference point.
            origin: { x: 0, y: 0, z: geometry.center.z },
            xAxis: { x: 1, y: 0, z: 0 },
            yAxis: { x: 0, y: 1, z: 0 },
            zAxis: { ...geometry.normal! }
          }
        },
        // Centre 9 from the axis with radius 4 on a radius-10 face: it
        // reaches 13, well past the rim.
        objects: [
          { objectKind: 'circle', radius: 4, centerX: 9, centerY: 0 }
        ]
      }
    );

    const resolved = await resolveExtrudeOperation({
      base: withSketch,
      input: { name: 'Boss', sketchId, distance: 6 },
      derive: (document) => kernel.syncDocument(document),
      faceAttachment: { bodyId: targetBodyId, direction: 'away' }
    });

    expect(resolved.inference.operation).toBe('add');
    const result =
      resolved.derived.bodyRepresentations[
        resolved.command.payload.ids!.bodyId
      ];
    expect(result?.consumed).toBe(false);
  });
});
