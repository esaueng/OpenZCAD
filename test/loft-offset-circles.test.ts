import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyTopology,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { loftFacetingAdvisories } from '../apps/web/src/lib/loftFaceting';
import {
  HEIGHT,
  LOWER_RADIUS,
  OFFSET,
  UPPER_RADIUS,
  circle,
  stackedLoft
} from './fixtures/stacked-loft';

/**
 * OpenZCAD #1253: two parallel circles whose centres are laterally offset
 * (r = 25 at the origin, r = 10 at (12, 0, 60)) lofted, in Ruled and Smooth
 * alike, into 32 planar side facets plus two caps — 0.64% short of the exact
 * ruled loft and with no disclosure — while the coaxial control came back as
 * one cone. Remus 2026.1.135 lofts the offset pair as one exact rational
 * ruled band (straight generators joining equal rim angles) between two
 * exact full-turn circle rims. These cases pin that through the app's Loft
 * feature path: preview, commit, reload and a STEP round trip. Section stacks
 * the pinned kernel still rebuilds from chords are disclosed before commit
 * (`apps/web/src/lib/loftFaceting.ts`), as faceted sweeps are.
 */
const user = toUserId('user_offset_loft');

/**
 * The exact ruled loft: every horizontal slice at t ∈ [0, 1] is a circle of
 * radius r(t) = 25 − 15t centred at (12t, 0, 60t). Cavalieri's principle
 * makes the volume independent of the lateral shift, so it is the coaxial
 * frustum's πh(R² + Rr + r²)/3 = 61,261.0567 mm³. The centroid integrates
 * r(t)² against the slice centre; both integrals are closed-form.
 */
const EXACT_VOLUME =
  (Math.PI *
    HEIGHT *
    (LOWER_RADIUS ** 2 + LOWER_RADIUS * UPPER_RADIUS + UPPER_RADIUS ** 2)) /
  3;
function exactCentroid(offset: number) {
  // ∫ r² dt and ∫ t r² dt with r = R + (r − R) t, over t ∈ [0, 1].
  const d = UPPER_RADIUS - LOWER_RADIUS;
  const area = LOWER_RADIUS ** 2 + LOWER_RADIUS * d + d ** 2 / 3;
  const moment =
    LOWER_RADIUS ** 2 / 2 + (2 * LOWER_RADIUS * d) / 3 + d ** 2 / 4;
  const t = moment / area;
  return { x: offset * t, y: 0, z: HEIGHT * t };
}

function circleLoft(mode: 'ruled' | 'smooth', offset: number) {
  return stackedLoft(mode, [
    circle(LOWER_RADIUS),
    circle(UPPER_RADIUS, offset)
  ]);
}

/** Face surface types, sorted, as the app's topology reports them. */
function surfaceTypes(topology: BodyTopology | undefined): string[] {
  return topology!.faces.map((face) => face.geometry?.surfaceType ?? '').sort();
}

/**
 * The body's two section boundaries: every feature edge must be one exact
 * circle (the kernel's curve record, not the display polyline) at the drawn
 * centre, normal to Z, with the drawn radius and circumference.
 */
function expectCircularSectionBoundaries(
  topology: BodyTopology | undefined,
  offset: number
) {
  const rims = topology!.edges
    .filter((edge) => edge.displayRole !== 'seam')
    .map((edge) => {
      expect(edge.curve?.type).toBe('CIRCLE');
      const circle = edge.curve?.circle;
      if (!circle) throw new Error('Expected an exact circle rim.');
      // One closed edge: it starts and ends on the same vertex.
      expect(new Set(edge.vertexIds).size).toBe(1);
      return { ...circle, length: edge.length };
    })
    .sort((left, right) => left.center.z - right.center.z);
  expect(rims).toHaveLength(2);
  const expected = [
    { center: { x: 0, y: 0, z: 0 }, radius: LOWER_RADIUS },
    { center: { x: offset, y: 0, z: HEIGHT }, radius: UPPER_RADIUS }
  ];
  rims.forEach((rim, index) => {
    const want = expected[index]!;
    expect(rim.center.x).toBeCloseTo(want.center.x, 6);
    expect(rim.center.y).toBeCloseTo(want.center.y, 6);
    expect(rim.center.z).toBeCloseTo(want.center.z, 6);
    expect(Math.abs(rim.axis.z)).toBeCloseTo(1, 9);
    expect(rim.radius).toBeCloseTo(want.radius, 6);
    expect(rim.length).toBeCloseTo(2 * Math.PI * want.radius, 6);
  });
}

describe(
  'loft between laterally offset circles (#1253)',
  { timeout: 60_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => adapter.dispose());

    /**
     * The exact solid the adapter hands the STEP translator, measured by the
     * kernel's own mass properties (not the display tessellation) and its face
     * carriers, alongside the STEP text itself.
     */
    async function exportedSolid(document: ProjectDocument, bodyId: BodyId) {
      const serialize = vi.spyOn(RemusKernel.prototype, 'serializeSolids');
      let step: string;
      let arena: Uint8Array;
      try {
        step = await adapter.exportStep(document, [bodyId]);
        expect(serialize).toHaveBeenCalledTimes(1);
        const result = serialize.mock.results[0];
        if (result?.type !== 'return') throw new Error('No body serialized.');
        arena = new Uint8Array(result.value);
      } finally {
        serialize.mockRestore();
      }
      const kernel = new RemusKernel();
      try {
        const [solid] = kernel.deserializeSolids(arena);
        expect(kernel.validateSolid(solid!)).toBe(0);
        const faces = Array.from(kernel.getSolidFaces(solid!));
        const mass = JSON.parse(kernel.massProperties(solid!) as string) as {
          volume: number;
          centerOfMass: [number, number, number];
        };
        return {
          step,
          surfaces: faces.map((face) => kernel.getSurfaceType(face)).sort(),
          volume: mass.volume,
          centerOfMass: mass.centerOfMass
        };
      } finally {
        kernel.free();
      }
    }

    const cases = [
      // The issue: one exact ruled B-spline band between two circle rims.
      { mode: 'ruled', offset: OFFSET, wall: 'bspline' },
      { mode: 'smooth', offset: OFFSET, wall: 'bspline' },
      // The coaxial control stays one exact cone.
      { mode: 'ruled', offset: 0, wall: 'cone' },
      { mode: 'smooth', offset: 0, wall: 'cone' }
    ] as const;

    it.each(cases)(
      '$mode loft with the top circle shifted $offset mm keeps one curved $wall wall and both circular rims',
      async ({ mode, offset, wall }) => {
        const lofted = circleLoft(mode, offset);
        const expectedSurfaces = ['plane', 'plane', wall].sort();

        // Preview: the geometry the Loft tool shows before commit.
        const preview = await adapter.previewGeometry(lofted.document);
        expect(preview.warnings).toEqual([]);
        const shown = preview.bodyRepresentations[lofted.bodyId]!;
        expect(shown.source).toBe('loft');
        expect(surfaceTypes(shown.topology)).toEqual(expectedSurfaces);
        expectCircularSectionBoundaries(shown.topology, offset);

        // Commit.
        const derived = await adapter.syncDocument(lofted.document);
        expect(derived.warnings).toEqual([]);
        expect(derived.featureWarnings ?? []).toEqual([]);
        const body = derived.bodyRepresentations[lofted.bodyId]!;
        expect(body.faceCount).toBe(3);
        expect(body.exportableStep).toBe(true);
        expect(surfaceTypes(body.topology)).toEqual(expectedSurfaces);
        expectCircularSectionBoundaries(body.topology, offset);
        // Exact, so nothing to disclose in preview or after commit.
        expect(
          loftFacetingAdvisories(lofted.document, preview.bodyRepresentations)
        ).toEqual([]);
        expect(loftFacetingAdvisories({ ...lofted.document, derived })).toEqual(
          []
        );
        // `volume` integrates the display tessellation (0.08 mm deflection), an
        // approximation of the exact B-rep, so it is held to 0.1% here; the
        // exact figure is the kernel mass integral below. The faceted body the
        // issue measured was 0.64% short, which this bound excludes.
        expect(
          Math.abs(body.volume - EXACT_VOLUME) / EXACT_VOLUME
        ).toBeLessThan(1e-3);

        // The exact solid behind the body: carriers and mass integral.
        const exact = await exportedSolid(lofted.document, lofted.bodyId);
        expect(exact.surfaces).toEqual(expectedSurfaces);
        expect(
          Math.abs(exact.volume - EXACT_VOLUME) / EXACT_VOLUME
        ).toBeLessThan(1e-9);
        const centroid = exactCentroid(offset);
        expect(exact.centerOfMass[0]).toBeCloseTo(centroid.x, 6);
        expect(exact.centerOfMass[1]).toBeCloseTo(centroid.y, 6);
        expect(exact.centerOfMass[2]).toBeCloseTo(centroid.z, 6);

        // Reload: the saved document replayed by a fresh adapter.
        const saved = JSON.parse(
          JSON.stringify(lofted.document)
        ) as ProjectDocument;
        const reloadAdapter = await createExactKernelAdapter();
        try {
          const reloaded = await reloadAdapter.syncDocument(saved);
          expect(reloaded.warnings).toEqual([]);
          const again = reloaded.bodyRepresentations[lofted.bodyId]!;
          expect(surfaceTypes(again.topology)).toEqual(expectedSurfaces);
          expectCircularSectionBoundaries(again.topology, offset);
          expect(again.volume).toBeCloseTo(body.volume, 6);
        } finally {
          reloadAdapter.dispose();
        }

        // STEP round trip: the exported file imports as the same exact solid.
        const imported = importStepBody(
          createProjectDocument('Round trip', user),
          {
            name: 'Loft',
            artifactId: `loft-${mode}-${offset}`,
            sourceName: 'loft.step',
            stepText: exact.step
          }
        );
        const rebuilt = await adapter.syncDocument(imported.document);
        expect(rebuilt.warnings).toEqual([]);
        const importedBody = rebuilt.bodyRepresentations[imported.bodyId]!;
        expect(importedBody.faceCount).toBe(3);
        expect(surfaceTypes(importedBody.topology)).toEqual(expectedSurfaces);
        expectCircularSectionBoundaries(importedBody.topology, offset);
        const roundTrip = await exportedSolid(
          imported.document,
          imported.bodyId
        );
        expect(roundTrip.surfaces).toEqual(expectedSurfaces);
        expect(
          Math.abs(roundTrip.volume - EXACT_VOLUME) / EXACT_VOLUME
        ).toBeLessThan(1e-6);
      }
    );
    it('keeps every circle of a Ruled three-circle stack exact, offset or coaxial', async () => {
      for (const offset of [OFFSET, 0]) {
        const lofted = stackedLoft('ruled', [
          circle(LOWER_RADIUS),
          circle(UPPER_RADIUS, offset),
          circle(20)
        ]);
        const derived = await adapter.syncDocument(lofted.document);
        expect(derived.warnings).toEqual([]);
        const topology = derived.bodyRepresentations[lofted.bodyId]!.topology!;
        const rims = topology.edges.filter(
          (edge) => edge.displayRole !== 'seam'
        );
        expect(rims.map((edge) => edge.curve?.type)).toEqual([
          'CIRCLE',
          'CIRCLE',
          'CIRCLE'
        ]);
        expect(loftFacetingAdvisories({ ...lofted.document, derived })).toEqual(
          []
        );
      }
    });

    /**
     * What the pinned kernel still cannot keep exact is disclosed before
     * commit: Smooth through three circles rebuilds each as 32 chords (offset
     * and coaxial alike), and so does a circle lofted to a square in either
     * mode. Geometry is unchanged; Diagnostics says what it is, on the preview
     * the Loft tool shows and on the committed body.
     */
    it.each([
      {
        name: 'Smooth through three offset circles',
        mode: 'smooth',
        objects: [
          circle(LOWER_RADIUS),
          circle(UPPER_RADIUS, OFFSET),
          circle(20)
        ],
        hint: ' Smooth through 3 sections rebuilds circular sections from chords; Ruled keeps these circles exact.'
      },
      {
        name: 'Smooth through three coaxial circles',
        mode: 'smooth',
        objects: [circle(LOWER_RADIUS), circle(UPPER_RADIUS), circle(20)],
        hint: ' Smooth through 3 sections rebuilds circular sections from chords; Ruled keeps these circles exact.'
      },
      {
        name: 'a Ruled circle to square',
        mode: 'ruled',
        objects: [
          circle(10),
          {
            objectKind: 'rectangle',
            width: 16,
            height: 16,
            centerX: 0,
            centerY: 0
          }
        ],
        hint: ''
      }
    ] as const)(
      'discloses $name as chords before commit',
      async ({ mode, objects, hint }) => {
        const lofted = stackedLoft(mode, objects);
        const preview = await adapter.previewGeometry(lofted.document);
        const derived = await adapter.syncDocument(lofted.document);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[lofted.bodyId]!;
        // Unchanged geometry: straight chords, no exact circle left.
        expect(
          body.topology!.edges.some((edge) => edge.curve?.type === 'CIRCLE')
        ).toBe(false);
        const message = `Feature "Loft": This loft is a faceted approximation, not exact curved surfaces: its sections' curved edges become straight chords. Its ${body.faceCount} faces are what its volume, mass and STEP export measure.${hint}`;
        for (const advisories of [
          loftFacetingAdvisories(lofted.document, preview.bodyRepresentations),
          loftFacetingAdvisories({ ...lofted.document, derived })
        ]) {
          expect(advisories).toHaveLength(1);
          expect(advisories[0]).toMatchObject({
            featureName: 'Loft',
            kind: 'advisory',
            message
          });
        }
      }
    );

    it('raises nothing for straight-edged sections, which have no curves to chord', async () => {
      const square = (width: number): SketchObjectData => ({
        objectKind: 'rectangle',
        width,
        height: width,
        centerX: 0,
        centerY: 0
      });
      const lofted = stackedLoft('smooth', [square(20), square(8), square(14)]);
      const derived = await adapter.syncDocument(lofted.document);
      expect(derived.warnings).toEqual([]);
      expect(loftFacetingAdvisories({ ...lofted.document, derived })).toEqual(
        []
      );
    });
  }
);
