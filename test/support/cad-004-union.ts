/**
 * #1243 (CAD-004): the overlapping-cylinder Union and the checks its STEP
 * export must pass, shared by the adapter suite
 * (`test/cylinder-union-step-seam.test.ts`) and the browser download spec
 * (`test/e2e/cylinder-union-step-download.spec.ts`).
 */
import { readFileSync } from 'node:fs';
import {
  booleanBodies,
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { screenStepSeamWindows } from './step-cylinder-seam-window';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/** Cylinder A: r 8, h 16, base (0, 0, -8). B: r 6.56, h 13.12, base (6, 1, -6.06). */
export const SOURCES = {
  A: fixture('cad-004-cylinder-a.step'),
  B: fixture('cad-004-cylinder-b.step')
} as const;

/**
 * Exact union volume, mm³. Independently measured by OCCT on its own
 * BRepAlgoAPI_Fuse of the same cylinders (3947.68654); asserted to 1e-3 mm³
 * because the production reader measures with a tessellation deflection.
 */
export const UNION_VOLUME = 3947.68654;

/** Strictly inside B and outside A: the report's two witnesses, mm. */
export const WITNESSES = [
  [10.23672, -2.992, 0.336],
  [8.2424, -4.32, 0.16]
] as const;

/** Weld tolerance from the report, mm. */
const WELD = 1e-7;

export type Order = 'AB' | 'BA';

/** Both cylinders imported in `order`, then their Union. */
export function unionDocument(order: Order): {
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

/** What the text and the production reader say about a Union STEP export. */
export interface UnionStepInspection {
  /** Cylindrical faces whose seam lies inside one of their own windows. */
  seamFindings: number;
  /** Seamed cylindrical faces with a window that the screen judged. */
  seamScreened: number;
  /** Cylindrical faces the screen could not judge. */
  seamUnscreened: number;
  solids: number;
  /** `validateSolid` of the one solid; 0 is valid. */
  validity: number | null;
  /** mm³, at a 0.001 mm deflection. */
  volume: number | null;
  /** The reader's classification of each of {@link WITNESSES}. */
  witnesses: string[];
  /** The 0.01 mm tessellation's edge uses after welding at 1e-7 mm. */
  mesh: { degenerate: number; boundary: number; nonManifold: number } | null;
}

/**
 * What a usable export reads as: no seam inside a window, with A's wall (a
 * seam and B's window) screened and nothing left unscreened; one valid solid;
 * both witnesses inside; a closed manifold tessellation. The volume is
 * compared by the caller against {@link UNION_VOLUME}.
 */
export const USABLE_UNION_STEP = {
  seamFindings: 0,
  seamScreened: 1,
  seamUnscreened: 0,
  solids: 1,
  validity: 0,
  witnesses: ['inside', 'inside'],
  mesh: { degenerate: 0, boundary: 0, nonManifold: 0 }
} as const;

/** Reads a STEP export of the Union from its text and through the reader. */
export async function inspectUnionStep(
  step: string
): Promise<UnionStepInspection> {
  const screen = screenStepSeamWindows(step);
  const inspection: UnionStepInspection = {
    seamFindings: screen.findings.length,
    seamScreened: screen.screened,
    seamUnscreened: screen.unscreened,
    solids: 0,
    validity: null,
    volume: null,
    witnesses: [],
    mesh: null
  };
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const solids = kernel.deserializeSolids(
      io.importStep(new TextEncoder().encode(step))
    );
    inspection.solids = solids.length;
    if (solids.length !== 1) return inspection;
    const solid = solids[0]!;
    inspection.validity = kernel.validateSolid(solid);
    inspection.volume = kernel.volume(solid, 0.001);
    inspection.witnesses = WITNESSES.map(([x, y, z]) =>
      kernel.classifyPointRobust(solid, x, y, z, 1e-7)
    );
    const mesh = kernel.tessellateSolid(solid, 0.01);
    try {
      inspection.mesh = weldedEdgeCensus(mesh.positions, mesh.indices);
    } finally {
      mesh.free();
    }
  } finally {
    kernel.free();
  }
  return inspection;
}
