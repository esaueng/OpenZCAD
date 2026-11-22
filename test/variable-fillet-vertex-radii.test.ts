import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  filletEdges,
  listNodesByKind,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '../packages/kernel-adapter/src/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  filletVertexRadiiProblem,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FilletVertexRadius,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M03 per-vertex radius controls (schema v151): a variable-radius fillet's
 * radius at each end of each selected edge, named by the end where the edge
 * was picked (its witness endpoint), not by the kernel's edge direction.
 */
const user = toUserId('user_vertex_radii');
const LENGTH = 60;
const BOX = LENGTH * 40 * 20;
const CORNER = 1 - Math.PI / 4;

function boxDocument(): { document: ProjectDocument; bodyId: BodyId } {
  const document = addPrimitiveFeature(createProjectDocument('Box', user), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: LENGTH, height: 40, depth: 20 }
  });
  return { document, bodyId: document.bodyOrder.at(-1) as BodyId };
}

function longEdge(body: BodyRepresentation): EdgeTopology {
  const edge = body.topology!.edges.find(
    (candidate) =>
      candidate.curve?.type === 'LINE' &&
      Math.abs((candidate.length ?? 0) - LENGTH) < 1e-6 &&
      candidate.reference?.witness.closed === false
  );
  if (!edge) throw new Error('Expected a referenced 60 mm edge.');
  return edge;
}

/** Whether the kernel draws `edge` from its witness end 0 to end 1. */
function runOf(edge: EdgeTopology): boolean {
  const points = edge.points;
  const far = points.slice(-3);
  const near = (end: 0 | 1) => {
    const point = witnessEnd(edge, end);
    return Math.hypot(far[0]! - point.x, far[1]! - point.y, far[2]! - point.z);
  };
  return near(1) < near(0);
}

/** The witness end `end` of `edge`, in document units. */
function witnessEnd(edge: EdgeTopology, end: 0 | 1) {
  const witness = edge.reference!.witness;
  if (witness.closed) throw new Error('Expected an open edge.');
  const [x, y, z] = witness.endpoints[end];
  return { x: x * 1e-6, y: y * 1e-6, z: z * 1e-6 };
}

/**
 * How much area the round took off the end cap at `point`: a cap loses
 * (1 − π/4)·r² at the corner the round runs through.
 */
function capDeficit(
  before: BodyRepresentation,
  after: BodyRepresentation,
  point: { x: number; y: number; z: number },
  axis: { x: number; y: number; z: number }
): number {
  const cap = (body: BodyRepresentation) =>
    body.topology!.faces.find((face) => {
      const geometry = face.geometry;
      if (geometry?.surfaceType !== 'plane' || !geometry.normal) return false;
      const along =
        Math.abs(
          geometry.normal.x * axis.x +
            geometry.normal.y * axis.y +
            geometry.normal.z * axis.z
        ) >
        1 - 1e-9;
      const offset =
        (geometry.center.x - point.x) * axis.x +
        (geometry.center.y - point.y) * axis.y +
        (geometry.center.z - point.z) * axis.z;
      return along && Math.abs(offset) < 1e-6;
    })!.geometry!.area;
  return cap(before) - cap(after);
}

async function roundWith(radii: FilletVertexRadius[], edgeIndexOf?: number) {
  const adapter = await createExactKernelAdapter();
  try {
    const { document, bodyId } = boxDocument();
    const built = await adapter.syncDocument(document);
    const before = built.bodyRepresentations[bodyId]!;
    const edge = longEdge(before);
    const rounded = filletEdges(document, {
      name: 'Round',
      targetBodyId: bodyId,
      edgeHashes: [edge.hash],
      edgeReferences: [edge.reference!],
      size: 1,
      endRadius: 1,
      radiusLaw: 'linear',
      vertexRadii: radii.map((entry) => ({
        ...entry,
        edge: edgeIndexOf ?? entry.edge
      })),
      edgeRuns: [runOf(edge)]
    });
    const derived = await adapter.syncDocument(rounded.document);
    return {
      before,
      edge,
      document: rounded.document,
      warnings: (derived.featureWarnings ?? []).filter(
        (warning) => warning.kind !== 'advisory'
      ),
      after: derived.bodyRepresentations[rounded.bodyId]
    };
  } finally {
    adapter.dispose();
  }
}

describe('per-vertex fillet radii (M03, v151)', { timeout: 120_000 }, () => {
  it('rounds each end of the edge at the radius set at that end', async () => {
    for (const [r0, r1] of [
      [1, 3],
      [3, 1]
    ] as const) {
      const { before, edge, after, warnings } = await roundWith([
        { edge: 0, end: 0, radius: r0 },
        { edge: 0, end: 1, radius: r1 }
      ]);
      expect(warnings).toEqual([]);
      // ∫r² of a linear law r0 → r1 over the edge: L·(r0² + r0·r1 + r1²)/3.
      expect(after!.volume).toBeCloseTo(
        BOX - (CORNER * LENGTH * (r0 * r0 + r0 * r1 + r1 * r1)) / 3,
        3
      );
      const w0 = witnessEnd(edge, 0);
      const w1 = witnessEnd(edge, 1);
      const length = Math.hypot(w1.x - w0.x, w1.y - w0.y, w1.z - w0.z);
      const axis = {
        x: (w1.x - w0.x) / length,
        y: (w1.y - w0.y) / length,
        z: (w1.z - w0.z) / length
      };
      expect(capDeficit(before, after!, w0, axis)).toBeCloseTo(
        CORNER * r0 * r0,
        4
      );
      expect(capDeficit(before, after!, w1, axis)).toBeCloseTo(
        CORNER * r1 * r1,
        4
      );
      expect(after!.exportableStep).toBe(true);
    }
  });

  it('keeps the start and end radius at an end with no entry', async () => {
    const { after, warnings } = await roundWith([
      { edge: 0, end: 1, radius: 2 }
    ]);
    expect(warnings).toEqual([]);
    // The kernel start keeps radius 1 or the end keeps endRadius 1: either
    // way the law runs 1 → 2.
    expect(after!.volume).toBeCloseTo(BOX - (CORNER * LENGTH * 7) / 3, 3);
  });

  it('refuses a malformed list at creation and on load, and needs v151', async () => {
    const { document, bodyId } = boxDocument();
    const adapter = await createExactKernelAdapter();
    let edge: EdgeTopology;
    try {
      edge = longEdge(
        (await adapter.syncDocument(document)).bodyRepresentations[bodyId]!
      );
    } finally {
      adapter.dispose();
    }
    const base = {
      name: 'Round',
      targetBodyId: bodyId,
      edgeHashes: [edge.hash],
      edgeReferences: [edge.reference!],
      size: 1,
      endRadius: 2,
      radiusLaw: 'linear' as const,
      edgeRuns: [runOf(edge)]
    };
    for (const [vertexRadii, message] of [
      [[], /non-empty/],
      [[{ edge: 1, end: 0, radius: 1 }], /does not select/],
      [[{ edge: 0, end: 2, radius: 1 }], /end 0 or end 1/],
      [
        [
          { edge: 0, end: 0, radius: 1 },
          { edge: 0, end: 0, radius: 2 }
        ],
        /same edge end twice/
      ],
      [[{ edge: 0, end: 0, radius: Number.NaN }], /number or an expression/]
    ] as const) {
      expect(() =>
        filletEdges(document, {
          ...base,
          vertexRadii: vertexRadii as unknown as FilletVertexRadius[]
        })
      ).toThrow(message);
    }
    expect(() =>
      filletEdges(document, {
        ...base,
        edgeReferences: [],
        vertexRadii: [{ edge: 0, end: 0, radius: 1 }]
      })
    ).toThrow(/lineage reference/);
    expect(
      filletVertexRadiiProblem({
        edgeHashes: [edge.hash],
        edgeReferences: [edge.reference!],
        vertexRadii: [{ edge: 0, end: 0, radius: 1 }]
      })
    ).toMatch(/variable-radius fillet/);
    // A repeated hash (as an edit patch could store) or missing directions
    // are refused wherever the list is checked (review).
    expect(
      filletVertexRadiiProblem({
        edgeHashes: [edge.hash, edge.hash],
        edgeReferences: [edge.reference!],
        endRadius: 2,
        edgeRuns: [true, true],
        vertexRadii: [{ edge: 1, end: 0, radius: 3 }]
      })
    ).toMatch(/names each edge once/);
    expect(
      filletVertexRadiiProblem({
        edgeHashes: [edge.hash],
        edgeReferences: [edge.reference!],
        endRadius: 2,
        vertexRadii: [{ edge: 0, end: 0, radius: 3 }]
      })
    ).toMatch(/direction each selected edge ran/);
    // An older document cannot take the field (review).
    expect(() =>
      filletEdges(
        {
          ...document,
          schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
        } as never,
        {
          ...base,
          vertexRadii: [{ edge: 0, end: 0, radius: 3 }]
        }
      )
    ).toThrow(/Per-vertex fillet radii/);

    const stored = filletEdges(document, {
      ...base,
      vertexRadii: [{ edge: 0, end: 0, radius: 3 }]
    }).document;
    expect(stored.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(() => assertDocumentContentSchema(stored)).not.toThrow();
    expect(() =>
      assertDocumentContentSchema({
        ...stored,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
      } as never)
    ).toThrow(/Per-vertex fillet radii/);

    // Edge runs without corner radii are refused, at creation and on load,
    // rather than silently dropped or carried (review).
    expect(() => filletEdges(document, base)).toThrow(
      /edge directions go only with per-vertex radii/
    );
    const orphan = structuredClone(stored);
    const fillet = listNodesByKind(orphan, 'feature').find(
      (node) => node.data.featureKind === 'fillet'
    )!;
    if (fillet.data.featureKind !== 'fillet') throw new Error('No fillet.');
    delete fillet.data.vertexRadii;
    expect(() => assertDocumentContentSchema(orphan)).toThrow();
  });

  it('refuses by name when an upstream turn swaps which corner is which', async () => {
    // The reviewer's case: R1 and R3 at the two corners of an X edge, then
    // the box turned 180° about Z upstream. The edge keeps its lineage but its
    // ends trade places; nothing in the geometry tells the swap from a plain
    // move, so the fillet is refused rather than built with the radii swapped.
    const adapter = await createExactKernelAdapter();
    try {
      let document = addPrimitiveFeature(createProjectDocument('Turn', user), {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: LENGTH, height: 40, depth: 20 }
      });
      const box = document.bodyOrder.at(-1) as BodyId;
      const moved = transformBody(document, {
        name: 'Turn',
        targetBodyId: box,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg: { x: 0, y: 0, z: 0 }
      });
      document = moved.document;
      const bodyId = moved.bodyId;
      const before = (await adapter.syncDocument(document)).bodyRepresentations[
        bodyId
      ]!;
      const edge = longEdge(before);
      const rounded = filletEdges(document, {
        name: 'Round',
        targetBodyId: bodyId,
        edgeHashes: [edge.hash],
        edgeReferences: [edge.reference!],
        size: 1,
        endRadius: 1,
        radiusLaw: 'linear',
        vertexRadii: [
          { edge: 0, end: 0, radius: 1 },
          { edge: 0, end: 1, radius: 3 }
        ],
        edgeRuns: [runOf(edge)]
      });
      const built = await adapter.syncDocument(rounded.document);
      expect(
        (built.featureWarnings ?? []).filter((w) => w.kind !== 'advisory')
      ).toEqual([]);
      const turn = listNodesByKind(rounded.document, 'feature').find(
        (feature) => feature.name === 'Turn'
      )!;
      const turned = updateFeature(rounded.document, {
        featureId: turn.featureId,
        data: {
          transform: {
            translation: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 180 }
          }
        }
      });
      const rebuilt = await adapter.syncDocument(turned);
      const refusal = (rebuilt.featureWarnings ?? []).find(
        (warning) => warning.kind !== 'advisory'
      );
      expect(refusal?.kernelRefusal?.code).toBe(
        'fillet_vertex_radius_unmatched'
      );
    } finally {
      adapter.dispose();
    }
  });

  it('drops the per-vertex radii when an edit returns the fillet to constant', async () => {
    const { document: rounded } = await roundWith([
      { edge: 0, end: 0, radius: 3 }
    ]);
    const fillet = listNodesByKind(rounded, 'feature').at(-1)!;
    // A patch that drops the lineage names the corners need is refused,
    // not returned to fail on load (review).
    expect(() =>
      updateFeature(rounded, {
        featureId: fillet.featureId,
        data: {
          edgeHashes: (fillet.data as { edgeHashes: number[] }).edgeHashes
        }
      })
    ).toThrow(/lineage reference/);
    const constant = updateFeature(rounded, {
      featureId: fillet.featureId,
      clearData: ['endRadius', 'radiusLaw']
    });
    const data = listNodesByKind(constant, 'feature').at(-1)!.data;
    expect(data.featureKind).toBe('fillet');
    expect('vertexRadii' in data).toBe(false);
  });
});
