import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  draftBody,
  findSketch,
  helicalSweepProfile,
  listFeaturesInOrder,
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
  type SketchPathReference,
  type SketchSectionReference
} from '@openzcad/shared';
import { createProjectDocument } from '@openzcad/document-core';
import { commandFactories, replayCommands } from '@openzcad/command-system';

function addSection(
  document: ProjectDocument,
  name: string,
  offset: number,
  object: SketchObjectData,
  plane: 'XY' | 'XZ' | 'YZ' = 'XY'
): { document: ProjectDocument; section: SketchSectionReference } {
  const result = addSketchFeature(document, {
    name,
    plane,
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

  it('refuses a loft apex point that falls inside the section run', async () => {
    // The kernel applies `endPoint` unconditionally. An apex between the two
    // sections folds the last ruled band back through the body: on this
    // fixture it reports volume 266.6667 \u2014 *less* than the 373.3333 the same
    // loft has without an apex \u2014 with the apex buried out of sight, no
    // validation error, and no warning. Measuring both builds is what catches
    // it; an apex further in (z = -5) fails validation outright.
    let document = createProjectDocument('Inside apex', toUserId('user_in'));
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
    const cases: ReadonlyArray<readonly [number, RegExp]> = [
      [
        5,
        /does not add material to this loft: the same sections loft to 373\.3333 mm\u00b3 without the apex and to 266\.6667 mm\u00b3 with it/
      ],
      [
        -5,
        /Loft to an apex point did not produce a valid closed solid\.[\s\S]*The same sections do loft into a valid solid without the apex point/
      ]
    ];
    for (const [z, message] of cases) {
      const refused = loftSections(upper.document, {
        name: `Inside apex ${z}`,
        sections: [lower.section, upper.section],
        mode: 'ruled',
        endPoint: { x: 0, y: 0, z }
      });
      const derived = await adapter.syncDocument(refused.document);
      expect(derived.warnings.join(' ')).toMatch(message);
      expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
    }
  });

  it('refuses an apex whose section straddles the closing plane', async () => {
    // The case two positional guards could not see. The first section is drawn
    // on XZ at y = -20 and spans z = 5..15, so it crosses the closing
    // section's own plane at z = 10: every rule of the form "some section has
    // to be on the far side" is satisfied on *both* sides at once, and the
    // wrong-side apex passed silently. Measured on the pinned kernel, the run
    // lofts to 2000.0000 with no apex; an apex at z = 20 adds the analytic
    // 100 x 10 / 3 cone for 2333.3333, while apexes at z = 0, z = -10 and
    // z = 4 report 1666.6667, 1333.3335 and 1800.0000 \u2014 333.33, 666.67 and 200
    // mm\u00b3 *less* material than no apex at all, each of them a self-intersecting
    // body that validates clean.
    let document = createProjectDocument('Straddle', toUserId('user_strad'));
    const straddling = addSection(
      document,
      'Straddling',
      -20,
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 0,
        centerY: -10
      },
      'XZ'
    );
    document = straddling.document;
    const closing = addSection(
      document,
      'Closing',
      10,
      {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 0,
        centerY: 20
      },
      'XY'
    );
    const sections = [straddling.section, closing.section];

    const plain = loftSections(closing.document, {
      name: 'Straddle plain',
      sections,
      mode: 'ruled'
    });
    const plainDerived = await adapter.syncDocument(plain.document);
    expect(plainDerived.warnings).toEqual([]);
    expect(plainDerived.bodyRepresentations[plain.bodyId]?.volume).toBeCloseTo(
      2000,
      3
    );

    const accepted = loftSections(closing.document, {
      name: 'Straddle clear apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: 25, z: 20 }
    });
    const acceptedDerived = await adapter.syncDocument(accepted.document);
    expect(acceptedDerived.warnings).toEqual([]);
    expect(
      acceptedDerived.bodyRepresentations[accepted.bodyId]?.volume
    ).toBeCloseTo(2333.3333, 3);

    const folded: ReadonlyArray<readonly [number, string]> = [
      [0, '1666.667'],
      [-10, '1333.333'],
      [4, '1800']
    ];
    for (const [z, volume] of folded) {
      const refused = loftSections(closing.document, {
        name: `Straddle folded apex ${z}`,
        sections,
        mode: 'ruled',
        endPoint: { x: 0, y: 25, z }
      });
      const derived = await adapter.syncDocument(refused.document);
      expect(derived.warnings.join(' ')).toContain(
        `does not add material to this loft: the same sections loft to 2000 mm\u00b3 without the apex and to ${volume} mm\u00b3 with it`
      );
      expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
    }
  });

  it('keeps an apex the model can barely measure', async () => {
    // The other edge of the same comparison: the slack has to be small enough
    // that a legitimately tiny apex is not thrown away as measurement noise.
    // Two microns above the 8 x 8 closing section adds 64 * 2e-6 / 3 = 4.3e-5
    // mm\u00b3, forty times the ~1e-6 mm\u00b3 the model's own tolerance allows, and it
    // builds.
    let document = createProjectDocument('Tiny apex', toUserId('user_tiny'));
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
      name: 'Tiny apex loft',
      sections: [lower.section, upper.section],
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 10.000002 }
    });
    const derived = await adapter.syncDocument(lofted.document);
    const body = derived.bodyRepresentations[lofted.bodyId];
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(373.3333333333333);
    expect(body?.volume).toBeCloseTo(373.3333760000001, 6);
  });

  it('closes a descending section run to an apex below it', async () => {
    // The guard is not a "higher z" test: reverse the section order and the
    // apex that was refused above is the one that adds material.
    let document = createProjectDocument('Down apex', toUserId('user_down'));
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
    const apexed = loftSections(upper.document, {
      name: 'Down apex loft',
      sections: [upper.section, lower.section],
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: -5 }
    });
    const derived = await adapter.syncDocument(apexed.document);
    const body = derived.bodyRepresentations[apexed.bodyId];
    expect(derived.warnings).toEqual([]);
    // The same 373.3333 frustum plus a 4 x 4 base, 5 tall pyramid (26.6667).
    expect(body?.volume).toBeCloseTo(400, 3);
    expect(body?.bbox.min.z).toBeCloseTo(-5, 6);
  });

  it('closes a loft to an apex far off the section axis', async () => {
    // The guard asks only whether the apex adds material, so how far to one
    // side it sits is the user's business: 200 mm off axis and 1 mm beyond
    // still builds, at the analytic 373.3333 frustum plus a 8 x 8 base, 1 tall
    // pyramid (21.3333).
    let document = createProjectDocument('Oblique', toUserId('user_obl'));
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
      name: 'Oblique apex loft',
      sections: [lower.section, upper.section],
      mode: 'ruled',
      endPoint: { x: 200, y: 0, z: 11 }
    });
    const derived = await adapter.syncDocument(lofted.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[lofted.bodyId]?.volume).toBeCloseTo(
      394.6666613,
      3
    );
  });

  it('refuses an apex a coplanar closing section hid from the side test', async () => {
    // Three sections, the last two on the same plane. Measured on the pinned
    // kernel this run lofts to 373.3333 with no apex, to 433.3333 with an apex
    // at z = 15 — and to 313.3334 with an apex at z = 5, which is *less*
    // material than no apex at all, buried out of sight, with no warning. A
    // guard that skips itself when the section before the closing one is
    // coplanar with it leaves exactly that fail-open reachable.
    let document = createProjectDocument('Coplanar apex', toUserId('user_cop'));
    const lower = addSection(document, 'Lower', 0, {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const wide = addSection(document, 'Wide', 10, {
      objectKind: 'rectangle',
      width: 8,
      height: 8,
      centerX: 0,
      centerY: 0
    });
    document = wide.document;
    const closing = addSection(document, 'Closing', 10, {
      objectKind: 'rectangle',
      width: 6,
      height: 6,
      centerX: 0,
      centerY: 0
    });
    const sections = [lower.section, wide.section, closing.section];
    const refused = loftSections(closing.document, {
      name: 'Coplanar inside apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 5 }
    });
    const refusedDerived = await adapter.syncDocument(refused.document);
    expect(refusedDerived.warnings.join(' ')).toMatch(
      /does not add material to this loft: the same sections loft to 373\.3333 mm³ without the apex and to 313\.3334 mm³ with it/
    );
    expect(refusedDerived.bodyRepresentations[refused.bodyId]).toBeUndefined();

    // The same run with the apex on the far side still builds: closing the
    // hole must not cost the valid case.
    const accepted = loftSections(closing.document, {
      name: 'Coplanar outside apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 15 }
    });
    const acceptedDerived = await adapter.syncDocument(accepted.document);
    expect(acceptedDerived.warnings).toEqual([]);
    expect(
      acceptedDerived.bodyRepresentations[accepted.bodyId]?.volume
    ).toBeCloseTo(433.3333133, 3);
  });

  it('refuses an apex an earlier section already reaches past', async () => {
    // A run that overshoots: the middle section sits 10 beyond the closing
    // one. An apex at z = 5 is on the far side of the closing section from
    // that middle section, so a side test alone accepts it — and measured,
    // it returns 193.3334 against the 253.3333 of the same run with no apex.
    // Comparing the two builds is what refuses it.
    let document = createProjectDocument('Overshoot', toUserId('user_over'));
    const lower = addSection(document, 'Lower', 0, {
      objectKind: 'rectangle',
      width: 4,
      height: 4,
      centerX: 0,
      centerY: 0
    });
    document = lower.document;
    const beyond = addSection(document, 'Beyond', 20, {
      objectKind: 'rectangle',
      width: 8,
      height: 8,
      centerX: 0,
      centerY: 0
    });
    document = beyond.document;
    const closing = addSection(document, 'Closing', 10, {
      objectKind: 'rectangle',
      width: 6,
      height: 6,
      centerX: 0,
      centerY: 0
    });
    const sections = [lower.section, beyond.section, closing.section];
    const refused = loftSections(closing.document, {
      name: 'Overshoot inside apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 5 }
    });
    const refusedDerived = await adapter.syncDocument(refused.document);
    expect(refusedDerived.warnings.join(' ')).toMatch(
      /does not add material to this loft: the same sections loft to 253\.3333 mm³ without the apex and to 193\.3334 mm³ with it/
    );
    expect(refusedDerived.bodyRepresentations[refused.bodyId]).toBeUndefined();

    // An apex clear of every section still builds, so the guard refuses the
    // fold rather than the overshooting run: 253.3333 plus the 6 x 6 base,
    // 15 tall cone (180).
    const accepted = loftSections(closing.document, {
      name: 'Overshoot clear apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: 0, z: 25 }
    });
    const acceptedDerived = await adapter.syncDocument(accepted.document);
    expect(acceptedDerived.warnings).toEqual([]);
    expect(
      acceptedDerived.bodyRepresentations[accepted.bodyId]?.volume
    ).toBeCloseTo(433.3332733, 3);
  });

  it('refuses a coplanar run there is no baseline to check the apex against', async () => {
    // STRENGTHENED, same fixtures. This run used to *build*: sections that all
    // lie in the closing plane enclose nothing, so the guard substituted a
    // baseline of nought material and waved the apex through on the reasoning
    // that there is no interior for it to fold into. True about folding, false
    // about the result — and fail-open, because the substitute admits a body
    // nobody measured.
    //
    // What the kernel actually builds is a pyramid off the *last* section with
    // every earlier section kept in the B-Rep as a zero-thickness web holding
    // no material at all. Measured on the pinned kernel, with the apex sign
    // making no difference in any case, which is the invariant failing to
    // decide rather than deciding:
    //
    //   4x4 then closing 8x8, apex z = +/-10   -> 213.3333, faces 10
    //         = the 8 x 8 x 10 / 3 pyramid alone; the 4 x 4 is a sheet
    //   100x100 then closing 4x4, apex z = +/-10 -> 53.3333, bbox x[-50, 50]
    //         = the 4 x 4 x 10 / 3 pyramid alone, inside a 100 mm bounding box
    //   4x4 at x = -20 then closing 4x4 at x = +20, apex (20, 0, +/-10)
    //         -> 53.3333, centre of mass x = 20.0, i.e. the section at
    //            x = -20 is entirely absent from the body's mass
    //
    // all three with exportableStep true and no warning. So the substitute
    // baseline is gone and a run with no measured baseline is refused.
    const runs: ReadonlyArray<
      readonly [string, SketchObjectData, SketchObjectData, number]
    > = [
      [
        'Flat run',
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 0,
          centerY: 0
        },
        {
          objectKind: 'rectangle',
          width: 8,
          height: 8,
          centerX: 0,
          centerY: 0
        },
        0
      ],
      [
        'Wide run',
        {
          objectKind: 'rectangle',
          width: 100,
          height: 100,
          centerX: 0,
          centerY: 0
        },
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 0,
          centerY: 0
        },
        0
      ],
      [
        'Disjoint run',
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: -20,
          centerY: 0
        },
        {
          objectKind: 'rectangle',
          width: 4,
          height: 4,
          centerX: 20,
          centerY: 0
        },
        20
      ]
    ];
    for (const [label, firstObject, closingObject, apexX] of runs) {
      let document = createProjectDocument(label, toUserId('user_flat2'));
      const first = addSection(document, 'First', 0, firstObject);
      document = first.document;
      const closing = addSection(document, 'Closing', 0, closingObject);
      for (const z of [10, -10]) {
        const refused = loftSections(closing.document, {
          name: `${label} apex ${z}`,
          sections: [first.section, closing.section],
          mode: 'ruled',
          endPoint: { x: apexX, y: 0, z }
        });
        const derived = await adapter.syncDocument(refused.document);
        expect(derived.warnings.join(' ')).toMatch(
          /The loft apex point cannot be checked on this loft: the same sections do not loft into a valid solid without it/
        );
        expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
      }
    }
  });

  it('refuses a loft apex that would trade exact curved surfaces for facets', async () => {
    // `loftWithOptions` has no exact apexed surfacing: it rebuilds the whole
    // body chordally. Measured on the pinned kernel for circles r = 2 on XY at
    // z = 0 and r = 3 on XY at z = 10:
    //
    //   no apex       198.967535 = the analytic frustum exactly, 3 B-Rep faces
    //                              (1 cone + 2 planes), exportableStep true
    //   apex z = 11   207.055862 against the analytic 208.392313, -0.6413%,
    //                              66 faces, every one of them a plane
    //   apex z = 20   291.334884 against the analytic 293.215314, -0.6413%,
    //                              66 faces, every one of them a plane
    //
    // Both apexed builds validated clean, warned nothing and were offered for
    // STEP export — a 32-segment prism shipped as if it were an exact cone.
    // The refusal is measured from those two censuses, so the unapexed loft
    // has to keep building exactly.
    let document = createProjectDocument('Curved apex', toUserId('user_curv'));
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
    const sections = [lower.section, upper.section];

    const plain = loftSections(upper.document, {
      name: 'Curved plain loft',
      sections,
      mode: 'ruled'
    });
    const plainDerived = await adapter.syncDocument(plain.document);
    const plainBody = plainDerived.bodyRepresentations[plain.bodyId];
    expect(plainDerived.warnings).toEqual([]);
    expect(plainBody?.volume).toBeCloseTo(198.9675347, 6);
    expect(plainBody?.faceCount).toBe(3);
    expect(plainBody?.exportableStep).toBe(true);

    // Refused whether the apex is small enough to lose to the chord ratio or
    // far enough out to beat it: the loss is the same either way, so the
    // volume comparison must not be what decides this.
    for (const z of [11, 20]) {
      const refused = loftSections(upper.document, {
        name: `Curved apex ${z}`,
        sections,
        mode: 'ruled',
        endPoint: { x: 0, y: 0, z }
      });
      const derived = await adapter.syncDocument(refused.document);
      expect(derived.warnings.join(' ')).toMatch(
        /The loft apex point would drop this body's exact curved surfaces: the same build carries 1 cone face without it and no curved faces with it/
      );
      expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
    }
  });

  it('does not blame the apex for a loft the sections cannot make', async () => {
    // Sections on planes at right angles: the kernel refuses this run whether
    // or not an apex is asked for. The apex here is correctly placed — clear
    // of the closing section, on the far side from the other one — so advice
    // to move or clear it sends the user after the wrong input.
    let document = createProjectDocument('Crossed', toUserId('user_cross'));
    const flat = addSection(
      document,
      'Flat',
      0,
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 0, centerY: 20 },
      'XY'
    );
    document = flat.document;
    const upright = addSection(
      document,
      'Upright',
      0,
      { objectKind: 'rectangle', width: 4, height: 4, centerX: 0, centerY: 0 },
      'XZ'
    );
    const sections = [flat.section, upright.section];
    const plain = loftSections(upright.document, {
      name: 'Crossed plain',
      sections,
      mode: 'ruled'
    });
    const plainDerived = await adapter.syncDocument(plain.document);
    expect(plainDerived.warnings.join(' ')).toMatch(
      /Loft did not produce a valid closed solid/
    );

    const apexed = loftSections(upright.document, {
      name: 'Crossed apex',
      sections,
      mode: 'ruled',
      endPoint: { x: 0, y: -8, z: 0 }
    });
    const apexedDerived = await adapter.syncDocument(apexed.document);
    const message = apexedDerived.warnings.join(' ');
    expect(message).toMatch(/did not produce a valid closed solid/);
    expect(message).toMatch(
      /the section run itself is what the kernel cannot take/
    );
    expect(message).not.toMatch(/move the apex over the closing section/);
    expect(apexedDerived.bodyRepresentations[apexed.bodyId]).toBeUndefined();
  });

  it('refuses a loft apex point in smooth mode by name', async () => {
    let document = createProjectDocument(
      'Smooth apex',
      toUserId('user_smooth')
    );
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

  it('refuses a guide rail that would trade exact curved surfaces for facets', async () => {
    // The sharpest form of the same downgrade: the rail is *parallel* to the
    // path, so the correct answer is the plain sweep unchanged. Measured on
    // the pinned kernel for a circle r = 2 swept along (0,0) -> (0,20):
    //
    //   no rail   251.327412 = pi * 4 * 20 exactly, 3 B-Rep faces
    //                          (1 cylinder + 2 planes), exportableStep true
    //   with rail 246.254503 against the same analytic 251.327412, -2.0184%,
    //                          74 faces, every one of them a plane
    //
    // An 18-sided prism two percent undersized, validating clean, warning
    // nothing, and offered for STEP export.
    let document = createProjectDocument('Curved rail', toUserId('user_crail'));
    const profile = addSection(document, 'Profile', 0, {
      objectKind: 'circle',
      radius: 2,
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

    const plain = sweepProfile(rail.document, {
      name: 'Curved plain sweep',
      profile: profile.section,
      path: pathReference,
      mode: 'standard'
    });
    const plainDerived = await adapter.syncDocument(plain.document);
    const plainBody = plainDerived.bodyRepresentations[plain.bodyId];
    expect(plainDerived.warnings).toEqual([]);
    expect(plainBody?.volume).toBeCloseTo(251.3274123, 6);
    expect(plainBody?.faceCount).toBe(3);
    expect(plainBody?.exportableStep).toBe(true);

    const refused = sweepProfile(rail.document, {
      name: 'Curved guided sweep',
      profile: profile.section,
      path: pathReference,
      mode: 'standard',
      guide: {
        sketchId: rail.sketchId,
        entityIds: findSketch(rail.document, rail.sketchId)!.objectIds
      }
    });
    const derived = await adapter.syncDocument(refused.document);
    expect(derived.warnings.join(' ')).toMatch(
      /A sweep guide rail would drop this body's exact curved surfaces: the same build carries 1 cylinder face without it and no curved faces with it/
    );
    expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
  });

  it('refuses a guide rail on a smooth sweep rather than resurfacing it', async () => {
    // `guidedSweep` takes no segment count and no surfacing argument, so a
    // saved Smooth sweep would come back at the kernel's default surfacing
    // while the feature still reads Smooth.
    let document = createProjectDocument('Smooth rail', toUserId('user_sm'));
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
    const refused = sweepProfile(rail.document, {
      name: 'Smooth guided sweep',
      profile: profile.section,
      path: {
        sketchId: path.sketchId,
        entityIds: findSketch(rail.document, path.sketchId)!.objectIds
      },
      mode: 'smooth',
      guide: {
        sketchId: rail.sketchId,
        entityIds: findSketch(rail.document, rail.sketchId)!.objectIds
      }
    });
    const derived = await adapter.syncDocument(refused.document);
    expect(derived.warnings.join(' ')).toMatch(
      /A sweep guide rail is available in Standard surface mode only/
    );
    expect(derived.bodyRepresentations[refused.bodyId]).toBeUndefined();
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

  it('holds a guide rail to the same edit checks the sweep path gets', () => {
    let document = createProjectDocument('Rail edit', toUserId('user_edit'));
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
    const swept = sweepProfile(rail.document, {
      name: 'Guided sweep',
      profile: profile.section,
      path: pathReference,
      mode: 'standard'
    });
    const featureId = listFeaturesInOrder(swept.document).find(
      (feature) => feature.name === 'Guided sweep'
    )!.featureId;
    const edit = (guide: SketchPathReference) =>
      commandFactories
        .updateFeature({
          featureId,
          data: {
            featureKind: 'sweep',
            profile: profile.section,
            path: pathReference,
            mode: 'standard',
            guide
          }
        })
        .validate(swept.document);

    expect(() =>
      edit({
        sketchId: rail.sketchId,
        entityIds: findSketch(rail.document, rail.sketchId)!.objectIds
      })
    ).not.toThrow();
    expect(() => edit({ sketchId: rail.sketchId, entityIds: [] })).toThrow(
      /guide rail sketch is unavailable or empty/
    );
    expect(() =>
      edit({
        sketchId: rail.sketchId,
        entityIds: findSketch(rail.document, path.sketchId)!.objectIds
      })
    ).toThrow(/guide rail references a missing sketch entity/);
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
