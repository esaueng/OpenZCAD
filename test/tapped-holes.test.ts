import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  featureReadsPrintClearance,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  setPrintClearance,
  threadBody,
  type HoleInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureData,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';

/**
 * M01 tapped holes (schema v66): a hole sized as a standard tap drill is
 * tapped with its standard's thread by the M15 thread generator, and reads
 * the L09 document print clearance where it sets none. Each tapped hole is
 * checked against an M15 Thread cut into the same tap-drill bore: the same
 * thread data, so the same solid, to the volume.
 */

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

function plate(units: UnitSystem, size: number, depth: number) {
  return addPrimitiveFeature(
    createProjectDocument('Plate', toUserId('user_m01'), units),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: size, height: size, depth }
    }
  );
}

function topFace(derived: DerivedState, bodyId: BodyId) {
  const body = derived.bodyRepresentations[bodyId]!;
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(
        (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
      ) < 1e-6
  )!;
}

/** Everything the build said but its print advice. */
function failures(derived: DerivedState): string {
  const advice = (derived.featureWarnings ?? [])
    .filter((warning) => warning.kind === 'advisory')
    .map((warning) => warning.message);
  return [
    ...derived.warnings.filter(
      (warning) => !advice.some((message) => warning.includes(message))
    ),
    ...(derived.featureWarnings ?? [])
      .filter((warning) => warning.kind !== 'advisory')
      .map((warning) => warning.message)
  ].join('\n');
}

const M6_TAP: HoleInput['standard'] = {
  system: 'iso',
  size: 'M6',
  kind: 'tap-drill'
};

describe('M01 tapped holes: document contract', () => {
  const input = (document: ProjectDocument): HoleInput => ({
    name: 'Hole',
    targetBodyId: last(document),
    faceHash: 1,
    style: 'simple',
    diameter: 5,
    depthMode: 'through',
    position: { u: 0, v: 0 },
    standard: M6_TAP,
    tapped: {}
  });

  it('stores the tapping at schema v66, and reads the print clearance', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
    const document = plate('mm', 40, 10);
    const holed = holeBody(document, input(document)).document;
    const data = listFeaturesInOrder(holed).at(-1)!.data;
    expect(data).toMatchObject({ tapped: {} });
    expect(() => assertDocumentContentSchema(holed)).not.toThrow();
    // Like a Thread: without its own clearance it builds from the document's.
    expect(featureReadsPrintClearance(data)).toBe(true);
    expect(
      featureReadsPrintClearance({
        ...data,
        tapped: { clearance: 0 }
      } as FeatureData)
    ).toBe(false);
  });

  it.each([
    ['no standard', { standard: undefined }],
    [
      'a clearance hole',
      { standard: { system: 'iso', size: 'M6', kind: 'clearance' } }
    ],
    ['a hand that is neither', { tapped: { hand: 'up' } }]
  ] as const)('refuses tapping %s', (_label, patch) => {
    const document = plate('mm', 40, 10);
    expect(() =>
      holeBody(document, {
        ...input(document),
        ...(patch as Partial<HoleInput>)
      })
    ).toThrow(/tap drill can be tapped|right- or left-handed/);
  });

  it('refuses a tapped hole on a document that declares schema v65', () => {
    const document = plate('mm', 40, 10);
    const old = {
      ...document,
      schemaVersion: 65
    } as unknown as ProjectDocument;
    expect(() => holeBody(old, input(document))).toThrow(
      /Tapped holes require project schema v66/
    );
  });
});

describe('M01 tapped holes: exact build', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  /** A tap-drill hole in `document`'s plate, tapped or not. */
  async function tapDrill(
    document: ProjectDocument,
    extra: Partial<HoleInput>
  ): Promise<ProjectDocument> {
    const derived = await adapter.syncDocument(document);
    const face = topFace(derived, last(document));
    return holeBody(document, {
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
  }

  /** The untapped hole with an M15 Thread cut into its bore. */
  async function threaded(
    document: ProjectDocument,
    thread: Partial<Extract<FeatureData, { featureKind: 'thread' }>> = {}
  ): Promise<ProjectDocument> {
    const derived = await adapter.syncDocument(document);
    const bore = derived.bodyRepresentations[
      last(document)
    ]!.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    ).sort((a, b) => (a.geometry!.radius ?? 0) - (b.geometry!.radius ?? 0))[0]!;
    return threadBody(document, {
      name: 'Thread',
      targetBodyId: last(document),
      faceHash: bore.hash,
      ...(bore.reference ? { faceReference: bore.reference } : {}),
      profile: 'iso-metric',
      majorDiameter: 6,
      pitch: 1,
      ...thread
    }).document;
  }

  async function volume(document: ProjectDocument): Promise<number> {
    const derived = await adapter.syncDocument(document);
    expect(failures(derived)).toBe('');
    return derived.bodyRepresentations[last(document)]!.volume;
  }

  it('cuts the M6 thread into a through tap drill, as a Thread on that bore does', async () => {
    const base = plate('mm', 40, 10);
    const tapped = await tapDrill(base, { tapped: {} });
    const derived = await adapter.syncDocument(tapped);
    expect(failures(derived)).toBe('');
    // Print advice, said once, as a Thread says it.
    expect(
      (derived.featureWarnings ?? []).filter(
        (warning) => warning.kind === 'advisory'
      ).length
    ).toBeGreaterThan(0);
    const reference = await volume(await threaded(await tapDrill(base, {})));
    const plain = await volume(await tapDrill(base, {}));
    const cut = derived.bodyRepresentations[last(tapped)]!.volume;
    expect(cut).toBeCloseTo(reference, 6);
    // The thread takes material beyond the Ø5 bore.
    expect(cut).toBeLessThan(plain - 1);
  }, 180_000);

  it('stops a blind thread short from the entry end', async () => {
    const base = plate('mm', 40, 10);
    const tapped = await tapDrill(base, {
      depthMode: 'blind',
      depth: 8,
      tapped: { length: 5 }
    });
    const derived = await adapter.syncDocument(tapped);
    expect(failures(derived)).toBe('');
    const body = derived.bodyRepresentations[last(tapped)]!;
    // The thread's faces lie between the entry (z = 10) and 5 below it; the
    // plain bore runs on to the floor at z = 2.
    const threadFaces = body.topology!.faces.filter(
      (face) =>
        face.geometry &&
        face.geometry.surfaceType !== 'plane' &&
        face.geometry.surfaceType !== 'cylinder'
    );
    expect(threadFaces.length).toBeGreaterThan(0);
    for (const face of threadFaces) {
      expect(face.geometry!.center.z).toBeGreaterThan(5 - 1e-6);
    }
    expect(
      body.topology!.faces.some(
        (face) =>
          face.geometry?.surfaceType === 'cylinder' &&
          Math.abs((face.geometry.radius ?? 0) - 2.5) < 1e-6
      )
    ).toBe(true);
    const reference = await volume(
      await threaded(await tapDrill(base, { depthMode: 'blind', depth: 8 }), {
        length: 5
      })
    );
    expect(body.volume).toBeCloseTo(reference, 6);
  }, 180_000);

  it('reads the document print clearance, as a Thread with the Document fit does', async () => {
    const base = setPrintClearance(plate('mm', 40, 10), { value: 0.1 });
    const tapped = await tapDrill(base, { tapped: {} });
    const withGap = await volume(tapped);
    const reference = await volume(await threaded(await tapDrill(base, {})));
    expect(withGap).toBeCloseTo(reference, 6);
    // Its own clearance wins: 0 is the thread without the document's gap.
    const exact = await volume(
      await tapDrill(base, { tapped: { clearance: 0 } })
    );
    expect(exact).toBeGreaterThan(withGap + 1e-3);
  }, 180_000);

  it('taps 1/4-20 UNC in an inch document, as a Thread of that size', async () => {
    const base = plate('inch', 2, 0.5);
    const tap = async (extra: Partial<HoleInput>) => {
      const derived = await adapter.syncDocument(base);
      const face = topFace(derived, last(base));
      return holeBody(base, {
        name: 'Hole',
        targetBodyId: last(base),
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        style: 'simple',
        diameter: 0.201,
        depthMode: 'through',
        position: { u: 0, v: 0 },
        positionAnchor: 'centroid',
        standard: { system: 'ansi', size: '1/4', kind: 'tap-drill' },
        ...extra
      }).document;
    };
    const tapped = await volume(await tap({ tapped: {} }));
    const reference = await volume(
      await threaded(await tap({}), { majorDiameter: 0.25, pitch: 0.05 })
    );
    expect(tapped).toBeCloseTo(reference, 9);
  }, 180_000);

  it('taps every bore on sketch points', async () => {
    const base = plate('mm', 40, 10);
    const sketched = addSketchFeature(base, {
      name: 'Points',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        { objectKind: 'point', x: 10, y: 10 },
        { objectKind: 'point', x: 30, y: 30 }
      ]
    });
    const pointIds = findSketch(
      sketched.document,
      sketched.sketchId
    )!.objectIds.map(String);
    const both = await volume(
      await tapDrill(sketched.document, {
        points: { sketchId: sketched.sketchId, pointIds },
        tapped: {}
      })
    );
    const one = await volume(
      await tapDrill(sketched.document, {
        points: { sketchId: sketched.sketchId, pointIds: [pointIds[0]!] },
        tapped: {}
      })
    );
    // Two identical tapped bores take twice what one takes.
    expect(40 * 40 * 10 - both).toBeCloseTo(2 * (40 * 40 * 10 - one), 6);
  }, 180_000);

  it('refuses a thread longer than its bore, by the thread generator', async () => {
    const tapped = await tapDrill(plate('mm', 40, 10), {
      depthMode: 'blind',
      depth: 6,
      tapped: { length: 9 }
    });
    expect(failures(await adapter.syncDocument(tapped))).toMatch(
      /runs past an end/
    );
  }, 180_000);
});
