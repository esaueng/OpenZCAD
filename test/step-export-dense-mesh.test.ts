import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  helicalSweepProfile,
  importMeshBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId } from '@openzcad/shared';
import { profileSketch } from './fixtures/swept-elbow';

const user = toUserId('user_step_dense_mesh');

/**
 * A closed, outward-facing sphere whose rings are staggered by half a
 * segment. No two neighbouring facets are coplanar, so the solid conversion
 * keeps one planar face per triangle: the densest B-Rep a mesh of this size
 * can become.
 */
function sphereMesh(
  radius: number,
  segments: number,
  rings: number,
  centre: readonly [number, number, number]
): { vertices: number[]; indices: number[]; triangleCount: number } {
  const vertices: number[] = [centre[0], centre[1], centre[2] + radius];
  for (let ring = 1; ring < rings; ring += 1) {
    const polar = (Math.PI * ring) / rings;
    for (let segment = 0; segment < segments; segment += 1) {
      const turn = (2 * Math.PI * (segment + (ring % 2) / 2)) / segments;
      vertices.push(
        centre[0] + radius * Math.sin(polar) * Math.cos(turn),
        centre[1] + radius * Math.sin(polar) * Math.sin(turn),
        centre[2] + radius * Math.cos(polar)
      );
    }
  }
  vertices.push(centre[0], centre[1], centre[2] - radius);
  const south = vertices.length / 3 - 1;
  const at = (ring: number, segment: number) =>
    1 + (ring - 1) * segments + (segment % segments);
  const indices: number[] = [];
  for (let segment = 0; segment < segments; segment += 1) {
    indices.push(0, at(1, segment), at(1, segment + 1));
    indices.push(south, at(rings - 1, segment + 1), at(rings - 1, segment));
  }
  for (let ring = 1; ring < rings - 1; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = at(ring, segment);
      const b = at(ring, segment + 1);
      const c = at(ring + 1, segment);
      const d = at(ring + 1, segment + 1);
      // The stagger alternates which diagonal splits the skewed quad.
      if (ring % 2 === 1) indices.push(a, c, b, b, c, d);
      else indices.push(a, c, d, a, d, b);
    }
  }
  return { vertices, indices, triangleCount: indices.length / 3 };
}

/** The triangle count of the 3MF in the report (10,136), near enough. */
const MESH = sphereMesh(12, 72, 71, [60, 0, 0]);

function mixedDocument() {
  let document = addPrimitiveFeature(
    createProjectDocument('Dense mesh export', user),
    {
      name: 'Datum block',
      primitiveKind: 'box',
      dimensions: { width: 22, height: 16, depth: 4 }
    }
  );
  const block = document.bodyOrder[0] as BodyId;
  document = addPrimitiveFeature(document, {
    name: 'Housing',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 18 }
  });
  const housing = document.bodyOrder[1] as BodyId;
  const imported = importMeshBody(document, {
    name: 'Pump mesh',
    artifactId: 'artifact_dense_mesh',
    sourceName: 'pump.3mf',
    ...MESH
  });
  return {
    document: imported.document,
    block,
    housing,
    mesh: imported.bodyId
  };
}

/** Every entity id a STEP text declares, in file order. */
function entityIds(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(/^#(\d+)\s*=/gm)) {
    ids.push(Number(match[1]));
  }
  return ids;
}

/**
 * The most arguments one call takes before V8 reports "Maximum call stack
 * size exceeded": about 124,000 on a main thread and 63,000 in a Chromium
 * worker, where exports run. The finisher used to spread every entity id
 * into `Math.max`, so any file past the limit failed to export (#2085).
 */
const WORKER_ARGUMENT_LIMIT = 63_000;
const MAIN_THREAD_ARGUMENT_LIMIT = 125_000;

describe('STEP export of dense B-Reps (#2085)', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  it.each(['mm', 'inch'] as const)(
    'writes two exact solids and a 10,000-facet mesh solid in %s',
    async (units) => {
      expect(MESH.triangleCount).toBe(10_080);
      const { document, block, housing, mesh } = mixedDocument();
      const state = await adapter.syncDocument(document);
      // Small enough to convert: the mesh is an exact faceted solid, not a
      // mesh reference, so the all-bodies export has to write it.
      expect(state.bodyRepresentations[mesh]?.meshReference).toBeFalsy();
      expect(state.bodyRepresentations[mesh]?.exportableStep).toBe(true);
      // All but a handful of facets stay their own planar face.
      const meshFaces = state.bodyRepresentations[mesh]!.faceCount;
      expect(meshFaces).toBeGreaterThan(10_000);

      const text = await adapter.exportStep(document, [block, housing, mesh], {
        units
      });

      expect(text.match(/MANIFOLD_SOLID_BREP\('[^']*'/g)).toEqual([
        "MANIFOLD_SOLID_BREP('Datum block Body'",
        "MANIFOLD_SOLID_BREP('Housing Body'",
        "MANIFOLD_SOLID_BREP('Pump mesh'"
      ]);
      // Every face of the mesh solid, plus the box's six and the cylinder's
      // three: nothing was dropped to make the file fit.
      expect(text.match(/= ADVANCED_FACE\(/g)).toHaveLength(meshFaces + 6 + 3);
      // Past what either thread can take as one argument list.
      const ids = entityIds(text);
      expect(ids.length).toBeGreaterThan(MAIN_THREAD_ARGUMENT_LIMIT);
      // The presentation and unit entities appended after the writer's own
      // number on from its highest id, so none is declared twice.
      expect(new Set(ids).size).toBe(ids.length);
      expect(text.match(/= STYLED_ITEM\(/g)).toHaveLength(3);
      expect(text.match(/CONVERSION_BASED_UNIT\('INCH'/g) ?? []).toHaveLength(
        units === 'inch' ? 1 : 0
      );
      expect(text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n')).toBe(true);
    }
  );

  it('writes the same three bodies through the whole-document export', async () => {
    const { document, block, housing, mesh } = mixedDocument();
    const exported = await adapter.exportStepBodies(document);
    expect(exported.bodies).toEqual([
      { bodyId: block, solidCount: 1 },
      { bodyId: housing, solidCount: 1 },
      { bodyId: mesh, solidCount: 1 }
    ]);
    expect(exported.skipped).toEqual([]);
    expect(exported.text.match(/= MANIFOLD_SOLID_BREP\(/g)).toHaveLength(3);
  });

  // The second report on #2085: no mesh at all, a marker cube beside a
  // legacy sampled helix of 4.75 turns. Its 2,774 faces write about 67,000
  // entities: under a main thread's argument limit, which is why Node
  // exported it before the fix, and over a browser worker's, which is why
  // the app did not.
  it("writes a sampled helical sweep past a worker's argument limit", async () => {
    const marker = addPrimitiveFeature(
      createProjectDocument('Dense helix export', user),
      {
        name: 'Marker',
        primitiveKind: 'box',
        dimensions: { width: 2, height: 2, depth: 2 }
      }
    );
    const start = profileSketch(marker, {
      objectKind: 'circle',
      radius: 1.5,
      centerX: 0,
      centerY: 0
    });
    const helix = helicalSweepProfile(start.document, {
      name: 'Spring',
      profile: start.section,
      axisOrigin: { x: 0, y: 0, z: 0 },
      axisDirection: { x: 0, y: 0, z: 1 },
      radius: 12,
      pitch: 4.2,
      turns: 4.75
    });
    const state = await adapter.syncDocument(helix.document);
    expect(state.warnings).toEqual([]);
    expect(state.bodyRepresentations[helix.bodyId]?.faceCount).toBe(2774);

    const text = await adapter.exportStep(
      helix.document,
      helix.document.bodyOrder
    );
    expect(text.match(/= MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
    expect(text.match(/= ADVANCED_FACE\(/g)).toHaveLength(2774 + 6);
    const ids = entityIds(text);
    expect(ids.length).toBeGreaterThan(WORKER_ARGUMENT_LIMIT);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
