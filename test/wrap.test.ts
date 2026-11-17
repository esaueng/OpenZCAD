import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  normalizeDocument,
  wrapBody,
  type WrapInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import { resolveParamValue, findSketch } from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DerivedState,
  type FaceTopologyReferenceV5,
  type ProjectDocument,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';

/**
 * M12 (schema v111): sketch regions wrapped onto a cylinder, preserving arc
 * length, then embossed or engraved: one body. A region of area A wrapped
 * between radii r1 and r2 about wrap radius R holds A·(r2² − r1²)/(2R), so
 * every volume here has a closed form.
 */

const user = toUserId('user_wrap');
const R = 10;
const POST = Math.PI * R * R * 20;

/** A radius-10 post, 20 tall, on Z. */
function post() {
  const document = addPrimitiveFeature(createProjectDocument('Post', user), {
    name: 'Post',
    primitiveKind: 'cylinder',
    dimensions: { radius: R, height: 20 }
  });
  return { document, bodyId: document.bodyOrder.at(-1)! };
}

/** A sketch on the plane x = 10 (tangent to the post), and its regions. */
function label(
  document: ProjectDocument,
  objects: SketchObjectData[],
  plane: 'YZ' | 'XY' = 'YZ',
  offset = R
) {
  const sketch = addSketchFeature(document, {
    name: 'Label',
    plane,
    offset,
    objects
  });
  const node = findSketch(sketch.document, sketch.sketchId)!;
  const analysis = computeSketchProfileAnalysis(
    node.objectIds.map((id) => {
      const object = sketch.document.nodes[id];
      if (object?.kind !== 'sketch-object') throw new Error('Expected an object.');
      return { id, data: object.data };
    }),
    (value) => resolveParamValue(value, {}, 'dimension')
  );
  const profiles: SketchProfileReference[] = analysis.profiles.map((p) => ({
    profileId: p.profileId,
    regionFingerprint: p.regionFingerprint,
    samplePoint: p.samplePoint,
    sourceArea: p.area,
    sourceEntityIds: p.sourceEntityIds
  }));
  return { document: sketch.document, sketchId: sketch.sketchId, profiles };
}

function sideReference(
  derived: DerivedState,
  bodyId: BodyId
): FaceTopologyReferenceV5 {
  const side = derived.bodyRepresentations[bodyId]?.topology?.faces.find(
    (face) => face.geometry?.surfaceType === 'cylinder'
  );
  expect(side?.reference).toBeDefined();
  return side!.reference!;
}

const rectangle: SketchObjectData = {
  objectKind: 'rectangle',
  width: 6,
  height: 4,
  centerX: 0,
  centerY: 10
};

describe('wraps in the document (v111)', () => {
  it('refuses a wrap in a document of an older schema', () => {
    const start = post();
    const sketch = label(start.document, [rectangle]);
    const wrapped = wrapBody(sketch.document, {
      name: 'Badge',
      targetBodyId: start.bodyId,
      faceReference: {
        kind: 'face',
        producingFeatureId: start.document.featureOrder[0]!,
        lineageName: 'face:side',
        currentHash: 1,
        witnessVersion: 1,
        witness: {
          surfaceType: 'cylinder',
          perimeter: 1,
          centroid: null,
          analytic: { kind: 'none' },
          closure: { u: 'closed', v: 'open' }
        }
      },
      sketchId: sketch.sketchId,
      profiles: sketch.profiles,
      depth: 1,
      mode: 'emboss'
    });
    expect(wrapped.document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    type Version = typeof PROJECT_DOCUMENT_SCHEMA_VERSION;
    const older = { ...wrapped.document, schemaVersion: 110 as Version };
    expect(() => normalizeDocument(structuredClone(older))).toThrow(
      /Wraps require project schema v111/
    );
  });
});

describe('wraps in the exact build', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  async function wrapped(
    objects: SketchObjectData[],
    options: Partial<WrapInput> & Pick<WrapInput, 'mode' | 'depth'>,
    plane?: 'YZ' | 'XY'
  ) {
    const start = post();
    const first = await adapter.syncDocument(start.document);
    const sketch = label(start.document, objects, plane, plane === 'XY' ? 5 : R);
    const result = wrapBody(sketch.document, {
      name: 'Badge',
      targetBodyId: start.bodyId,
      faceReference: sideReference(first, start.bodyId),
      sketchId: sketch.sketchId,
      profiles: sketch.profiles,
      ...options
    });
    const derived = await adapter.syncDocument(result.document);
    return { derived, body: derived.bodyRepresentations[result.bodyId] };
  }

  it('embosses a rectangle onto the post as one body, at its closed-form volume', async () => {
    const { derived, body } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1
    });
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(POST + (24 * (11 ** 2 - 10 ** 2)) / 20, 6);
    // It stands where it was drawn: beyond x = 10, within y ±3.
    expect(body?.bbox.max.x).toBeCloseTo(11 * Math.cos(0), 3);
  });

  it('engraves a disc into the post, the curved walls certified', async () => {
    const { derived, body } = await wrapped(
      [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 10 }],
      { mode: 'engrave', depth: 1 }
    );
    expect(derived.warnings).toEqual([]);
    const removed = (4 * Math.PI * (10 ** 2 - 9 ** 2)) / 20;
    // The body's volume is read by the kernel's face integrator, which
    // chords a curved trim boundary (here 4e-4 high, 6e-8 of the body);
    // the solid itself matches the closed form to 1e-10 in Remus's exact
    // mass properties.
    expect(Math.abs(body!.volume - (POST - removed))).toBeLessThan(2e-3);
  });

  it('turns a wrap about the axis and slides it along', async () => {
    const { derived, body } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1,
      rotationDeg: 90,
      axialOffset: 3
    });
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(POST + (24 * 21) / 20, 6);
    // Turned a quarter: it stands out along +Y now, and 3 higher.
    expect(body?.bbox.max.y).toBeCloseTo(11, 3);
    expect(body?.bbox.max.x).toBeCloseTo(R, 3);
  });

  it('refuses a sketch that is not parallel to the axis, by name', async () => {
    const { derived } = await wrapped(
      [{ objectKind: 'rectangle', width: 2, height: 2, centerX: 0, centerY: 0 }],
      { mode: 'emboss', depth: 1 },
      'XY'
    );
    expect(derived.warnings.join('\n')).toMatch(
      /needs its sketch in a plane parallel to the cylinder's axis/
    );
  });
  it('embosses and engraves a label on a cone through its development, one body each', async () => {
    // A frustum: radius 10 at z = 0 to 5 at z = 20, so its apex is at z = 40
    // and its generators stand atan(40 / 10) from the radial plane.
    const start = (() => {
      const document = addPrimitiveFeature(createProjectDocument('Cup', user), {
        name: 'Cup',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 5, height: 20 }
      });
      return { document, bodyId: document.bodyOrder.at(-1)! };
    })();
    const first = await adapter.syncDocument(start.document);
    const side = first.bodyRepresentations[start.bodyId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cone'
    );
    expect(side?.reference).toBeDefined();
    const frustum = first.bodyRepresentations[start.bodyId]!.volume;
    const beta = Math.atan2(40, 10);
    const rho0 = 40 / Math.sin(beta);
    // The label, 6 × 4, drawn 8..12 up the plane x = 7.5; the axis runs
    // down from the apex, so its developed height is ρ₀ − z.
    const sketch = label(start.document, [rectangle], 'YZ', 7.5);
    // dV = (1 + d·tan β / ρ) dA dd over the developed rectangle.
    let inverse = 0;
    const n = 400;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const s = -3 + (6 * (i + 0.5)) / n;
        const y = rho0 - 12 + (4 * (j + 0.5)) / n;
        inverse += 1 / Math.hypot(s, y);
      }
    }
    inverse *= (6 / n) * (4 / n);
    const added = 24 + (Math.tan(beta) / 2) * inverse;
    const removed = 24 - (Math.tan(beta) / 2) * inverse;
    for (const [mode, change] of [
      ['emboss', added],
      ['engrave', -removed]
    ] as const) {
      const result = wrapBody(sketch.document, {
        name: 'Badge',
        targetBodyId: start.bodyId,
        faceReference: side!.reference!,
        sketchId: sketch.sketchId,
        profiles: sketch.profiles,
        depth: 1,
        mode
      });
      const derived = await adapter.syncDocument(result.document);
      expect(derived.warnings).toEqual([]);
      const live = result.document.bodyOrder.filter(
        (id) => derived.bodyRepresentations[id] && !derived.bodyRepresentations[id].consumed
      );
      expect(live).toEqual([result.bodyId]);
      const body = derived.bodyRepresentations[result.bodyId]!;
      const cones = body.topology!.faces.filter(
        (face) => face.geometry?.surfaceType === 'cone'
      );
      expect(cones.length).toBeGreaterThanOrEqual(2);
      // Within the face integrator's chording of a curved trim on a cone.
      expect(Math.abs(body.volume - (frustum + change))).toBeLessThan(
        2e-3 * Math.abs(change)
      );
    }
  });
});
