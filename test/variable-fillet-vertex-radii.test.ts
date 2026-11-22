import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  filletEdges,
  listNodesByKind,
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
 * M03 per-vertex radius controls (schema v142): a variable-radius fillet's
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
      }))
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

describe('per-vertex fillet radii (M03, v142)', { timeout: 120_000 }, () => {
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

  it('refuses a malformed list at creation and on load, and needs v142', async () => {
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
      radiusLaw: 'linear' as const
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

    const stored = filletEdges(document, {
      ...base,
      vertexRadii: [{ edge: 0, end: 0, radius: 3 }]
    }).document;
    expect(stored.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(() => assertDocumentContentSchema(stored)).not.toThrow();
    expect(() =>
      assertDocumentContentSchema({
        ...stored,
        // The last version before per-vertex radii (v142).
        schemaVersion: 141
      } as never)
    ).toThrow(/Per-vertex fillet radii/);
  });

  it('drops the per-vertex radii when an edit returns the fillet to constant', async () => {
    const { document: rounded } = await roundWith([
      { edge: 0, end: 0, radius: 3 }
    ]);
    const fillet = listNodesByKind(rounded, 'feature').at(-1)!;
    const constant = updateFeature(rounded, {
      featureId: fillet.featureId,
      clearData: ['endRadius', 'radiusLaw']
    });
    const data = listNodesByKind(constant, 'feature').at(-1)!.data;
    expect(data.featureKind).toBe('fillet');
    expect('vertexRadii' in data).toBe(false);
  });
});
