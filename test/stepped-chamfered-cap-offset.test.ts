import { afterEach, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { tryExactLocalChamferCapOffset } from '../packages/kernel-adapter/src/exact-local-chamfer-cap';
import { tryExactChamferedCylinderCapOffset } from '../packages/kernel-adapter/src/exact-chamfered-cylinder';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  steppedArena,
  steppedChamferedCylinderSolid
} from './support/stepped-chamfered-cylinder';
import { chamferedCylinderSolid } from './support/chamfered-cylinder';

const adapters: Awaited<ReturnType<typeof createExactKernelAdapter>>[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});
const cap = (body: BodyRepresentation) =>
  body.topology!.faces.find(
    (face) => face.geometry?.surfaceType === 'plane' && face.geometry.area < 60
  )!;

describe('local chamfered end offsets on stepped imported bodies', () => {
  it.each([
    { sense: -1, offset: 105, mirrored: false, tilted: false },
    { sense: -1, offset: 105, mirrored: true, tilted: true },
    { sense: 1, offset: 20, mirrored: false, tilted: false },
    { sense: 1, offset: 20, mirrored: true, tilted: true },
    { sense: -1, offset: -10, mirrored: false, tilted: false }
  ])(
    'preserves every shoulder record and verifies exact export (%j)',
    async ({ sense, offset, mirrored, tilted }) => {
      const kernel = new RemusKernel();
      try {
        let source = steppedChamferedCylinderSolid(kernel);
        if (mirrored) source = kernel.mirror(source, 0, 0, 0, 0, 1, 0);
        if (tilted)
          source = kernel.copyAndTransformSolid(
            source,
            transformMatrix({ x: 30, y: -40, z: 50 }, { x: 30, y: 60, z: 15 })
          );
        const io = await loadRemusTranslators();
        const [solid] = kernel.deserializeSolids(
          io.importStep(io.exportStep(kernel.serializeSolid(source)))
        );
        expect(
          [...kernel.getSolidEdges(source)].some((edge) => {
            const span = kernel.getEdgeParamSpan(edge);
            return (
              kernel.getEdgeCurveType(edge) === 'CIRCLE' &&
              Math.abs(Math.abs(span[1]! - span[0]!) - Math.PI) < 1e-6
            );
          })
        ).toBe(true);
        const splitCap = [...kernel.getSolidFaces(source)].find(
          (face) =>
            kernel.getSurfaceType(face) === 'plane' &&
            kernel.faceArea(face, 0.001) < 60 === sense < 0
        )!;
        const splitResult = tryExactLocalChamferCapOffset(
          kernel,
          source,
          splitCap,
          offset
        );
        expect(splitResult).not.toBeNull();
        expect(kernel.validateSolid(splitResult!.solid)).toBe(0);
        const faces = [...kernel.getSolidFaces(solid!)];
        const planes = faces.filter(
          (face) => kernel.getSurfaceType(face) === 'plane'
        );
        const selected = planes.find(
          (face) => kernel.faceArea(face, 0.001) < 60 === sense < 0
        )!;
        const before = kernel.serializeSolid(solid!);
        const arena = steppedArena(kernel, solid!);
        expect(faces).toHaveLength(9);
        expect(arena.faces.filter((face) => face.surface.Nurbs)).toHaveLength(
          1
        );
        // The former whole-cylinder specialization declines this fixture and
        // the ordinary kernel move reproduces the original cone refusal.
        expect(
          tryExactChamferedCylinderCapOffset(kernel, solid!, selected, offset)
        ).toBeNull();
        // An outward move reaches the cone guard; shortening can hit the
        // general swept-face topology guard before cone classification.
        expect(() =>
          kernel.moveFaces(solid!, Uint32Array.of(selected), offset)
        ).toThrow(offset > 0 ? /cone/ : /offset:/);
        const result = tryExactLocalChamferCapOffset(
          kernel,
          solid!,
          selected,
          offset
        );
        expect(result).not.toBeNull();
        expect(kernel.validateSolid(result!.solid)).toBe(0);
        expect(result!.relation.faceMap.size).toBe(9);
        const edited = steppedArena(kernel, result!.solid);
        const changed = arena.faces.flatMap((face, i) =>
          JSON.stringify(face) === JSON.stringify(edited.faces[i]) ? [] : [i]
        );
        expect(changed).toHaveLength(2);
        expect(
          changed.map((i) => Object.keys(arena.faces[i]!.surface)[0]).sort()
        ).toEqual(['Cone', 'Plane']);
        // Stronger than a volume check: every rational control point, weight,
        // knot, torus, fixed rim and opposite end stays byte-identical.
        for (let i = 0; i < arena.faces.length; i++)
          if (!changed.includes(i))
            expect(edited.faces[i]).toEqual(arena.faces[i]);
        expect(edited.boundary_authority).toEqual(arena.boundary_authority);
        expect(edited.wires).toEqual(arena.wires);
        const moved = result!.relation.faceMap.get(selected)!;
        const normal = [...kernel.getFaceNormal(selected)];
        const oldPlane = JSON.parse(
          kernel.getAnalyticSurfaceParams(selected)
        ) as { d: number; normal: number[] };
        const newPlane = JSON.parse(
          kernel.getAnalyticSurfaceParams(moved)
        ) as typeof oldPlane;
        const alignment = normal.reduce(
          (s, n, i) => s + n * oldPlane.normal[i]!,
          0
        );
        expect(newPlane.d - oldPlane.d).toBeCloseTo(offset * alignment, 7);
        const coneIndex = changed.find((i) => arena.faces[i]!.surface.Cone)!;
        const oldCone = arena.faces[coneIndex]!.surface.Cone as {
          apex: number[];
        };
        const newCone = edited.faces[coneIndex]!.surface.Cone as typeof oldCone;
        expect({ ...newCone, apex: oldCone.apex }).toEqual(oldCone);
        oldCone.apex.forEach((value, i) =>
          expect(newCone.apex[i]).toBeCloseTo(value + normal[i]! * offset, 7)
        );
        const localEdges = new Set(
          changed.flatMap((i) =>
            arena.wires[arena.faces[i]!.outer_wire]!.edges.map((e) => e.edge)
          )
        );
        const localVertices = new Set(
          [...localEdges].flatMap((i) => [
            arena.edges[i]!.start,
            arena.edges[i]!.end
          ])
        );
        arena.vertices.forEach((vertex, i) => {
          if (!localVertices.has(i)) expect(edited.vertices[i]).toEqual(vertex);
          else
            vertex.point.forEach((value, axis) =>
              expect(edited.vertices[i]!.point[axis]).toBeCloseTo(
                value + normal[axis]! * offset,
                7
              )
            );
        });
        arena.edges.forEach((edge, i) => {
          const next = edited.edges[i]!;
          if (!localEdges.has(i)) expect(next).toEqual(edge);
          else if (edge.curve !== 'Line' && next.curve !== 'Line') {
            expect({
              ...next.curve.Circle,
              center: edge.curve.Circle.center
            }).toEqual(edge.curve.Circle);
            edge.curve.Circle.center.forEach((value, axis) =>
              expect(
                next.curve !== 'Line' && next.curve.Circle.center[axis]
              ).toBeCloseTo(value + normal[axis]! * offset, 7)
            );
          }
        });
        // Integrate the exact changed cylindrical section. Whole-body volume
        // uses sampled trim outlines on this family, so it is not an exact
        // oracle; the unchanged shoulder and rigid chamfer cancel above.
        const radius = sense < 0 ? 6 : 10;
        const wallIndex = arena.faces.findIndex(
          (f) =>
            Math.abs(
              ((f.surface.Cylinder as { radius?: number } | undefined)
                ?.radius ?? 0) - radius
            ) < 1e-7
        );
        const wallSpan = (shape: typeof arena) => {
          const positions = shape.wires[
            shape.faces[wallIndex]!.outer_wire
          ]!.edges.flatMap(({ edge }) => {
            const curve = shape.edges[edge]!.curve;
            return curve === 'Line'
              ? []
              : [
                  curve.Circle.center.reduce(
                    (sum, value, axis) => sum + value * normal[axis]!,
                    0
                  )
                ];
          });
          return Math.max(...positions) - Math.min(...positions);
        };
        expect(
          Math.PI * radius ** 2 * (wallSpan(edited) - wallSpan(arena))
        ).toBeCloseTo(Math.PI * radius ** 2 * offset, 7);
        expect(kernel.serializeSolid(solid!)).toEqual(before);
        const [reimported] = kernel.deserializeSolids(
          io.importStep(io.exportStep(kernel.serializeSolid(result!.solid)))
        );
        expect(kernel.validateSolid(reimported!)).toBe(0);
        expect(kernel.getSolidFaces(reimported!).length).toBe(9);
      } finally {
        kernel.free();
      }
    }
  );

  it('retains face names through a second edit and fresh JSON replay', async () => {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(
        kernel.serializeSolid(steppedChamferedCylinderSolid(kernel))
      )
    );
    kernel.free();
    const imported = importStepBody(
      createProjectDocument('Stepped rod', toUserId('user_test')),
      {
        name: 'Stepped rod',
        sourceName: 'stepped-rod.step',
        artifactId: 'artifact_stepped',
        stepText
      }
    );
    const adapter = await createExactKernelAdapter();
    adapters.push(adapter);
    const derived = await adapter.syncDocument(imported.document);
    expect(derived.warnings).toEqual([]);
    const document = { ...imported.document, derived };
    const before = derived.bodyRepresentations[imported.bodyId]!;
    const picked = cap(before);
    const manager = new CommandManager(document);
    for (const offset of [20, 5]) {
      const face = cap(
        manager.document.derived.bodyRepresentations[imported.bodyId]!
      );
      manager.execute(
        planFaceOffset({
          document: manager.document,
          bodyId: imported.bodyId,
          face,
          faceHash: face.hash,
          offset
        })!.command
      );
      const next = await adapter.syncDocument(manager.document);
      expect(next.warnings).toEqual([]);
      expect(
        cap(next.bodyRepresentations[imported.bodyId]!).reference?.lineageName
      ).toBe(picked.reference?.lineageName);
      manager.commitDerivedState(next);
    }
    const fresh = await createExactKernelAdapter();
    adapters.push(fresh);
    const replayed = await fresh.syncDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(replayed.warnings).toEqual([]);
    const after = replayed.bodyRepresentations[imported.bodyId]!;
    expect(after.faceCount).toBe(9);
    expect(cap(after).geometry!.center.z).toBeCloseTo(-25, 7);
    expect(
      after
        .topology!.faces.filter((f) => f.geometry?.surfaceType === 'bspline')
        .map((f) => f.geometry)
    ).toEqual(
      before
        .topology!.faces.filter((f) => f.geometry?.surfaceType === 'bspline')
        .map((f) => f.geometry)
    );
  });

  it('refuses wall collapse and non-cap selections without mutating the source', () => {
    const kernel = new RemusKernel();
    try {
      const solid = steppedChamferedCylinderSolid(kernel);
      const face = [...kernel.getSolidFaces(solid)].find(
        (f) =>
          kernel.getSurfaceType(f) === 'plane' &&
          kernel.getFaceNormal(f)[2]! < -0.99
      )!;
      const source = kernel.serializeSolid(solid);
      expect(() =>
        tryExactLocalChamferCapOffset(kernel, solid, face, -100)
      ).toThrow(/no cylindrical wall/);
      // A positive wall length alone cannot prove clearance to a rounded
      // shoulder. A move beyond its conservative support bound declines.
      expect(
        tryExactLocalChamferCapOffset(kernel, solid, face, -43)
      ).toBeNull();
      const wall = [...kernel.getSolidFaces(solid)].find(
        (f) => kernel.getSurfaceType(f) === 'cylinder'
      )!;
      expect(tryExactLocalChamferCapOffset(kernel, solid, wall, 10)).toBeNull();
      expect(kernel.serializeSolid(solid)).toEqual(source);
      const tube = kernel.cut(
        chamferedCylinderSolid(kernel),
        kernel.makeCylinder(1, 240)
      );
      const tubeCap = [...kernel.getSolidFaces(tube)].find(
        (f) => kernel.getSurfaceType(f) === 'plane'
      )!;
      const tubeBefore = kernel.serializeSolid(tube);
      expect(
        tryExactLocalChamferCapOffset(kernel, tube, tubeCap, 10)
      ).toBeNull();
      expect(kernel.serializeSolid(tube)).toEqual(tubeBefore);
    } finally {
      kernel.free();
    }
  });
});
