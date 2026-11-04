import { describe, expect, it } from 'vitest';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { resizeThroughHole } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { requireThroughHole } from '../packages/kernel-adapter/src/exact-measure';
import { applyEdgeModifier } from '../packages/kernel-adapter/src/exact-edge-modifiers';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import { steppedArena } from './support/stepped-chamfered-cylinder';
import { readFileSync } from 'node:fs';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import { borePreviewProfile } from '../apps/web/src/lib/interaction/cylinderRadius';
import { drillHole } from '../packages/kernel-adapter/src/exact-cylinder-ops';
import { syntheticHolderSolid } from './support/synthetic-holder';
import { resizeChamferedThroughHole } from '../packages/kernel-adapter/src/exact-chamfered-hole';

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
  const depth = Math.max(0, mouthRadius - radius);
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
  it('requires a boolean when enlargement reaches an unrelated blind bore', () => {
    const kernel = new RemusKernel();
    try {
      const other = kernel.copyAndTransformSolid(
        kernel.makeCylinder(1, 5),
        new Float64Array([1, 0, 0, 19.2, 0, 1, 0, 15, 0, 0, 1, 0, 0, 0, 0, 1])
      );
      const solid = kernel.cut(chamferedPlate(kernel, 1), other);
      expect(kernel.validateSolid(solid)).toBe(0);
      const face = [...kernel.getSolidFaces(solid)].find((f) => {
        if (kernel.getSurfaceType(f) !== 'cylinder') return false;
        const params = JSON.parse(kernel.getAnalyticSurfaceParams(f)) as {
          radius: number;
        };
        return Math.abs(params.radius - BORE) < 1e-7;
      })!;
      const geometry = requireThroughHole(kernel, solid, face);
      const before = kernel.serializeSolids(Uint32Array.of(solid));
      // The neighbouring void starts 3.2 mm from this bore's axis. A new
      // radius of 3.5 must split its wall, which a local ring move cannot do.
      expect(() =>
        resizeChamferedThroughHole(kernel, solid, face, geometry, 3.5, 1e-5)
      ).toThrow(/chamfer cannot be rebuilt exactly/);
      expect(kernel.serializeSolids(Uint32Array.of(solid))).toEqual(before);
    } finally {
      kernel.free();
    }
  });

  it.each(
    (['native', 'STEP'] as const).flatMap((source) =>
      ([1, 2] as const).flatMap((mouths) =>
        [6, 7, 7.8, 8.2, 10.4].map(
          (diameter) => [source, mouths, diameter] as const
        )
      )
    )
  )(
    'rejoins %s bore with %i chamfered mouth(s) when it grows to diameter %s',
    async (sourceKind, mouths, diameter) => {
      await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        let original = chamferedPlate(kernel, mouths);
        if (sourceKind === 'STEP') {
          original = kernel.deserializeSolids(
            remusTranslators().importStep(
              remusTranslators().exportStep(
                kernel.serializeSolids(Uint32Array.of(original))
              )
            )
          )[0]!;
        }
        const shrunk = resize(kernel, original, 4.6);
        const source = kernel.serializeSolids(Uint32Array.of(shrunk));
        const enlarged = resize(kernel, shrunk, diameter);
        expect(kernel.validateSolid(enlarged)).toBe(0);
        expect(kernel.volume(enlarged, 1e-5)).toBeCloseTo(
          volume(diameter / 2, mouths),
          4
        );
        const counts: Record<string, number> = {};
        for (const face of kernel.getSolidFaces(enlarged)) {
          const type = kernel.getSurfaceType(face);
          counts[type] = (counts[type] ?? 0) + 1;
        }
        const retainedMouths = diameter < 2 * (BORE + 1) ? mouths : 0;
        // No cutter-cap shelf, old bore sleeve, or pocket beneath the cone.
        expect(counts).toEqual({
          plane: 6,
          cylinder: 1,
          ...(retainedMouths ? { cone: retainedMouths } : {})
        });
        const wall = [...kernel.getSolidFaces(enlarged)].find(
          (face) => kernel.getSurfaceType(face) === 'cylinder'
        )!;
        const bore = requireThroughHole(kernel, enlarged, wall);
        expect(bore.diameter).toBeCloseTo(diameter, 7);
        expect(bore.axialLength).toBeCloseTo(
          HEIGHT - mouths * Math.max(0, BORE + 1 - diameter / 2),
          7
        );
        const quality = JSON.parse(
          kernel.meshQuality(enlarged, 0.01) as string
        ) as {
          isWatertight: boolean;
        };
        expect(quality.isWatertight).toBe(true);
        const [roundtrip] = kernel.deserializeSolids(
          remusTranslators().importStep(
            remusTranslators().exportStep(
              kernel.serializeSolids(Uint32Array.of(enlarged))
            )
          )
        );
        expect(roundtrip).toBeDefined();
        expect(kernel.validateSolid(roundtrip!)).toBe(0);
        expect(kernel.volume(roundtrip!, 1e-5)).toBeCloseTo(
          volume(diameter / 2, mouths),
          4
        );
        expect(kernel.serializeSolids(Uint32Array.of(shrunk))).toEqual(source);
      } finally {
        kernel.free();
      }
    }
  );

  it.each([1, 2] as const)(
    'refuses exact outer-rim coincidence on %i mouth(s) without changing the source',
    (mouths) => {
      const kernel = new RemusKernel();
      try {
        const shrunk = resize(kernel, chamferedPlate(kernel, mouths), 4.6);
        const before = kernel.serializeSolids(Uint32Array.of(shrunk));
        // The pin refuses the zero-height cone at exact coincidence. Keep
        // that explicit refusal rather than accepting the old short pocket
        // or nudging the requested diameter/tolerance to make a cut pass.
        expect(() => resize(kernel, shrunk, 8)).toThrow(
          /Through-hole diameter 8 does not fit this body: .*could not be cut exactly/
        );
        expect(kernel.serializeSolids(Uint32Array.of(shrunk))).toEqual(before);
        expect(kernel.validateSolid(shrunk)).toBe(0);
      } finally {
        kernel.free();
      }
    }
  );

  it.each(['native', 'STEP'] as const)(
    'shrinks both broken-out countersinks and split rims from %s without moving retained boundaries',
    async (sourceKind) => {
      await loadRemusTranslators();
      const kernel = new RemusKernel();
      try {
        let solid = syntheticHolderSolid(kernel);
        if (sourceKind === 'STEP') {
          solid = kernel.deserializeSolids(
            remusTranslators().importStep(
              remusTranslators().exportStep(
                kernel.serializeSolids(Uint32Array.of(solid))
              )
            )
          )[0]!;
        }
        const volumeBefore = kernel.volume(solid, 1e-5);
        // The cone apex is z=20-4.5=15.5. Only material inside the old
        // Ø5 bore changes; the broken-out mouth beyond the 8 mm arm stays
        // fixed. Integrate 2πρ(15.5+ρ) from new r=2 to old R=2.5.
        const addedPerHole =
          Math.PI * 15.5 * (2.5 ** 2 - 2 ** 2) +
          ((2 * Math.PI) / 3) * (2.5 ** 3 - 2 ** 3);
        for (const [index, x] of [4, 56].entries()) {
          const face = [...kernel.getSolidFaces(solid)].find((f) => {
            if (kernel.getSurfaceType(f) !== 'cylinder') return false;
            const params = JSON.parse(kernel.getAnalyticSurfaceParams(f)) as {
              origin: number[];
            };
            return Math.abs(params.origin[0]! - x) < 1e-7;
          })!;
          expect(face).toBeDefined();
          const geometry = requireThroughHole(kernel, solid, face);
          const source = kernel.serializeSolids(Uint32Array.of(solid));
          const before = steppedArena(kernel, solid);
          if (x === 56) {
            const splitRim = before.edges.filter(
              (e) =>
                e.curve !== 'Line' &&
                e.curve.Circle &&
                Math.abs(e.curve.Circle.center[0] - x) < 1e-7 &&
                Math.abs(e.curve.Circle.center[2] - 18) < 1e-7 &&
                Math.abs(e.curve.Circle.radius - 2.5) < 1e-7
            );
            if (sourceKind === 'native') expect(splitRim).toHaveLength(4);
            else expect(splitRim).toHaveLength(1);
          }
          const output = resizeThroughHole(
            kernel,
            solid,
            face,
            {
              kind: 'resize-through-hole',
              faceHash: 0,
              sourceDiameter: geometry.diameter,
              sourceAxisStart: geometry.axisStart,
              sourceAxisEnd: geometry.axisEnd,
              diameter: 4
            },
            {}
          ).solid;
          expect(kernel.validateSolid(output)).toBe(0);
          expect(kernel.volume(output, 1e-5)).toBeCloseTo(
            volumeBefore + (index + 1) * addedPerHole,
            4
          );
          const after = steppedArena(kernel, output);
          expect(after.wires).toEqual(before.wires);
          expect(after.boundary_authority).toEqual(before.boundary_authority);
          before.faces.forEach((f, i) => {
            const cylinder = f.surface.Cylinder as
              { origin: number[]; radius: number } | undefined;
            if (cylinder && Math.abs(cylinder.origin[0]! - x) < 1e-7)
              expect(after.faces[i]).toEqual({
                ...f,
                surface: { Cylinder: { ...cylinder, radius: 2 } }
              });
            else expect(after.faces[i]).toEqual(f);
          });
          before.edges.forEach((e, i) => {
            if (e.curve !== 'Line' && 'NurbsCurve' in e.curve)
              expect(after.edges[i]).toEqual(e);
          });
          expect(kernel.serializeSolids(Uint32Array.of(solid))).toEqual(source);
          solid = output;
        }
        const [roundtrip] = kernel.deserializeSolids(
          remusTranslators().importStep(
            remusTranslators().exportStep(
              kernel.serializeSolids(Uint32Array.of(solid))
            )
          )
        );
        expect(roundtrip).toBeDefined();
        expect(kernel.validateSolid(roundtrip!)).toBe(0);
        expect(kernel.volume(roundtrip!, 1e-5)).toBeCloseTo(
          volumeBefore + 2 * addedPerHole,
          4
        );
        const quality = JSON.parse(
          kernel.meshQuality(roundtrip!, 0.01) as string
        ) as { isWatertight: boolean };
        expect(quality.isWatertight).toBe(true);
      } finally {
        kernel.free();
      }
    }
  );

  it.each([4, 3.6])(
    'shrinks a countersink broken out through both sides to diameter %s with unchanged outer trims',
    (diameter) => {
      const kernel = new RemusKernel();
      try {
        const solid = drillHole(kernel, kernel.makeBox(8, 30, 20), {
          surfacePoint: { x: 4, y: 15, z: 20 },
          axis: { x: 0, y: 0, z: -1 },
          radius: 2.5,
          depth: 20,
          entryExtension: 0.2,
          exitExtension: 0.2,
          style: 'countersink',
          countersinkRadius: 4.5,
          countersinkAngle: Math.PI / 2
        });
        expect(kernel.validateSolid(solid)).toBe(0);
        const sourceBytes = kernel.serializeSolids(Uint32Array.of(solid));
        const before = steppedArena(kernel, solid);
        const oldVolume = kernel.volume(solid, 1e-5);
        const resized = resize(kernel, solid, diameter);
        const radius = diameter / 2;
        const added =
          Math.PI * (2.5 ** 2 - radius ** 2) * 18 -
          (Math.PI * (2.5 - radius) ** 2 * (2.5 + 2 * radius)) / 3;
        expect(kernel.validateSolid(resized)).toBe(0);
        expect(kernel.volume(resized, 1e-5) - oldVolume).toBeCloseTo(added, 6);
        const after = steppedArena(kernel, resized);
        expect(after.faces).toHaveLength(before.faces.length);
        for (const [i, face] of before.faces.entries()) {
          expect(after.faces[i]).toEqual(
            face.surface.Cylinder
              ? {
                  ...face,
                  surface: { Cylinder: { ...face.surface.Cylinder, radius } }
                }
              : face
          );
        }
        expect(after.wires).toEqual(before.wires);
        expect(after.boundary_authority).toEqual(before.boundary_authority);
        const moved = new Set(
          before.vertices.flatMap((vertex, i) =>
            JSON.stringify(vertex) === JSON.stringify(after.vertices[i])
              ? []
              : [i]
          )
        );
        for (const [i, edge] of before.edges.entries())
          if (!moved.has(edge.start) && !moved.has(edge.end))
            expect(after.edges[i]).toEqual(edge);
        expect(kernel.serializeSolids(Uint32Array.of(solid))).toEqual(
          sourceBytes
        );
      } finally {
        kernel.free();
      }
    }
  );

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
        const restored = resize(kernel, resized, 6);
        expect(kernel.validateSolid(restored)).toBe(0);
        expect(kernel.volume(restored, 1e-5)).toBeCloseTo(
          kernel.volume(transformed, 1e-5),
          4
        );
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
      expect(
        borePreviewProfile(body, {
          axisStart: wall.geometry!.axisStart!,
          axisEnd: wall.geometry!.axisEnd!,
          radius: wall.geometry!.radius!
        })
      ).toBeNull();
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
      const preview = await adapter.previewGeometry(manager.document);
      expect(preview.warnings).toEqual([]);
      const previewBody = preview.bodyRepresentations[bodyId]!;
      for (const face of previewBody.topology!.faces.filter(
        (f) => f.geometry?.surfaceType === 'cone'
      )) {
        const { apex, axis } = face.geometry!;
        for (
          let t = face.triangleStart;
          t < face.triangleStart + face.triangleCount;
          t++
        ) {
          for (let corner = 0; corner < 3; corner++) {
            const v = previewBody.mesh.indices[t * 3 + corner]! * 3;
            const x = previewBody.mesh.vertices[v]! - apex!.x;
            const y = previewBody.mesh.vertices[v + 1]! - apex!.y;
            const z = previewBody.mesh.vertices[v + 2]! - apex!.z;
            const axial = x * axis!.x + y * axis!.y + z * axis!.z;
            const radial = Math.hypot(
              x - axial * axis!.x,
              y - axial * axis!.y,
              z - axial * axis!.z
            );
            expect(Math.abs(axial)).toBeCloseTo(radial, 4);
          }
        }
      }
      const resized = await adapter.syncDocument(manager.document);
      expect(resized.warnings).toEqual([]);
      const changed = resized.bodyRepresentations[bodyId]!;
      expect(changed.mesh).toEqual(previewBody.mesh);
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
