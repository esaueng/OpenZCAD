import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  featureReadsPrintClearance,
  findSketch,
  holeBody,
  holeCallout,
  holeOfBoreFace,
  listFeaturesInOrder,
  patternBody,
  updateFeature,
  type HoleInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  holeCalloutLabel,
  toUserId,
  type BodyId,
  type DerivedState,
  type DrawingViewId,
  type FeatureId,
  type HoleCallout,
  type ProjectDocument
} from '@openzcad/shared';
import {
  formatDrawingNumber,
  holeCalloutLookup,
  resolveDrawingAnnotation
} from '../apps/web/src/lib/drawing/annotations';

/**
 * M01 cosmetic threads and hole callouts (schema v67): what a hole says
 * beyond its diameter (its standard, its thread, cut or only described) is
 * read from the stored hole by `holeCallout`, and a D02 diameter on the rim
 * of its bore writes it out. A cosmetic thread keeps the tap-drill bore.
 */

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;
const mm = (n: number) => formatDrawingNumber(n, 2);

function plate(): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m01')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 40, depth: 10 }
    }
  );
}

const M6_TAP: HoleInput['standard'] = {
  system: 'iso',
  size: 'M6',
  kind: 'tap-drill'
};

describe('M01 hole callouts: what a drawing writes', () => {
  const base: HoleCallout = {
    count: 1,
    diameter: 5,
    depth: null,
    style: 'simple'
  };
  const thread = {
    designation: 'M6×1',
    majorDiameter: 6,
    pitch: 1,
    length: null,
    hand: 'right' as const,
    cosmetic: true
  };

  it.each([
    ['a plain hole', base, 'Ø5 THRU'],
    [
      'a clearance hole',
      {
        ...base,
        diameter: 6.6,
        standard: { system: 'iso', size: 'M6', kind: 'clearance' }
      },
      'Ø6.6 THRU, M6 CLEARANCE'
    ],
    [
      'a blind tap drill',
      { ...base, depth: 12, standard: M6_TAP },
      'Ø5 × 12 DEEP, M6×1 TAP DRILL'
    ],
    ['a thread through', { ...base, standard: M6_TAP, thread }, 'M6×1 THRU'],
    [
      'a thread the whole blind bore',
      { ...base, depth: 12, standard: M6_TAP, thread },
      'M6×1 × 12 DEEP'
    ],
    [
      'a thread stopped short, left-handed, at three points',
      {
        ...base,
        count: 3,
        depth: 12,
        standard: M6_TAP,
        thread: { ...thread, length: 8, hand: 'left' as const }
      },
      '3× M6×1 LH × 8 DEEP, Ø5 × 12 DEEP'
    ],
    [
      'a UNC thread',
      {
        ...base,
        diameter: 0.201,
        standard: { system: 'ansi', size: '1/4', kind: 'tap-drill' },
        thread: { ...thread, designation: '1/4-20 UNC' }
      },
      '1/4-20 UNC THRU'
    ]
  ] as const)('%s', (_label, callout, text) => {
    expect(holeCalloutLabel(callout as HoleCallout, mm)).toBe(text);
  });

  it('names the hole of a bore face, on points and as a pattern copy', () => {
    const hole = 'feat_hole' as FeatureId;
    const pattern = 'feat_row' as FeatureId;
    expect(
      holeOfBoreFace({
        producingFeatureId: hole,
        lineageName: 'hole.face.bore'
      })
    ).toBe(hole);
    expect(
      holeOfBoreFace({
        producingFeatureId: hole,
        lineageName: 'hole.face.at.node_a.bore'
      })
    ).toBe(hole);
    expect(
      holeOfBoreFace({
        producingFeatureId: pattern,
        lineageName: `pattern.face.instance.2.source.${hole}.hole.face.at.node_a.bore`
      })
    ).toBe(hole);
    expect(
      holeOfBoreFace({
        producingFeatureId: hole,
        lineageName: 'hole.face.counterbore'
      })
    ).toBeNull();
  });
});

describe('M01 hole callouts: read from the stored hole', () => {
  const input = (
    document: ProjectDocument,
    extra: Partial<HoleInput>
  ): HoleInput => ({
    name: 'Hole',
    targetBodyId: last(document),
    faceHash: 1,
    style: 'simple',
    diameter: 99,
    depthMode: 'blind',
    depth: 12,
    position: { u: 0, v: 0 },
    ...extra
  });

  it('reads the standard, the thread and its form, at schema v67', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(67);
    const document = plate();
    const holed = holeBody(
      document,
      input(document, {
        standard: M6_TAP,
        tapped: { length: 8, cosmetic: true }
      })
    ).document;
    expect(() => assertDocumentContentSchema(holed)).not.toThrow();
    expect(holeCallout(holed, lastFeature(holed))).toEqual({
      count: 1,
      // The table's, not the stored 99.
      diameter: 5,
      depth: 12,
      style: 'simple',
      standard: M6_TAP,
      thread: {
        designation: 'M6×1',
        majorDiameter: 6,
        pitch: 1,
        length: 8,
        hand: 'right',
        cosmetic: true
      }
    });
    // A cosmetic thread is not cut, so it reads no print clearance.
    expect(
      featureReadsPrintClearance(listFeaturesInOrder(holed).at(-1)!.data)
    ).toBe(false);
    // Not a hole: nothing to call out.
    expect(holeCallout(holed, listFeaturesInOrder(holed)[0]!.featureId)).toBe(
      null
    );
  });

  it('counts the bores on sketch points', () => {
    const sketched = addSketchFeature(plate(), {
      name: 'Points',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        { objectKind: 'point', x: 10, y: 10 },
        { objectKind: 'point', x: 30, y: 30 }
      ]
    });
    const holed = holeBody(
      sketched.document,
      input(sketched.document, {
        targetBodyId: sketched.document.bodyOrder[0]!,
        points: {
          sketchId: sketched.sketchId,
          pointIds: findSketch(
            sketched.document,
            sketched.sketchId
          )!.objectIds.map(String)
        }
      })
    ).document;
    expect(holeCallout(holed, lastFeature(holed))).toMatchObject({
      count: 2,
      diameter: 99
    });
  });

  it('refuses a cosmetic thread on a document that declares schema v66', () => {
    const document = plate();
    const old = {
      ...document,
      schemaVersion: 66
    } as unknown as ProjectDocument;
    expect(() =>
      holeBody(
        old,
        input(document, { standard: M6_TAP, tapped: { cosmetic: true } })
      )
    ).toThrow(/Cosmetic threads require project schema v67/);
  });
});

describe('M01 cosmetic threads: exact build and D02 callout', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  async function drilled(extra: Partial<HoleInput>) {
    const document = plate();
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[last(document)]!;
    const face = body.topology!.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.999 &&
        Math.abs(
          (candidate.geometry.centroid ?? candidate.geometry.center).z -
            body.bbox.max.z
        ) < 1e-6
    )!;
    const holed = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 5,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      standard: M6_TAP,
      ...extra
    }).document;
    return { document: holed, derived: await adapter.syncDocument(holed) };
  }

  function failures(derived: DerivedState): string {
    return (derived.featureWarnings ?? [])
      .filter((warning) => warning.kind !== 'advisory')
      .map((warning) => warning.message)
      .join('\n');
  }

  it('keeps the tap-drill bore, named as the bore, and says no print advice', async () => {
    const cosmetic = await drilled({ tapped: { cosmetic: true } });
    const plain = await drilled({});
    expect(failures(cosmetic.derived)).toBe('');
    expect(cosmetic.derived.featureWarnings ?? []).toEqual([]);
    const body = cosmetic.derived.bodyRepresentations[last(cosmetic.document)]!;
    expect(body.volume).toBeCloseTo(
      plain.derived.bodyRepresentations[last(plain.document)]!.volume,
      9
    );
    expect(body.volume).toBeCloseTo(40 * 40 * 10 - Math.PI * 2.5 ** 2 * 10, 6);
    expect(
      body.topology!.faces.map((face) => face.reference?.lineageName)
    ).toContain('hole.face.bore');
  }, 180_000);

  it('keeps a kept drawing’s callout to the document it was drawn from (review)', async () => {
    const topId = 'dvw_top' as DrawingViewId;
    const { document, derived } = await drilled({
      depthMode: 'blind',
      depth: 8,
      tapped: { cosmetic: true }
    });
    const bodyId = last(document);
    const bodies = derived.bodyRepresentations;
    const rim = bodies[bodyId]!.topology!.edges.find(
      (edge) =>
        edge.curve?.circle &&
        Math.abs(edge.curve.circle.radius - 2.5) < 1e-6 &&
        Math.abs(edge.curve.circle.center.z - 10) < 1e-6
    )!;
    const annotation = {
      annotationId: 'dan_d' as never,
      kind: 'diameter' as const,
      viewId: topId,
      edge: {
        bodyId,
        hash: rim.hash,
        ...(rim.reference ? { reference: rim.reference } : {})
      },
      placementMm: { x: 10, y: 10 }
    };
    const view = {
      viewId: topId,
      orientation: 'top' as const,
      bodyIds: [bodyId],
      centerMm: { x: 100, y: 120 },
      hiddenLines: false
    };
    // Drawn from this document, the sheet is kept with its bodies and its
    // lookup; the model then deepens the hole before any Update.
    const drawn = holeCalloutLookup(document);
    expect(drawn(lastFeature(document))?.depth).toBe(8);
    const deeper = updateFeature(document, {
      featureId: lastFeature(document),
      data: { featureKind: 'hole', depth: 12 }
    });
    const label = (holes: ReturnType<typeof holeCalloutLookup>) => {
      const resolved = resolveDrawingAnnotation(
        annotation,
        view,
        bodies,
        'mm',
        holes
      );
      return resolved.ok ? resolved.resolved.label : null;
    };
    // The kept drawing reads what it drew; only the current model's lookup
    // (after an Update redraws the bodies) would say 12.
    expect(label(drawn)).toBe('M6×1 × 8 DEEP');
    expect(label(holeCalloutLookup(deeper))).toBe('M6×1 × 12 DEEP');
  }, 180_000);

  it('leaves a feature pattern’s copies of a cosmetic thread as plain tap drills', async () => {
    const { document } = await drilled({ tapped: { cosmetic: true } });
    const holeId = lastFeature(document);
    const row = patternBody(document, {
      name: 'Row',
      targetBodyId: last(document),
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 8,
      sourceFeatureIds: [holeId]
    }).document;
    const derived = await adapter.syncDocument(row);
    expect(failures(derived)).toBe('');
    expect(derived.bodyRepresentations[last(row)]!.volume).toBeCloseTo(
      40 * 40 * 10 - 3 * Math.PI * 2.5 ** 2 * 10,
      6
    );
  }, 180_000);

  it('writes the thread on a diameter at the bore’s rim', async () => {
    const topId = 'dvw_top' as DrawingViewId;
    for (const [extra, text] of [
      [{ tapped: { cosmetic: true as const } }, 'M6×1 THRU'],
      [
        {
          depthMode: 'blind' as const,
          depth: 8,
          tapped: { cosmetic: true as const, length: 6 }
        },
        'M6×1 × 6 DEEP, Ø5 × 8 DEEP'
      ],
      [{}, 'Ø5 THRU, M6×1 TAP DRILL']
    ] as const) {
      const { document, derived } = await drilled(extra);
      expect(failures(derived)).toBe('');
      const bodyId = last(document);
      const bodies = derived.bodyRepresentations;
      const rim = bodies[bodyId]!.topology!.edges.find(
        (edge) =>
          edge.curve?.circle &&
          Math.abs(edge.curve.circle.radius - 2.5) < 1e-6 &&
          Math.abs(edge.curve.circle.center.z - 10) < 1e-6
      )!;
      expect(rim).toBeDefined();
      const annotation = {
        annotationId: 'dan_d' as never,
        kind: 'diameter' as const,
        viewId: topId,
        edge: {
          bodyId,
          hash: rim.hash,
          ...(rim.reference ? { reference: rim.reference } : {})
        },
        placementMm: { x: 10, y: 10 }
      };
      const view = {
        viewId: topId,
        orientation: 'top' as const,
        bodyIds: [bodyId],
        centerMm: { x: 100, y: 120 },
        hiddenLines: false
      };
      const holes = (featureId: FeatureId) => holeCallout(document, featureId);
      const called = resolveDrawingAnnotation(
        annotation,
        view,
        bodies,
        'mm',
        holes
      );
      expect(called.ok && called.resolved.label).toBe(text);
      // Without the document's holes it is the bare diameter, as before.
      const bare = resolveDrawingAnnotation(annotation, view, bodies, 'mm');
      expect(bare.ok && bare.resolved.label).toBe('Ø5');
    }
  }, 180_000);
});
