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
  filletRadiusStationsProblem,
  toUserId,
  type BodyId,
  type EdgeTopology
} from '@openzcad/shared';

/**
 * M03 radius stations (schema v152): a variable-radius fillet with interior
 * radii along each edge, at fractions from the edge's witness end 0, the law
 * running between neighbouring stations. Built exactly by the kernel's
 * station law (esaueng/remus#1939): each piece of the law is a cubic, so the
 * round takes (1 − π/4)·∫r² along the edge.
 */
const LENGTH = 60;
const BOX = LENGTH * 40 * 20;
const CORNER = 1 - Math.PI / 4;

/** ∫r² over a piecewise law through (t, r) stations, by 4-point Gauss. */
function squareIntegral(
  stations: [number, number][],
  law: 'linear' | 'scurve'
): number {
  const nodes = [
    [-0.8611363115940526, 0.3478548451374538],
    [-0.3399810435848563, 0.6521451548625461],
    [0.3399810435848563, 0.6521451548625461],
    [0.8611363115940526, 0.3478548451374538]
  ];
  let sum = 0;
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const [t0, r0] = stations[i]!;
    const [t1, r1] = stations[i + 1]!;
    for (const [x, w] of nodes) {
      const u = (x! + 1) / 2;
      const s = law === 'linear' ? u : u * u * (3 - 2 * u);
      const r = r0 + (r1 - r0) * s;
      sum += (w! / 2) * (t1 - t0) * r * r;
    }
  }
  return sum;
}

/**
 * Whether the kernel runs `edge` from its witness end 0 to end 1: its drawn
 * polyline ends at witness end 1. What a pick records as `edgeRuns`.
 */
function runOf(edge: EdgeTopology): boolean {
  const far = edge.points.slice(-3);
  const witness = edge.reference!.witness;
  if (witness.closed) throw new Error('Expected an open edge.');
  const near = (end: 0 | 1) => {
    const [x, y, z] = witness.endpoints[end];
    return Math.hypot(
      far[0]! - x * 1e-6,
      far[1]! - y * 1e-6,
      far[2]! - z * 1e-6
    );
  };
  return near(1) < near(0);
}

describe('fillet radius stations (M03, v152)', { timeout: 120_000 }, () => {
  it('rounds the edge through its stations exactly, measured from where it was picked', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const document = addPrimitiveFeature(
        createProjectDocument('Stations', toUserId('user_stations')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: LENGTH, height: 40, depth: 20 }
        }
      );
      const bodyId = document.bodyOrder.at(-1) as BodyId;
      const built = await adapter.syncDocument(document);
      const edge = built.bodyRepresentations[bodyId]!.topology!.edges.find(
        (candidate: EdgeTopology) =>
          candidate.curve?.type === 'LINE' &&
          Math.abs((candidate.length ?? 0) - LENGTH) < 1e-6 &&
          candidate.reference?.witness.closed === false
      )!;
      for (const law of ['linear', 'scurve'] as const) {
        const rounded = filletEdges(document, {
          name: 'Round',
          targetBodyId: bodyId,
          edgeHashes: [edge.hash],
          edgeReferences: [edge.reference!],
          size: 1,
          endRadius: 2,
          radiusLaw: law,
          radiusStations: [{ at: 0.25, radius: 3 }],
          edgeRuns: [runOf(edge)]
        });
        const derived = await adapter.syncDocument(rounded.document);
        expect(
          (derived.featureWarnings ?? []).filter(
            (warning) => warning.kind !== 'advisory'
          ),
          law
        ).toEqual([]);
        // Whichever way the kernel runs the edge, the station stands a
        // quarter of the way from witness end 0, where the radius is 1.
        const expected =
          BOX -
          CORNER *
            LENGTH *
            squareIntegral(
              [
                [0, 1],
                [0.25, 3],
                [1, 2]
              ],
              law
            );
        expect(
          derived.bodyRepresentations[rounded.bodyId]!.volume,
          law
        ).toBeCloseTo(expected, 3);
      }

      // Malformed lists are refused at creation; a stored list needs v152.
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
      for (const radiusStations of [
        [],
        [{ at: 0, radius: 2 }],
        [{ at: 1, radius: 2 }],
        [
          { at: 0.6, radius: 2 },
          { at: 0.4, radius: 2 }
        ],
        [{ at: 0.5, radius: Number.NaN }]
      ])
        expect(() =>
          filletEdges(document, { ...base, radiusStations })
        ).toThrow();
      expect(() =>
        filletEdges(document, {
          ...base,
          edgeReferences: [],
          radiusStations: [{ at: 0.5, radius: 2 }]
        })
      ).toThrow(/lineage reference/);
      expect(
        filletRadiusStationsProblem({
          edgeHashes: [edge.hash],
          edgeReferences: [edge.reference!],
          radiusStations: [{ at: 0.5, radius: 2 }]
        })
      ).toMatch(/variable-radius fillet/);
      const stored = filletEdges(document, {
        ...base,
        radiusStations: [{ at: 0.5, radius: 3 }]
      }).document;
      expect(() => assertDocumentContentSchema(stored)).not.toThrow();
      expect(() =>
        assertDocumentContentSchema({
          ...stored,
          schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
        } as never)
      ).toThrow(/Fillet radius stations/);
      // One station, and not beside per-vertex radii: the editor holds one
      // way to vary the radius, so a stored fillet reopens exactly (review).
      expect(() =>
        filletEdges(document, {
          ...base,
          radiusStations: [
            { at: 0.25, radius: 3 },
            { at: 0.75, radius: 3 }
          ]
        })
      ).toThrow(/one radius station/);
      expect(() =>
        filletEdges(document, {
          ...base,
          radiusStations: [{ at: 0.5, radius: 3 }],
          vertexRadii: [{ edge: 0, end: 0, radius: 3 }]
        })
      ).toThrow(/stations or per-vertex radii, not both/);
      // Nor on an older document, by the exported mutations (review).
      const older = {
        ...document,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
      } as never;
      expect(() =>
        filletEdges(older, {
          ...base,
          radiusStations: [{ at: 0.5, radius: 3 }]
        })
      ).toThrow(/Fillet radius stations/);
      // Stations without the way each edge ran are refused (review).
      const { edgeRuns: _runs, ...runless } = base;
      expect(() =>
        filletEdges(document, {
          ...runless,
          radiusStations: [{ at: 0.5, radius: 3 }]
        })
      ).toThrow(/direction each selected edge ran/);
      // A patch may not add stations to an older document either (review).
      const plain = filletEdges(document, runless).document;
      const fillet = listNodesByKind(plain, 'feature').at(-1)!;
      expect(() =>
        updateFeature(
          {
            ...plain,
            schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION - 1
          } as never,
          {
            featureId: fillet.featureId,
            data: {
              radiusStations: [{ at: 0.5, radius: 3 }],
              edgeRuns: base.edgeRuns
            }
          }
        )
      ).toThrow(/Fillet radius stations/);
      // A patch that drops the lineage names stations need is refused, not
      // returned to fail on load (review).
      const stationed = filletEdges(document, {
        ...base,
        radiusStations: [{ at: 0.5, radius: 3 }]
      }).document;
      const stationFillet = listNodesByKind(stationed, 'feature').at(-1)!;
      expect(() =>
        updateFeature(stationed, {
          featureId: stationFillet.featureId,
          data: { edgeHashes: [edge.hash] }
        })
      ).toThrow(/lineage reference/);
    } finally {
      adapter.dispose();
    }
  });
});
