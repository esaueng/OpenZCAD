import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  filletEdges,
  threadBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { refusal } from './support/combination-matrix';

/**
 * K10, real kernel coverage for remus#2017 (first shipped in Remus
 * 2026.1.173): a planar block top whose bounding box covers a threaded bore
 * moves up. The kernel's swept-region check compared boxes, the thread's
 * NURBS flanks had no radial proof, and the move was refused with "swept face
 * reaches nonadjacent face … before completing the move" at every distance.
 *
 * The part is upstream's regression rebuilt through OpenZCAD's own document
 * commands and the production adapter on the installed WASM: an R40 boss
 * 60 tall about the z axis through the corner of a 74 × 67 × 35.5 block, the
 * boss/block perimeter rounded R2 (five edges), a blind R11.6 bore about
 * (3, 2) from the boss cap down to z = 20, threaded internally M24 × 1.5.
 * The block top is then moved by Offset Face, the operation the viewport's
 * planar face handle commits (`planFaceOffset`'s direct edit).
 *
 * `apps/web/src/lib/interaction/planarFaceTravel.test.ts` covers only the
 * refusal wording on a display-mesh stand-in; this file is the kernel check.
 */

const user = toUserId('user_k10_threaded_bore');
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

const W = 74;
const D = 67;
const H = 35.5;
const R = 40;
const ROUND = 2;
const BORE = 11.6;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

/** Builds `document`; fails on any refusal or an open or inexact body. */
async function built(document: ProjectDocument, label: string) {
  const derived = await adapter.syncDocument(document);
  const refused = refusal(derived, label);
  expect(refused?.evidence, `${label}: expected built`).toBeUndefined();
  // The R2 round's corner blends are NURBS fits, disclosed as advisory.
  const advice = new Set(
    (derived.featureWarnings ?? [])
      .filter((warning) => warning.kind === 'advisory')
      .map((warning) => warning.message)
  );
  expect(
    derived.warnings.filter(
      (warning) => ![...advice].some((message) => warning.includes(message))
    ),
    label
  ).toEqual([]);
  const body = derived.bodyRepresentations[last(document)];
  expect(body, `${label}: body`).toBeDefined();
  expect(body!.exportableStep, `${label}: exact`).toBe(true);
  expect(
    isClosedConsistentlyOrientedMesh(
      inspectTriangleMeshClosure(body!.mesh.vertices, body!.mesh.indices)
    ),
    `${label}: closed`
  ).toBe(true);
  return { derived, body: body! };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const topology = (derived: DerivedState, id: BodyId) =>
  derived.bodyRepresentations[id]!.topology!;

/** The upward planar face at height `z`. */
function upFace(derived: DerivedState, id: BodyId, z: number): FaceTopology {
  const faces = topology(derived, id).faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 1 - 1e-9 &&
      near(face.geometry.center.z, z)
  );
  expect(faces, `up face at z = ${z}`).toHaveLength(1);
  return faces[0]!;
}

type Point = { x: number; y: number; z: number };
/** An edge's display samples; `points` is a flat x, y, z array. */
function samples(edge: EdgeTopology): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 2 < edge.points.length; i += 3) {
    out.push({
      x: edge.points[i]!,
      y: edge.points[i + 1]!,
      z: edge.points[i + 2]!
    });
  }
  return out;
}

/**
 * Upstream's five perimeter edges: the junction arc on the block top, the
 * block top's edges along the two walls the boss crosses, and the two
 * vertical seams of boss and block.
 */
function perimeter(derived: DerivedState, id: BodyId): EdgeTopology[] {
  return topology(derived, id).edges.filter((edge) => {
    if (edge.displayRole === 'seam') return false;
    const points = samples(edge);
    if (points.length < 2) return false;
    const rise = Math.abs(points[0]!.z - points.at(-1)!.z);
    const all = (test: (p: Point) => boolean) => points.every(test);
    const top = all((p) => near(p.z, H));
    switch (edge.curve?.type) {
      case 'CIRCLE':
        return top;
      case 'LINE':
        return (
          (top && (all((p) => near(p.x, 0)) || all((p) => near(p.y, 0)))) ||
          (rise > H - 0.01 &&
            ((all((p) => near(p.x, R)) && all((p) => near(p.y, 0))) ||
              (all((p) => near(p.y, R)) && all((p) => near(p.x, 0)))))
        );
      default:
        return false;
    }
  });
}

/**
 * The section of an R`r` round in the right-angled concave corner between a
 * wall plane through the centre of an R`big` boss and the boss: by Green's
 * theorem along the wall, the boss arc and the round (upstream's formula).
 */
function seamRoundArea(big: number, r: number): number {
  const cx = Math.sqrt((big + r) ** 2 - r * r);
  const cy = r;
  const bossArc = 0.5 * big * big * Math.atan2(cy, cx);
  const a = Math.atan2(-cy, -cx);
  const b = -Math.PI / 2;
  const roundArc =
    0.5 *
    (r * r * (b - a) +
      r *
        (cx * (Math.sin(b) - Math.sin(a)) - cy * (Math.cos(b) - Math.cos(a))));
  return Math.abs(bossArc + roundArc);
}

/** The block top rises with the move, and the two seam rounds stretch. */
const ROOF = W * D - (Math.PI * R * R) / 4 + 2 * seamRoundArea(R, ROUND);

async function threadedPart() {
  let document = addPrimitiveFeature(
    createProjectDocument('K10 threaded bore', user),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: W, height: D, depth: H }
    }
  );
  const block = last(document);
  document = addPrimitiveFeature(document, {
    name: 'Boss',
    primitiveKind: 'cylinder',
    dimensions: { radius: R, height: 60 }
  });
  const boss = last(document);
  document = booleanBodies(document, {
    name: 'Fuse',
    operation: 'union',
    targetBodyIds: [block, boss]
  }).document;
  const fused = await built(document, 'fuse');

  const edges = perimeter(fused.derived, last(document));
  expect(edges, 'perimeter edges').toHaveLength(5);
  document = filletEdges(document, {
    name: 'Round',
    targetBodyId: last(document),
    edgeHashes: edges.map((edge) => edge.hash),
    ...(edges.every((edge) => edge.reference)
      ? { edgeReferences: edges.map((edge) => edge.reference!) }
      : {}),
    size: ROUND
  }).document;
  await built(document, 'round');
  const rounded = last(document);

  document = addPrimitiveFeature(document, {
    name: 'Bore tool',
    primitiveKind: 'cylinder',
    dimensions: { radius: BORE, height: 44 }
  });
  document = transformBody(document, {
    name: 'Place bore tool',
    targetBodyId: last(document),
    translation: { x: 3, y: 2, z: 20 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  document = booleanBodies(document, {
    name: 'Bore',
    operation: 'subtract',
    targetBodyIds: [rounded, last(document)]
  }).document;
  const bored = await built(document, 'bore');

  const wall = bored.body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      near(face.geometry.radius ?? 0, BORE)
  );
  expect(wall, 'bore wall').toHaveLength(1);
  document = threadBody(document, {
    name: 'Thread',
    targetBodyId: last(document),
    faceHash: wall[0]!.hash,
    ...(wall[0]!.reference ? { faceReference: wall[0]!.reference } : {}),
    profile: 'iso-metric',
    majorDiameter: 24,
    pitch: 1.5
  }).document;
  const threaded = await built(document, 'thread');
  return { document, ...threaded };
}

describe('K10: a block top moved beside a threaded bore (remus#2017)', () => {
  it('builds the upstream part with a modeled thread', async () => {
    const { body, derived, document } = await threadedPart();
    const freeform = body.topology!.faces.filter(
      (face) =>
        !['plane', 'cylinder', 'cone', 'sphere', 'torus'].includes(
          face.geometry?.surfaceType ?? ''
        )
    );
    expect(freeform.length, 'thread flank faces').toBeGreaterThan(50);
    // The block top's box reaches over the bore's footprint: the case the
    // kernel's box-only sweep check refused.
    const top = upFace(derived, last(document), H);
    const xs = topology(derived, last(document)).edges.filter((edge) =>
      (edge.adjacentFaceHashes ?? []).includes(top.hash)
    );
    const corners = xs.flatMap(samples);
    expect(corners.some((p) => p.x < 3 + BORE)).toBe(true);
    expect(corners.some((p) => p.y < 2 + BORE)).toBe(true);
  }, 120_000);

  it.each([1, 10])(
    'moves the block top up %d mm: closed, exact, roof × distance',
    async (distance) => {
      const { document, derived, body } = await threadedPart();
      const id = last(document);
      const top = upFace(derived, id, H);
      const geometry = top.geometry!;
      const moved = directEditBody(document, {
        name: 'Offset Face',
        targetBodyId: id,
        operation: {
          kind: 'offset-face',
          faceHash: top.hash,
          ...(top.reference ? { faceReference: top.reference } : {}),
          sourceSurfaceType: 'plane',
          sourceArea: geometry.area,
          sourceCenter: geometry.center,
          sourceNormal: geometry.normal!,
          offset: distance
        }
      }).document;
      const after = await built(moved, `+${distance} mm`);
      expect(after.body.faceCount).toBe(body.faceCount);
      // Closed form: the roof's section times the distance.
      expect(
        Math.abs(after.body.volume - body.volume - ROOF * distance),
        `volume grew by ${after.body.volume - body.volume}`
      ).toBeLessThan(1e-9 * body.volume);
      upFace(after.derived, last(moved), H + distance);
    },
    120_000
  );
});
