import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { measureAreaProvenance } from '../packages/kernel-adapter/src/exact-measure';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * Whether each published face area is exact, decided per face rather than per
 * kernel call.
 *
 * `kernel.faceArea` takes a deflection parameter, which reads as "approximate
 * everywhere" and led this app to grade every face area the same way an
 * approximate one deserves. Measured against closed forms, most of them are
 * exact — and the one class that is not cannot be improved by the deflection
 * at all, because its boundary is inscribed with a fixed point count.
 *
 * The verdict now travels with the geometry so the measurement workbench can
 * stop under-claiming for the exact ones without ever over-claiming for the
 * rest.
 *
 * The sampled class shrunk once: planar faces bounded by lines, circles or
 * parabolas moved from the 256-point inscribed polygon to an exact
 * Green's-theorem boundary integral (Remus 2.130). What remains sampled is
 * the boundary the integrator does not cover — ellipse, hyperbola, NURBS.
 */

let adapter: ExactKernelAdapter | null = null;

afterAll(() => {
  adapter?.dispose();
  adapter = null;
});

async function bodyOf(document: ProjectDocument): Promise<BodyRepresentation> {
  adapter ??= await createExactKernelAdapter();
  const derived = await adapter.syncDocument(document);
  const body = derived.bodyRepresentations[document.bodyOrder.at(-1)!];
  if (!body) {
    throw new Error('The document produced no body.');
  }
  return body;
}

function primitive(
  primitiveKind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus',
  dimensions: Record<string, number>
): ProjectDocument {
  let doc = createProjectDocument('P', toUserId('user_area'));
  doc = addPrimitiveFeature(doc, {
    name: primitiveKind,
    primitiveKind,
    dimensions
  });
  return doc;
}

function facesOf(body: BodyRepresentation, surfaceType: string) {
  return (body.topology?.faces ?? []).filter(
    (face) => face.geometry?.surfaceType === surfaceType
  );
}

describe('a planar face bounded by straight edges', () => {
  it('is exact, and says so', async () => {
    const body = await bodyOf(
      primitive('box', { width: 20, depth: 20, height: 20 })
    );
    const planes = facesOf(body, 'plane');
    expect(planes).toHaveLength(6);
    for (const face of planes) {
      expect(face.geometry?.areaProvenance).toBe('exact');
      expect(face.geometry?.area).toBe(400);
    }
  }, 120_000);

  it('stays exact when the face is not convex', async () => {
    // An L-shaped face has six straight edges and a reflex corner. Nothing
    // about the area is approximated: measured at exactly 300.
    let doc = primitive('box', { width: 20, depth: 20, height: 20 });
    doc = addPrimitiveFeature(doc, {
      name: 'notch',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 30 }
    });
    const blankId = doc.bodyOrder[0]!;
    const notchId = doc.bodyOrder.at(-1)!;
    doc = transformBody(doc, {
      name: 'Place notch',
      targetBodyId: notchId,
      translation: { x: 10, y: 10, z: -5 }
    }).document;
    doc = booleanBodies(doc, {
      name: 'Notch',
      operation: 'subtract',
      targetBodyIds: [blankId, notchId]
    }).document;

    const body = await bodyOf(doc);
    const lShaped = facesOf(body, 'plane').filter(
      (face) => Math.abs((face.geometry?.area ?? 0) - 300) < 1e-9
    );
    expect(lShaped.length).toBeGreaterThan(0);
    for (const face of lShaped) {
      expect(face.geometry?.areaProvenance).toBe('exact');
    }
  }, 180_000);
});

describe('a planar face bounded by a curve', () => {
  it('is exact when the curve is the outer boundary', async () => {
    // A cylinder's disc cap: one circular edge, integrated exactly by
    // Green's theorem over the boundary rather than inscribed as a polygon.
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    const caps = facesOf(body, 'plane');
    expect(caps).toHaveLength(2);
    for (const cap of caps) {
      expect(cap.geometry?.areaProvenance).toBe('exact');
      const error =
        ((cap.geometry?.area ?? 0) - Math.PI * 100) / (Math.PI * 100);
      expect(Math.abs(error)).toBeLessThan(1e-12);
    }
  }, 120_000);

  it('is exact when the curve is a hole', async () => {
    // A box's vertical extent is `depth`, while a cylinder's is `height` —
    // a genuine asymmetry in this schema, and getting it backwards silently
    // produces a 40 mm block that the bore never passes through.
    let doc = primitive('box', { width: 40, height: 40, depth: 10 });
    doc = addPrimitiveFeature(doc, {
      name: 'bore',
      primitiveKind: 'cylinder',
      dimensions: { radius: 5, height: 30 }
    });
    const plateId = doc.bodyOrder[0]!;
    const boreId = doc.bodyOrder.at(-1)!;
    doc = transformBody(doc, {
      name: 'Place bore',
      targetBodyId: boreId,
      translation: { x: 20, y: 20, z: -10 }
    }).document;
    doc = booleanBodies(doc, {
      name: 'Bore',
      operation: 'subtract',
      targetBodyIds: [plateId, boreId]
    }).document;

    const body = await bodyOf(doc);
    const exact = 40 * 40 - Math.PI * 25;
    const bored = facesOf(body, 'plane').filter(
      (face) => Math.abs((face.geometry?.area ?? 0) - exact) < 1
    );
    expect(bored.length).toBeGreaterThan(0);
    for (const face of bored) {
      expect(face.geometry?.areaProvenance).toBe('exact');
      expect(Math.abs((face.geometry!.area - exact) / exact)).toBeLessThan(
        1e-12
      );
    }
  }, 180_000);

  it('is sampled when the boundary is an ellipse', () => {
    // The exact integrator covers lines, circles and parabolas. An ellipse
    // keeps the fixed 256-point inscribed polygon, so its area must keep
    // the sampled grade — under-claiming here is the safe direction.
    const kernel = new RemusKernel();
    try {
      const scaled = kernel.copyAndTransformSolid(
        kernel.makeCylinder(10, 20),
        new Float64Array([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
      );
      const cap = Array.from(kernel.getSolidFaces(scaled)).find(
        (face) => kernel.getSurfaceType(face) === 'plane'
      )!;
      expect(
        Array.from(kernel.getFaceEdges(cap)).map((edge) =>
          kernel.getEdgeCurveType(edge)
        )
      ).toContain('ELLIPSE');
      expect(measureAreaProvenance(kernel, cap, 'plane')).toBe('sampled');
    } finally {
      kernel.free();
    }
  }, 120_000);

  it('is sampled when a circular boundary is stored as NURBS', () => {
    // getEdgeCurveType reports the analytic curve a NURBS edge represents,
    // but the kernel's exact integrator only runs on concrete curves — a
    // NURBS circle still takes the sampled path, so the provenance must not
    // upgrade on the detected type alone.
    const kernel = new RemusKernel();
    try {
      const converted = kernel.makeCylinder(10, 20);
      kernel.convertToBspline(converted);
      const cap = Array.from(kernel.getSolidFaces(converted)).find(
        (face) => kernel.getSurfaceType(face) === 'plane'
      )!;
      expect(measureAreaProvenance(kernel, cap, 'plane')).toBe('sampled');
    } finally {
      kernel.free();
    }
  }, 120_000);
});

describe('analytic curved surfaces', () => {
  it('are exact for every class the primitives can produce', async () => {
    const cases: {
      kind: 'cylinder' | 'sphere' | 'cone' | 'torus';
      dimensions: Record<string, number>;
      surfaceType: string;
    }[] = [
      {
        kind: 'cylinder',
        dimensions: { radius: 10, height: 20 },
        surfaceType: 'cylinder'
      },
      { kind: 'sphere', dimensions: { radius: 10 }, surfaceType: 'sphere' },
      {
        kind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 5, height: 20 },
        surfaceType: 'cone'
      },
      {
        kind: 'torus',
        dimensions: { majorRadius: 20, minorRadius: 5 },
        surfaceType: 'torus'
      }
    ];
    for (const entry of cases) {
      const body = await bodyOf(primitive(entry.kind, entry.dimensions));
      const curved = facesOf(body, entry.surfaceType);
      expect(
        curved.length,
        `${entry.kind} produced no ${entry.surfaceType} face`
      ).toBeGreaterThan(0);
      for (const face of curved) {
        expect(
          face.geometry?.areaProvenance,
          `${entry.kind} ${entry.surfaceType}`
        ).toBe('exact');
      }
    }
  }, 300_000);
});

describe('the guard on the whole change', () => {
  it('leaves every face hash and centre byte-identical', async () => {
    // `FaceGeometry.center` is an ADR-011 witness input and a direct-edit
    // authorization pin. Publishing a sibling field beside it must not
    // perturb either, or documents that already open would start refusing
    // their own edits. This is the test that says the change is additive.
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    const faces = body.topology?.faces ?? [];
    expect(faces).toHaveLength(3);

    // Pinned literals rather than a self-comparison: a snapshot taken from
    // the same run would agree with itself no matter what changed. These
    // three were read from a build WITHOUT the change and a build WITH it,
    // and matched.
    expect(faces.map((face) => face.hash).sort((a, b) => a - b)).toEqual([
      1680569894, 3051632463, 3725660776
    ]);
    // Every centre too, since `center` is the witness input that would move
    // if the face traversal order or the vertex set were disturbed.
    expect(faces.map((face) => face.geometry?.center)).toEqual([
      { x: 10, y: 0, z: 10 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 20 }
    ]);
    // And the volume, which is separately pinned bit-exact elsewhere.
    expect(body.volume).toBe(Math.PI * 100 * 20);
  }, 120_000);
});

describe('the plane equation', () => {
  it('completes n·x = d for every planar face, exactly', async () => {
    // Free to compute and exact: `center` is the mean of the face's vertices,
    // all of which lie on the plane. Checked against the geometry rather than
    // against itself — a 20 mm box corner-at-origin has planes at 0 and 20.
    const body = await bodyOf(
      primitive('box', { width: 20, height: 20, depth: 20 })
    );
    const offsets = facesOf(body, 'plane')
      // `+ 0` normalises negative zero, which the three faces through the
      // origin can produce depending on which way their normal points. It is
      // a float artifact, not a fact about the geometry, and pinning it would
      // make this test about IEEE 754 rather than about the plane equation.
      .map((face) => (face.geometry?.planeOffset ?? Number.NaN) + 0)
      .sort((a, b) => a - b);
    expect(offsets).toEqual([0, 0, 0, 20, 20, 20]);

    // And it really is the plane equation: every face's own centre satisfies
    // it, which a constant or a copied field would not.
    for (const face of facesOf(body, 'plane')) {
      const { normal, center, planeOffset } = face.geometry!;
      expect(
        normal!.x * center.x + normal!.y * center.y + normal!.z * center.z
      ).toBeCloseTo(planeOffset!, 12);
    }
  }, 120_000);

  it('is absent wherever the normal is', async () => {
    // The two travel together; a plane offset without a normal would be a
    // half-answer that reads as a plane through the origin.
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    for (const face of body.topology?.faces ?? []) {
      const geometry = face.geometry;
      if (!geometry) continue;
      expect(geometry.planeOffset === undefined).toBe(
        geometry.normal === undefined
      );
    }
  }, 120_000);
});
