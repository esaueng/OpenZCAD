import { describe, expect, it } from 'vitest';

import {
  OFFSET_FACE_CARRIED_DETACHED_SUPPORT,
  detachedSupportCarry,
  detachedSupportCarryRefusal
} from './exact-offset-face-detached-carry';
import { kernelRefusalRecordOf } from './kernel-refusal';
import { RemusKernel } from './remus-runtime';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

function edgesBetween(
  kernel: RemusKernel,
  solid: number,
  keep: (a: number[], b: number[]) => boolean
): Uint32Array {
  return Uint32Array.from(
    Array.from(kernel.getSolidEdges(solid)).filter((edge) => {
      const v = kernel.getEdgeVertices(edge);
      return keep([v[0]!, v[1]!, v[2]!], [v[3]!, v[4]!, v[5]!]);
    })
  );
}

function filleted(
  kernel: RemusKernel,
  solid: number,
  edges: Uint32Array,
  radius: number
): number {
  expect(edges.length).toBeGreaterThan(0);
  const result = kernel.filletDetailed(solid, edges, radius, true);
  if (result.status !== 'ok') throw new Error(JSON.stringify(result));
  return result.value;
}

/** The planar face whose outward normal is −y and which lies on y = `y`. */
function frontFace(kernel: RemusKernel, solid: number, y = 0): number {
  const face = Array.from(kernel.getSolidFaces(solid)).find((handle) => {
    if (kernel.getSurfaceType(handle) !== 'plane') return false;
    const plane = JSON.parse(kernel.getAnalyticSurfaceParams(handle)) as {
      normal: number[];
      d: number;
    };
    return plane.normal[1]! < -0.999 && near(plane.d, -y);
  });
  expect(face).toBeDefined();
  return face!;
}

/**
 * A 30 × 18 × 24 box fused with an r6 boss on the origin, the boss's seam
 * with the box's front face rounded r1: the round, not the boss, meets the
 * front face.
 */
function filletedBoss(kernel: RemusKernel): number {
  const fused = kernel.fuse(
    kernel.makeCylinder(6, 28),
    kernel.makeBox(30, 18, 24)
  );
  return filleted(
    kernel,
    fused,
    edgesBetween(
      kernel,
      fused,
      (a, b) =>
        near(a[0]!, 6) &&
        near(a[1]!, 0) &&
        near(b[0]!, 6) &&
        near(b[1]!, 0) &&
        Math.max(a[2]!, b[2]!) < 24.5
    ),
    1
  );
}

/**
 * The smallest model found that shows the defect, built with the calls the
 * adapter makes (`fuseAll`, `unifyFacesChecked`, `filletWithEvolution`): a
 * 30 × 18 × 24 box fused with an r6, 28 tall boss on the origin, with an r1
 * round on the boss's vertical seam with the box's front face and on its arc
 * seam with the box's top. The two rounds meet, so the front face, the
 * vertical round and the torus round on the boss are one tangent chain.
 * Rounding only the vertical seam, the kernel refuses the move instead.
 */
function roundedBoss(kernel: RemusKernel): number {
  const fused = kernel.fuseAll(
    Uint32Array.of(kernel.makeCylinder(6, 28), kernel.makeBox(30, 18, 24))
  );
  // The adapter merges the union's coplanar faces before anything else.
  kernel.unifyFacesChecked(fused);
  const at = (p: number[], q: readonly number[]) =>
    near(p[0]!, q[0]!) && near(p[1]!, q[1]!) && near(p[2]!, q[2]!);
  const seams = edgesBetween(kernel, fused, (a, b) =>
    (
      [
        [
          [6, 0, 0],
          [6, 0, 24]
        ],
        [
          [0, 6, 24],
          [6, 0, 24]
        ]
      ] as const
    ).some(([p, q]) => (at(a, p) && at(b, q)) || (at(a, q) && at(b, p)))
  );
  expect(seams).toHaveLength(2);
  return kernel.filletWithEvolution(fused, seams, 1).result.solid;
}

/** The r6 boss wall's axis origin, from every face on an r6 cylinder. */
function bossOrigins(kernel: RemusKernel, solid: number): number[][] {
  return Array.from(kernel.getSolidFaces(solid)).flatMap((face) => {
    if (kernel.getSurfaceType(face) !== 'cylinder') return [];
    const record = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
      origin: number[];
      radius: number;
    };
    return near(record.radius, 6) ? [record.origin] : [];
  });
}

describe('detachedSupportCarry', () => {
  it('names a boss the move translated with the face', () => {
    const kernel = new RemusKernel();
    const source = filletedBoss(kernel);
    // What the pinned kernel returned for the user's model: the face, the
    // round and the boss all translated together.
    const output = kernel.copySolid(source);
    kernel.transformSolid(output, translation(0, -5, 0));
    const carry = detachedSupportCarry(
      kernel,
      source,
      [frontFace(kernel, source)],
      output,
      { x: 0, y: -5, z: 0 }
    );
    expect(carry).not.toBeNull();
    expect(carry!.carrier).toBe('r6 cylinder through (0, 0, 0)');
  });

  it('catches the pinned kernel carrying the boss with an offset front face', () => {
    // The kernel half of the report: Remus returns `ok` for this move with
    // the boss translated 5 mm along with the face. When this stops being
    // true, the kernel re-solves or refuses the round itself and the guard
    // is a no-op here; update the pin then.
    const kernel = new RemusKernel();
    const source = roundedBoss(kernel);
    expect(bossOrigins(kernel, source)).toEqual([[0, 0, 0]]);
    const front = frontFace(kernel, source);
    const moved = kernel.moveFacesDetailed(source, Uint32Array.of(front), 5);
    expect(moved.status).toBe('ok');
    expect(bossOrigins(kernel, moved.value!)).toEqual([[0, -5, 0]]);
    expect(
      detachedSupportCarry(kernel, source, [front], moved.value!, {
        x: 0,
        y: -5,
        z: 0
      })?.carrier
    ).toBe('r6 cylinder through (0, 0, 0)');
  });

  it('accepts a result that left the boss where it was', () => {
    const kernel = new RemusKernel();
    const source = filletedBoss(kernel);
    expect(
      detachedSupportCarry(
        kernel,
        source,
        [frontFace(kernel, source)],
        kernel.copySolid(source),
        { x: 0, y: -5, z: 0 }
      )
    ).toBeNull();
  });

  it('accepts the rounds along the face being translated with it', () => {
    // A box with every edge rounded r1: a front-face move translates the
    // rounds on its rim and the corner patches between them.
    const kernel = new RemusKernel();
    const box = kernel.makeBox(20, 10, 8);
    const source = filleted(kernel, box, kernel.getSolidEdges(box), 1);
    const front = frontFace(kernel, source);
    const moved = kernel.moveFacesDetailed(source, Uint32Array.of(front), 3);
    expect(moved.status).toBe('ok');
    // The front vertical rounds' axes moved from y = 1 to y = −2, and the
    // corner spheres' centres with them: the move did translate curved faces.
    const curvedAt = (solid: number, y: number) =>
      Array.from(kernel.getSolidFaces(solid)).filter((face) => {
        const type = kernel.getSurfaceType(face);
        if (type !== 'cylinder' && type !== 'sphere') return false;
        const record = JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
          origin?: number[];
          center?: number[];
        };
        return near((record.origin ?? record.center)![1]!, y);
      }).length;
    expect(curvedAt(source, 1)).toBeGreaterThan(0);
    expect(curvedAt(moved.value!, -2)).toBe(curvedAt(source, 1));
    expect(
      detachedSupportCarry(kernel, source, [front], moved.value!, {
        x: 0,
        y: -3,
        z: 0
      })
    ).toBeNull();
  });

  it('accepts a boss the move does not reach', () => {
    const kernel = new RemusKernel();
    const boss = kernel.makeCylinder(3, 6);
    kernel.transformSolid(boss, translation(10, 9, 8));
    const source = kernel.fuse(kernel.makeBox(20, 18, 8), boss);
    const front = frontFace(kernel, source);
    const moved = kernel.moveFacesDetailed(source, Uint32Array.of(front), 4);
    expect(moved.status).toBe('ok');
    expect(
      detachedSupportCarry(kernel, source, [front], moved.value!, {
        x: 0,
        y: -4,
        z: 0
      })
    ).toBeNull();
  });

  it('types the refusal as an unsupported offset-face direct edit', () => {
    const refusal = detachedSupportCarryRefusal(5, {
      face: 0,
      carrier: 'r6 cylinder through (0, 0, 0)'
    });
    expect(kernelRefusalRecordOf(refusal)).toEqual({
      family: 'direct-edit',
      operation: 'offset-face',
      category: 'unsupported',
      code: OFFSET_FACE_CARRIED_DETACHED_SUPPORT
    });
    expect(refusal.message.split('\n')[1]).toBe(
      'Offsetting the face by 5 translated the r6 cylinder through (0, 0, 0) with it instead of leaving it in place.'
    );
  });
});
