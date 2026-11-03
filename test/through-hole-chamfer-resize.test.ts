import { describe, expect, it } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { resizeThroughHole } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { requireThroughHole } from '../packages/kernel-adapter/src/exact-measure';
import { applyEdgeModifier } from '../packages/kernel-adapter/src/exact-edge-modifiers';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { steppedArena } from './support/stepped-chamfered-cylinder';
import { readFileSync } from 'node:fs';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { CommandManager, commandFactories } from '@openzcad/command-system';

const BORE = 3;
const HEIGHT = 10;

function chamferedPlate(
  kernel: RemusKernel,
  mouths: 1 | 2,
  angle = 45,
  height = HEIGHT
) {
  const bore = kernel.copyAndTransformSolid(
    kernel.makeCylinder(BORE, height),
    new Float64Array([1, 0, 0, 15, 0, 1, 0, 15, 0, 0, 1, 0, 0, 0, 0, 1])
  );
  const drilled = kernel.cut(kernel.makeBox(30, 30, height), bore);
  const rims = [...kernel.getSolidEdges(drilled)].filter((edge) => {
    if (new Set(kernel.getEdgeVertexHandles(edge)).size !== 1) return false;
    return (
      mouths === 2 ||
      [...kernel.tessellateEdge(edge, 1e-3)].every(
        (value, index) => index % 3 !== 2 || Math.abs(value - height) < 1e-6
      )
    );
  });
  expect(rims).toHaveLength(mouths);
  return applyEdgeModifier(
    kernel,
    drilled,
    rims,
    'chamfer',
    1,
    undefined,
    undefined,
    (angle * Math.PI) / 180
  )!;
}

function resize(kernel: RemusKernel, solid: number, diameter: number) {
  const face = [...kernel.getSolidFaces(solid)].find(
    (candidate) => kernel.getSurfaceType(candidate) === 'cylinder'
  )!;
  const source = requireThroughHole(kernel, solid, face);
  return resizeThroughHole(
    kernel,
    solid,
    face,
    {
      kind: 'resize-through-hole',
      faceHash: 0,
      sourceDiameter: source.diameter,
      sourceAxisStart: source.axisStart,
      sourceAxisEnd: source.axisEnd,
      diameter
    },
    {}
  ).solid;
}

function volume(radius: number, mouths: number) {
  const mouthRadius = BORE + 1;
  const depth = mouthRadius - radius;
  const sinkBeyondBore =
    (Math.PI *
      depth *
      (mouthRadius ** 2 + mouthRadius * radius - 2 * radius ** 2)) /
    3;
  return (
    30 * 30 * HEIGHT - Math.PI * radius ** 2 * HEIGHT - mouths * sinkBeyondBore
  );
}

describe('through-hole resizing extends its existing chamfer angle', () => {
  it.each([1, 2] as const)(
    'shrinks a bore with %i chamfered mouth(s) without a flat shelf',
    (mouths) => {
      const kernel = new RemusKernel();
      try {
        const solid = chamferedPlate(kernel, mouths);
        const sourceBytes = kernel.serializeSolids(Uint32Array.of(solid));
        const before = steppedArena(kernel, solid);
        expect(kernel.volume(solid, 1e-5)).toBeCloseTo(volume(BORE, mouths), 4);
        const resized = resize(kernel, solid, 4.2);
        const counts: Record<string, number> = {};
        for (const face of kernel.getSolidFaces(resized)) {
          const type = kernel.getSurfaceType(face);
          counts[type] = (counts[type] ?? 0) + 1;
        }
        expect(counts).toEqual({ plane: 6, cylinder: 1, cone: mouths });
        expect(kernel.volume(resized, 1e-5)).toBeCloseTo(
          volume(2.1, mouths),
          4
        );
        expect(kernel.validateSolid(resized)).toBe(0);
        // The cone itself, all other surfaces, and the topology stay exact.
        const after = steppedArena(kernel, resized);
        before.faces.forEach((face, i) => {
          if (!face.surface.Cylinder) expect(after.faces[i]).toEqual(face);
          else
            expect(after.faces[i]).toEqual({
              ...face,
              surface: {
                Cylinder: { ...face.surface.Cylinder, radius: 2.1 }
              }
            });
        });
        expect(after.wires).toEqual(before.wires);
        expect(after.boundary_authority).toEqual(before.boundary_authority);
        expect(kernel.serializeSolids(Uint32Array.of(solid))).toEqual(
          sourceBytes
        );
        const cylinder = [...kernel.getSolidFaces(resized)].find(
          (f) => kernel.getSurfaceType(f) === 'cylinder'
        )!;
        const bore = requireThroughHole(kernel, resized, cylinder);
        expect(bore.axialLength).toBeCloseTo(HEIGHT - mouths * 1.9, 7);
        // A second edit starts from the extended chamfer, with no stale seam.
        const again = resize(kernel, resized, 3.6);
        expect(kernel.volume(again, 1e-5)).toBeCloseTo(volume(1.8, mouths), 4);
      } finally {
        kernel.free();
      }
    }
  );

  it.each([30, 60])(
    'retains a %i degree chamfer on a tilted and mirrored bore',
    (angle) => {
      const kernel = new RemusKernel();
      try {
        const source = chamferedPlate(kernel, 2, angle);
        const arena = steppedArena(kernel, source);
        const circles = arena.edges.flatMap((e) =>
          e.curve === 'Line' ? [] : [e.curve.Circle]
        );
        const atEnd = (z: number) =>
          circles.find((c) => Math.abs(c.center[2] - z) < 1e-7)!;
        const cones = arena.faces
          .filter((f) => f.surface.Cone)
          .map((f) => f.surface.Cone);
        const remaining = [0, HEIGHT].map((z) => {
          const mouth = atEnd(z);
          const inner = circles.find(
            (c) =>
              Math.abs(c.radius - BORE) < 1e-7 &&
              (z === 0 ? c.center[2] < HEIGHT / 2 : c.center[2] > HEIGHT / 2)
          )!;
          const depth =
            (Math.abs(inner.center[2] - z) * (mouth.radius - 2.1)) /
            (mouth.radius - BORE);
          return (
            (Math.PI *
              depth *
              (mouth.radius ** 2 + mouth.radius * 2.1 - 2 * 2.1 ** 2)) /
            3
          );
        });
        const transformed = kernel.copyAndTransformSolid(
          kernel.mirror(source, 0, 0, 0, 0, 1, 0),
          transformMatrix({ x: 20, y: -30, z: 40 }, { x: 30, y: 60, z: 15 })
        );
        const resized = resize(kernel, transformed, 4.2);
        expect(kernel.volume(resized, 1e-5)).toBeCloseTo(
          9000 - Math.PI * 2.1 ** 2 * HEIGHT - remaining[0]! - remaining[1]!,
          4
        );
        const beforeCones = [...kernel.getSolidFaces(transformed)]
          .filter((f) => kernel.getSurfaceType(f) === 'cone')
          .map((f) => kernel.getAnalyticSurfaceParams(f));
        const afterCones = [...kernel.getSolidFaces(resized)]
          .filter((f) => kernel.getSurfaceType(f) === 'cone')
          .map((f) => kernel.getAnalyticSurfaceParams(f));
        expect(afterCones.sort()).toEqual(beforeCones.sort());
        expect(cones).toHaveLength(2);
      } finally {
        kernel.free();
      }
    }
  );

  it('refuses overlapping chamfers without changing the source', () => {
    const kernel = new RemusKernel();
    try {
      const source = chamferedPlate(kernel, 2, 45, 4);
      const before = kernel.serializeSolids(Uint32Array.of(source));
      expect(() => resize(kernel, source, 3.8)).toThrow(/no cylindrical wall/);
      expect(kernel.serializeSolids(Uint32Array.of(source))).toEqual(before);
      expect(kernel.validateSolid(source)).toBe(0);
    } finally {
      kernel.free();
    }
  });
});

const privateProject = process.env.OZ_CHAMFER_PROJECT;
it.skipIf(!privateProject)(
  'replays a supplied chamfered-hole project through resize, undo, redo and STEP',
  async () => {
    const adapter = await createExactKernelAdapter();
    const fresh = await createExactKernelAdapter();
    try {
      const { document } = await parseProjectBackup(
        readFileSync(privateProject!, 'utf8')
      );
      const manager = new CommandManager(document);
      const before = await adapter.syncDocument(document);
      expect(before.warnings).toEqual([]);
      const bodyId = before.exportableBodyIds[0]!;
      const body = before.bodyRepresentations[bodyId]!;
      const wall = body.topology!.faces.find(
        (f) => f.geometry?.featureType === 'through-hole'
      )!;
      expect(wall.geometry!.diameter).toBeCloseTo(6, 7);
      const cones = body.topology!.faces.filter(
        (f) => f.geometry?.surfaceType === 'cone'
      );
      expect(cones).toHaveLength(2);
      manager.execute(
        commandFactories.directEditBody({
          name: 'Resize Through Hole',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-through-hole',
            faceHash: wall.hash,
            faceReference: wall.reference,
            sourceDiameter: wall.geometry!.diameter!,
            sourceAxisStart: wall.geometry!.axisStart!,
            sourceAxisEnd: wall.geometry!.axisEnd!,
            diameter: 4.2
          }
        })
      );
      const resized = await adapter.syncDocument(manager.document);
      expect(resized.warnings).toEqual([]);
      const changed = resized.bodyRepresentations[bodyId]!;
      expect(changed.faceCount).toBe(body.faceCount);
      const bore = changed.topology!.faces.find(
        (f) => f.geometry?.featureType === 'through-hole'
      )!.geometry!;
      expect(bore.diameter).toBeCloseTo(4.2, 7);
      expect(bore.axialLength).toBeCloseTo(
        wall.geometry!.axialLength! - 1.8,
        7
      );
      const carriers = (b: typeof body) =>
        b
          .topology!.faces.filter((f) => f.geometry?.surfaceType === 'cone')
          .map((f) => ({
            apex: f.geometry!.apex,
            axis: f.geometry!.axis,
            halfAngle: f.geometry!.halfAngle
          }));
      expect(carriers(changed)).toEqual(carriers(body));
      const replayed = await fresh.syncDocument(
        JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
      );
      expect(replayed.warnings).toEqual([]);
      expect(replayed.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        changed.volume,
        6
      );
      const step = await adapter.exportStep(manager.document, [bodyId]);
      expect(await adapter.inspectStep(step)).toMatchObject({
        solid: true,
        valid: true
      });
      manager.undo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          bodyId
        ]!.volume
      ).toBeCloseTo(body.volume, 6);
      manager.redo();
      expect(
        (await adapter.syncDocument(manager.document)).bodyRepresentations[
          bodyId
        ]!.volume
      ).toBeCloseTo(changed.volume, 6);
    } finally {
      adapter.dispose();
      fresh.dispose();
    }
  },
  120_000
);
