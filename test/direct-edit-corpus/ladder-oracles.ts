import { expect } from 'vitest';
import type {
  BodyRepresentation,
  FaceGeometry,
  FaceTopology,
  ProjectDocument,
  Vector3
} from '@openzcad/shared';

import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';
import { blendCarrierSnapshot } from '../../packages/kernel-adapter/src/exact-measure';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { census, type Session } from '../support/combination-matrix';
import { cornerVolumeChange, vec } from '../support/combination-oracle';
import type { Ladder } from './distance-ladder';
import { LADDER_SOURCE_REFUSAL_PINS } from './pins';
import {
  BOX,
  EMBED,
  POST,
  RIM,
  ROOT,
  referencePart,
  unequalCorner,
  type ReferencePart
} from './reference-parts';

export function faceCensus(body: BodyRepresentation): string[] {
  return body
    .topology!.faces.map(({ geometry }) => geometry?.surfaceType ?? 'unknown')
    .sort();
}

export function sameSnapshot(
  actual: BodyRepresentation,
  expected: BodyRepresentation
): void {
  expect(actual.volume).toBe(expected.volume);
  expect(census(actual)).toBe(census(expected));
  expect(faceCensus(actual)).toEqual(faceCensus(expected));
}

function expectVolume(actual: number, expected: number, oracleError = 0): void {
  const tolerance = Math.max(0.05, 1e-6 * Math.abs(expected), 4 * oracleError);
  expect(
    Math.abs(actual - expected),
    `volume ${actual}, oracle ${expected} ± ${tolerance}`
  ).toBeLessThanOrEqual(tolerance);
}

function integratedVolume(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>
): number {
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i]!;
    const b = 3 * indices[i + 1]!;
    const c = 3 * indices[i + 2]!;
    volume +=
      positions[a]! *
        (positions[b + 1]! * positions[c + 2]! -
          positions[b + 2]! * positions[c + 1]!) +
      positions[a + 1]! *
        (positions[b + 2]! * positions[c]! -
          positions[b]! * positions[c + 2]!) +
      positions[a + 2]! *
        (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!);
  }
  return volume / 6;
}

export async function assertSolid(
  session: Session,
  document: ProjectDocument,
  body: BodyRepresentation,
  meshOracle = false
): Promise<void> {
  expect(body.exportableStep).toBe(true);
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(
    isClosedConsistentlyOrientedMesh(closure),
    JSON.stringify(closure)
  ).toBe(true);
  const step = await session.adapter.exportStep(document, [body.bodyId]);
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const solids = [
      ...kernel.deserializeSolids(io.importStep(new TextEncoder().encode(step)))
    ];
    expect(solids).toHaveLength(1);
    const solid = solids[0]!;
    expect(kernel.validateSolid(solid)).toBe(0);
    expectVolume(kernel.volume(solid, 0.001), body.volume);
    if (meshOracle) {
      // WS1's two-resolution error estimate for a changed corner where the
      // uniform rounded-box model no longer applies. Integrate the triangles
      // directly, without calling the kernel's B-rep volume integrator.
      const measure = (deflection: number, angle: number) => {
        const mesh = kernel.tessellateSolidGroupedBinary(
          solid,
          deflection,
          angle
        );
        return integratedVolume(mesh.positions, mesh.indices);
      };
      const coarse = measure(0.01, 0.08);
      const fine = measure(0.0025, 0.04);
      expectVolume(body.volume, fine, Math.abs(fine - coarse));
    }
  } finally {
    kernel.free();
  }
}

function boxVolume(radius: number): number {
  const a = BOX.width - 2 * radius;
  const b = BOX.height - 2 * radius;
  const c = BOX.depth - 2 * radius;
  return (
    a * b * c +
    2 * radius * (a * b + b * c + c * a) +
    Math.PI * radius ** 2 * (a + b + c) +
    (4 * Math.PI * radius ** 3) / 3
  );
}

function bossVolume(radius: number, blend: number): number {
  return (
    BOX.width * BOX.height * BOX.depth +
    Math.PI * radius ** 2 * (POST.height - EMBED) +
    (blend === 0
      ? 0
      : cornerVolumeChange(
          {
            kind: 'circle',
            center: vec(BOX.width / 2, BOX.height / 2, BOX.depth),
            axis: vec(0, 0, 1),
            radius,
            d1: [1, 0],
            d2: [0, 1],
            convex: false
          },
          'fillet',
          blend
        ))
  );
}

export async function assertCylinderSourceRadius(
  session: Session,
  distance: number
): Promise<void> {
  const radius = POST.radius + distance;
  if (radius <= RIM) return;
  const source = await referencePart(session, 'D', { postRadius: radius });
  const capRadius = radius - RIM;
  const frustum =
    (Math.PI * RIM * (radius ** 2 + radius * capRadius + capRadius ** 2)) / 3;
  expectVolume(
    source.body.volume,
    Math.PI * radius ** 2 * (POST.height - 2 * RIM) + 2 * frustum
  );
  expect(faceCensus(source.body)).toEqual([
    'cone',
    'cone',
    'cylinder',
    'plane',
    'plane'
  ]);
}

function shifted(
  before: FaceGeometry,
  after: FaceGeometry,
  z: number,
  rotational: boolean
): boolean {
  return (
    before.surfaceType === after.surfaceType &&
    (rotational
      ? Math.abs(before.center.z + z - after.center.z)
      : Math.hypot(
          before.center.x - after.center.x,
          before.center.y - after.center.y,
          before.center.z + z - after.center.z
        )) < 1e-8
  );
}

function pointMatches(
  actual: Vector3 | undefined,
  before: Vector3,
  dz: number
): boolean {
  return (
    actual !== undefined &&
    Math.hypot(
      actual.x - before.x,
      actual.y - before.y,
      actual.z - before.z - dz
    ) < 1e-8
  );
}

function assertShift(
  before: FaceGeometry,
  body: BodyRepresentation,
  z: number,
  rotational: boolean
): void {
  const moved = body
    .topology!.faces.map((face) => face.geometry!)
    .filter((face) => shifted(before, face, z, rotational));
  expect(
    moved,
    `expected translated ${before.surfaceType} face at z=${before.center.z + z}`
  ).toHaveLength(1);
  expect(moved[0]!.area).toBeCloseTo(before.area, 6);
  for (const key of [
    'normal',
    'halfAngle',
    'radius',
    'majorRadius',
    'minorRadius'
  ] as const) {
    if (typeof before[key] === 'number')
      expect(moved[0]![key]).toBeCloseTo(before[key], 8);
    else expect(moved[0]![key]).toEqual(before[key]);
  }
  for (const key of ['apex', 'torusCenter'] as const) {
    const point = before[key];
    if (point) {
      expect(pointMatches(moved[0]![key], point, z)).toBe(true);
    }
  }
  if (before.axisStart && before.axisEnd) {
    const { axisStart, axisEnd } = moved[0]!;
    expect(
      (pointMatches(axisStart, before.axisStart, z) &&
        pointMatches(axisEnd, before.axisEnd, z)) ||
        (pointMatches(axisEnd, before.axisStart, z) &&
          pointMatches(axisStart, before.axisEnd, z))
    ).toBe(true);
  }
}

async function assertOffset(
  session: Session,
  part: ReferencePart,
  ladder: Ladder,
  selected: FaceTopology[],
  distance: number,
  after: BodyRepresentation
): Promise<void> {
  const before = part.body;
  expect(
    ladder.section,
    'an accepted planar edit must have a section oracle'
  ).toBeDefined();
  for (const picked of selected) {
    const face = picked.geometry!;
    const deltaZ = distance * face.normal!.z;
    // Verify the rigidly translated end group before using its section. For
    // D, this includes the cone and its apex as well as its smaller cap.
    const group = before
      .topology!.faces.map((entry) => entry.geometry!)
      .filter((geometry) => {
        const dz = Math.abs(geometry.center.z - face.center.z);
        if (ladder.part === 'C') {
          return (
            geometry === face ||
            (face.center.z === BOX.depth && geometry.surfaceType === 'torus')
          );
        }
        return dz <= RIM;
      });
    expect(group).toContain(face);
    if (ladder.part === 'D')
      expect(group.map((geometry) => geometry.surfaceType).sort()).toEqual([
        'cone',
        'plane'
      ]);
    for (const endFace of group)
      assertShift(endFace, after, deltaZ, ladder.part === 'D');
  }
  if (ladder.part === 'D') {
    // A concentric trim may start at a different azimuth after revolving.
    // Its exact circles still keep their axes, radii and the opposite end.
    const circles = after.topology!.edges.flatMap((edge) =>
      edge.curve?.circle ? [edge.curve.circle] : []
    );
    for (const [z, radius] of [
      [0, POST.radius - RIM],
      [RIM, POST.radius],
      [POST.height + distance - RIM, POST.radius],
      [POST.height + distance, POST.radius - RIM]
    ] as const) {
      expect(
        circles.filter(
          (circle) =>
            pointMatches(circle.center, { x: 0, y: 0, z }, 0) &&
            Math.abs(circle.radius - radius) < 1e-8 &&
            Math.abs(circle.axis.z) > 1 - 1e-9
        )
      ).toHaveLength(1);
    }
  }
  expectVolume(after.volume - before.volume, ladder.section! * distance);
  const depth = BOX.depth + (ladder.target === 'boss-cap' ? 0 : distance);
  // A positive overlap is enough to build the source union. Keep the boss
  // underside inside the plate even at the 0.1 mm remaining-wall step.
  const embed = ladder.part === 'C' ? Math.min(EMBED, depth / 2) : EMBED;
  const rebuild = referencePart(session, ladder.part, {
    depth,
    embed,
    postHeight:
      POST.height +
      embed -
      EMBED +
      (ladder.part === 'D' || ladder.target === 'boss-cap'
        ? distance
        : ladder.target === 'shoulder'
          ? -distance
          : 0)
  });
  const refusalPin = LADDER_SOURCE_REFUSAL_PINS.find(
    (pin) =>
      pin.distance === distance &&
      pin.targets.some((target) => target === `${ladder.part}/${ladder.target}`)
  );
  if (refusalPin) {
    await expect(rebuild).rejects.toMatchObject({
      message: refusalPin.message,
      kernelRefusal: refusalPin.kernelRefusal
    });
    return;
  }
  const source = await rebuild;
  expectVolume(after.volume, source.body.volume);
  expect(faceCensus(after)).toEqual(faceCensus(source.body));
}

export async function assertEditedShape(
  session: Session,
  part: ReferencePart,
  ladder: Ladder,
  faces: FaceTopology[],
  distance: number,
  after: BodyRepresentation,
  cornerOnly: boolean
): Promise<void> {
  if (ladder.operation === 'offset' || ladder.operation === 'offset-set') {
    return assertOffset(session, part, ladder, faces, distance, after);
  }
  const face = faces[0]!.geometry!;
  const radius =
    (ladder.operation === 'blend-radius' ? face.blendRadius! : face.radius!) +
    distance;
  const carriers = after.topology!.faces.map(({ geometry }) => geometry!);
  if (ladder.operation === 'cylinder-radius') {
    expect(
      carriers.filter(
        (geometry) =>
          geometry.surfaceType === 'cylinder' &&
          Math.abs(geometry.radius! - radius) < 1e-8
      )
    ).toHaveLength(1);
  } else if (radius === 0) {
    expect(
      carriers.filter((geometry) => geometry.featureType === 'blend')
    ).toEqual([]);
  } else if (ladder.part === 'B') {
    // The selected vertical corner sits at (r, r) after re-filleting.
    const vertical = carriers
      .map(blendCarrierSnapshot)
      .find(
        (carrier) =>
          carrier?.surfaceClass === 'cylinder' &&
          Math.abs(carrier.axis.z) > 1 - 1e-9 &&
          Math.abs(carrier.center.x - radius) < 1e-8 &&
          Math.abs(carrier.center.y - radius) < 1e-8
      );
    expect(vertical?.radius).toBeCloseTo(radius, 8);
    if (cornerOnly) {
      expect(census(after)).toBe('26f/50e');
      expect(carriers.some((geometry) => geometry.blendRadius === RIM)).toBe(
        true
      );
      const source = await unequalCorner(session, radius);
      expectVolume(after.volume, source.body.volume);
      expect(faceCensus(after)).toEqual(faceCensus(source.body));
      const bandRadii = (body: BodyRepresentation) =>
        body
          .topology!.faces.flatMap(({ geometry }) =>
            geometry?.blendRadius === undefined ? [] : [geometry.blendRadius]
          )
          .sort((a, b) => a - b);
      expect(bandRadii(after)).toEqual(
        bandRadii(source.body).map((value) => expect.closeTo(value, 8))
      );
      return;
    }
  } else {
    expect(
      carriers.filter(
        (geometry) =>
          geometry.featureType === 'blend' &&
          Math.abs(geometry.blendRadius! - radius) < 1e-8
      )
    ).toHaveLength(1);
  }
  const blend = ladder.operation === 'blend-radius' ? radius : ROOT;
  const wall = ladder.operation === 'cylinder-radius' ? radius : POST.radius;
  const expected =
    ladder.part === 'B' ? boxVolume(radius) : bossVolume(wall, blend);
  expectVolume(after.volume, expected);
  const rebuilt = await referencePart(session, ladder.part, {
    rim: radius,
    root: blend,
    postRadius: wall
  });
  expectVolume(after.volume, rebuilt.body.volume);
  expect(faceCensus(after)).toEqual(faceCensus(rebuilt.body));
}
