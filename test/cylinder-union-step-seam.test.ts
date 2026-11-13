/**
 * #1243 (CAD-004): the union of two overlapping axial cylinders must export a
 * STEP file other readers classify and mesh correctly, in both union orders,
 * committed and after a reload.
 *
 * Remus 2026.1.129 and older wrote cylinder A's seam through the window B cuts
 * in its wall. Remus and OCCT both read that file as one valid closed solid of
 * the right volume, so a volume or validity check cannot see the defect; OCCT
 * then classified points inside B as outside (A∪B) and meshed both orders
 * with boundary and non-manifold edges. Remus 2026.1.130 (esaueng/remus#1624)
 * places the seam in a free angular gap. The OCCT evidence is recorded in the
 * PR; this suite holds the property in repository tooling:
 *
 * - the exchange text: no cylindrical face's seam lies inside one of its own
 *   windows (`screenStepSeamWindows`), with the defective layout as a
 *   positive control so a screen that never fires cannot pass;
 * - the production reader: one valid solid, the exact union volume, both
 *   witnesses inside, and a closed manifold tessellation after welding.
 *
 * The source cylinders are independently authored (OCCT 8.0 STEP writer, the
 * one FreeCAD uses), mirroring the report's FreeCAD exports; only their header
 * timestamp is normalized.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  booleanBodies,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { screenStepSeamWindows } from './support/step-cylinder-seam-window';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Cylinder A: r 8, h 16, base (0, 0, -8). B: r 6.56, h 13.12, base (6, 1, -6.06). */
const SOURCES = {
  A: fixture('cad-004-cylinder-a.step'),
  B: fixture('cad-004-cylinder-b.step')
} as const;

/**
 * Exact union volume, mm³. Independently measured by OCCT on its own
 * BRepAlgoAPI_Fuse of the same cylinders (3947.68654); asserted to 1e-3 mm³
 * because the production reader measures with a tessellation deflection.
 */
const UNION_VOLUME = 3947.68654;

/** Strictly inside B and outside A: the report's two witnesses, mm. */
const WITNESSES = [
  [10.23672, -2.992, 0.336],
  [8.2424, -4.32, 0.16]
] as const;

/** Weld tolerance from the report, mm. */
const WELD = 1e-7;

/**
 * The defective layout, reduced: cylinder A's lateral face as Remus
 * 2026.1.129 wrote it for A∪B. The seam is the axial line at angle 0
 * (`(8, 0, z)`); the window B cuts spans roughly −44° to +63° about A's axis,
 * with a vertex on the seam angle itself.
 */
const SEAM_IN_WINDOW = `ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0., 0., -8.));
#2 = DIRECTION('', (0., 0., 1.));
#3 = DIRECTION('', (1., 0., 0.));
#4 = AXIS2_PLACEMENT_3D('', #1, #2, #3);
#5 = CYLINDRICAL_SURFACE('', #4, 8.);
#10 = CARTESIAN_POINT('', (8., 0., 8.));
#11 = VERTEX_POINT('', #10);
#12 = CARTESIAN_POINT('', (8., 0., -8.));
#13 = VERTEX_POINT('', #12);
#14 = DIRECTION('', (0., 0., -1.));
#15 = VECTOR('', #14, 16.);
#16 = LINE('', #10, #15);
#17 = EDGE_CURVE('', #11, #13, #16, .T.);
#18 = CARTESIAN_POINT('', (0., 0., 8.));
#19 = AXIS2_PLACEMENT_3D('', #18, #2, #3);
#20 = CIRCLE('', #19, 8.);
#21 = EDGE_CURVE('', #11, #11, #20, .T.);
#22 = CIRCLE('', #4, 8.);
#23 = EDGE_CURVE('', #13, #13, #22, .T.);
#24 = ORIENTED_EDGE('', *, *, #21, .F.);
#25 = ORIENTED_EDGE('', *, *, #17, .T.);
#26 = ORIENTED_EDGE('', *, *, #23, .T.);
#27 = ORIENTED_EDGE('', *, *, #17, .F.);
#28 = EDGE_LOOP('', (#24, #25, #26, #27));
#29 = FACE_OUTER_BOUND('', #28, .T.);
#30 = CARTESIAN_POINT('', (8., 0., -6.06));
#31 = VERTEX_POINT('', #30);
#32 = CARTESIAN_POINT('', (3.6435105538558914, 7.122136676864657, -6.06));
#33 = VERTEX_POINT('', #32);
#34 = CARTESIAN_POINT('', (5.756446202900868, -5.555477217405197, -6.06));
#35 = VERTEX_POINT('', #34);
#36 = CARTESIAN_POINT('', (0., 0., -6.06));
#37 = AXIS2_PLACEMENT_3D('', #36, #2, #3);
#38 = CIRCLE('', #37, 8.);
#39 = EDGE_CURVE('', #31, #33, #38, .T.);
#40 = EDGE_CURVE('', #35, #31, #38, .T.);
#41 = CARTESIAN_POINT('', (5.756446202900868, -5.555477217405197, 7.06));
#42 = VERTEX_POINT('', #41);
#43 = CARTESIAN_POINT('', (3.6435105538558914, 7.122136676864657, 7.06));
#44 = VERTEX_POINT('', #43);
#45 = CARTESIAN_POINT('', (0., 0., 7.06));
#46 = AXIS2_PLACEMENT_3D('', #45, #2, #3);
#47 = CIRCLE('', #46, 8.);
#48 = EDGE_CURVE('', #42, #44, #47, .T.);
#49 = VECTOR('', #14, 13.12);
#50 = LINE('', #41, #49);
#51 = EDGE_CURVE('', #42, #35, #50, .T.);
#52 = VECTOR('', #2, 13.12);
#53 = LINE('', #32, #52);
#54 = EDGE_CURVE('', #33, #44, #53, .T.);
#55 = ORIENTED_EDGE('', *, *, #39, .F.);
#56 = ORIENTED_EDGE('', *, *, #40, .F.);
#57 = ORIENTED_EDGE('', *, *, #51, .F.);
#58 = ORIENTED_EDGE('', *, *, #48, .T.);
#59 = ORIENTED_EDGE('', *, *, #54, .F.);
#60 = EDGE_LOOP('', (#55, #56, #57, #58, #59));
#61 = FACE_BOUND('', #60, .T.);
#62 = ADVANCED_FACE('', (#29, #61), #5, .T.);
ENDSEC;
END-ISO-10303-21;
`;

type Order = 'AB' | 'BA';

function unionDocument(order: Order): {
  document: ProjectDocument;
  union: BodyId;
} {
  let document = createProjectDocument(`Union ${order}`, toUserId('user_1243'));
  const operands: BodyId[] = [];
  for (const name of order.split('') as ('A' | 'B')[]) {
    const imported = importStepBody(document, {
      name: `Cylinder ${name}`,
      artifactId: `artifact_cad004_${name}`,
      sourceName: `cylinder-${name}.step`,
      stepText: SOURCES[name]
    });
    document = imported.document;
    operands.push(imported.bodyId);
  }
  const fused = booleanBodies(document, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: operands
  });
  return { document: fused.document, union: fused.bodyId };
}

/** Production export from a fresh adapter: a cold build, as after a reload. */
async function exportUnion(document: ProjectDocument, union: BodyId) {
  const adapter = await createExactKernelAdapter();
  try {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    expect(derived.exportableBodyIds).toEqual([union]);
    return await adapter.exportStep(document, [union], {
      timestamp: '2026-11-13T00:00:00'
    });
  } finally {
    adapter.dispose();
  }
}

/** Edge-use census of a tessellation after welding positions at `WELD`. */
function weldedEdgeCensus(positions: Float64Array, indices: Uint32Array) {
  const ids = new Map<string, number>();
  const welded = Array.from({ length: positions.length / 3 }, (_, vertex) => {
    const key = [0, 1, 2]
      .map((axis) => Math.round(positions[vertex * 3 + axis]! / WELD))
      .join(',');
    if (!ids.has(key)) ids.set(key, ids.size);
    return ids.get(key)!;
  });
  const uses = new Map<string, number>();
  let degenerate = 0;
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const corners = [0, 1, 2].map(
      (corner) => welded[indices[triangle + corner]!]!
    );
    if (new Set(corners).size < 3) {
      degenerate += 1;
      continue;
    }
    for (let side = 0; side < 3; side += 1) {
      const a = corners[side]!;
      const b = corners[(side + 1) % 3]!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const counts = [...uses.values()];
  return {
    degenerate,
    boundary: counts.filter((count) => count === 1).length,
    nonManifold: counts.filter((count) => count > 2).length
  };
}

describe('overlapping cylinder Union STEP export (#1243)', () => {
  it('screens the defective seam-in-window layout as a finding', () => {
    // The positive control: without it a screen that never fires would pass
    // every export below.
    const screen = screenStepSeamWindows(SEAM_IN_WINDOW);
    expect(screen.unscreened).toBe(0);
    expect(screen.screened).toBe(1);
    expect(screen.findings).toEqual([{ faceId: 62, seamAngle: 0, loopId: 60 }]);
  });

  it('clears the independently authored source cylinders', () => {
    // Full cylinders: a seam and no window, so nothing to cross.
    for (const step of Object.values(SOURCES)) {
      expect(screenStepSeamWindows(step)).toEqual({
        findings: [],
        screened: 0,
        unscreened: 0
      });
    }
  });

  it.each(['AB', 'BA'] as const)(
    'exports %s as a solid other readers classify and mesh, committed and reloaded',
    async (order) => {
      const { document, union } = unionDocument(order);
      const committed = await exportUnion(document, union);
      // Reload: the persisted document's JSON round trip, rebuilt cold.
      const reloaded = await exportUnion(
        JSON.parse(JSON.stringify(document)) as ProjectDocument,
        union
      );
      expect(reloaded).toBe(committed);

      const screen = screenStepSeamWindows(committed);
      expect(screen.findings).toEqual([]);
      expect(screen.unscreened).toBe(0);
      // A's wall keeps its seam and gains B's window: the case is screened.
      expect(screen.screened).toBe(1);

      const io = await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        const solids = kernel.deserializeSolids(
          io.importStep(new TextEncoder().encode(committed))
        );
        expect(solids).toHaveLength(1);
        const solid = solids[0]!;
        expect(kernel.validateSolid(solid)).toBe(0);
        expect(kernel.volume(solid, 0.001)).toBeCloseTo(UNION_VOLUME, 3);
        for (const [x, y, z] of WITNESSES) {
          expect(kernel.classifyPointRobust(solid, x, y, z, 1e-7)).toBe(
            'inside'
          );
        }
        const mesh = kernel.tessellateSolid(solid, 0.01);
        try {
          expect(weldedEdgeCensus(mesh.positions, mesh.indices)).toEqual({
            degenerate: 0,
            boundary: 0,
            nonManifold: 0
          });
        } finally {
          mesh.free();
        }
      } finally {
        kernel.free();
      }
    },
    60_000
  );
});
