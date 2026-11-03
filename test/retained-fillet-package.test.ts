import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

interface Arena {
  vertices: unknown[];
  edges: { curve: unknown; trim?: number[] }[];
  faces: unknown[];
  wires: unknown[];
  shells: unknown[];
  solids: unknown[];
  boundary_authority: unknown;
}

function arena(kernel: RemusKernel, solid: number): Arena {
  return JSON.parse(
    new TextDecoder().decode(kernel.serializeSolids(Uint32Array.of(solid)))
  ) as Arena;
}

function crowns(document: Arena) {
  return document.edges
    .filter(
      ({ curve }) =>
        curve !== null && typeof curve === 'object' && 'NurbsCurve' in curve
    )
    .map(({ curve, trim }) => ({ curve, trim }));
}

it('the adopted package retains an earlier curved crown when the opposite rim is filleted', async () => {
  // Geometry and the closed-form oracle come from Remus's public
  // retained_support_tests: a rounded box under z = 12 + 0.2*x.
  const kernel = new RemusKernel();
  try {
    const io = await loadRemusTranslators();
    const [source] = kernel.deserializeSolids(
      io.importStep(
        readFileSync(
          new URL(
            './fixtures/step/retained-support-crown.step',
            import.meta.url
          )
        )
      )
    );
    expect(kernel.validateSolid(source!)).toBe(0);
    const before = arena(kernel, source!);
    const originalCrowns = crowns(before);
    expect(originalCrowns).toHaveLength(1);
    expect(originalCrowns[0]!.trim).toEqual([2, 5]);
    const rims = [...kernel.getSolidEdges(source!)].filter((edge) => {
      if (kernel.getEdgeCurveType(edge) !== 'LINE') return false;
      const ends = kernel.getEdgeVertices(edge);
      return (
        Math.abs(ends[0]! - 20) < 1e-7 &&
        Math.abs(ends[3]! - 20) < 1e-7 &&
        Math.abs(ends[2]!) < 1e-7 &&
        Math.abs(ends[5]!) < 1e-7
      );
    });
    expect(rims).toHaveLength(1);
    const rounded = kernel.fillet(source!, Uint32Array.from(rims), 1);
    expect(kernel.validateSolid(rounded)).toBe(0);
    expect(crowns(arena(kernel, rounded))).toEqual(originalCrowns);
    const sourceAfter = arena(kernel, source!);
    for (const key of [
      'vertices',
      'edges',
      'faces',
      'wires',
      'shells',
      'solids',
      'boundary_authority'
    ] as const) {
      expect(sourceAfter[key]).toEqual(before[key]);
    }
    const removed =
      (1 - Math.PI / 4) * (15 + 13 + (Math.PI / 2) * 5) -
      (Math.PI / 2) * (5 / 6 - Math.PI / 4);
    expect(
      Math.abs(
        kernel.volume(source!, 0.001) - kernel.volume(rounded, 0.001) - removed
      )
    ).toBeLessThan(1e-3);
    const [reopened] = kernel.deserializeSolids(
      io.importStep(io.exportStep(kernel.serializeSolid(rounded)))
    );
    expect(kernel.validateSolid(reopened!)).toBe(0);
    expect(crowns(arena(kernel, reopened!))).toEqual(originalCrowns);
  } finally {
    kernel.free();
  }
});
