import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type UnitSystem } from '@openzcad/shared';
import type { BodyMassProperties, ProjectDocument } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * The full inertia tensor and principal axes against closed forms (F02).
 *
 * `test/body-mass-properties.test.ts` pins the centroid and the principal
 * moments; this file pins the other two thirds of the same kernel answer —
 * the six-component tensor about the centre of mass in model axes, and the
 * three directions the moments belong to. Every expectation is written out
 * from the geometry, never read back from the kernel, and the tensor, the
 * moments and the axes are tied together by the eigen-identity
 * T = R·diag(λ)·Rᵀ so the three cannot drift apart unnoticed.
 */

let adapter: ExactKernelAdapter | null = null;

afterAll(() => {
  adapter?.dispose();
  adapter = null;
});

async function massOf(document: ProjectDocument): Promise<BodyMassProperties> {
  adapter ??= await createExactKernelAdapter();
  await adapter.syncDocument(document);
  const bodyId = document.bodyOrder.at(-1)!;
  const result = adapter.readCurrentMassProperties({
    projectId: document.projectId,
    version: document.version,
    bodyId,
    epoch: adapter.currentMassPropertiesEpoch()!
  });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.reason);
  return result.properties;
}

function primitive(
  primitiveKind: 'box' | 'cylinder',
  dimensions: Record<string, number>,
  units: UnitSystem = 'mm'
): ProjectDocument {
  let doc = createProjectDocument('P', toUserId('user_inertia'), units);
  doc = addPrimitiveFeature(doc, {
    name: primitiveKind,
    primitiveKind,
    dimensions
  });
  return doc;
}

/** Relative closeness, so a tolerance means the same at every scale. */
function near(value: number, expected: number): number {
  return Math.abs(value - expected) / Math.abs(expected);
}

/**
 * Rebuilds the symmetric tensor from its eigen-answer and checks it against
 * the published six. `axes[k]` is the k-th column of R, paired with
 * `moments[k]` — the pairing the type contract promises.
 */
function expectEigenConsistent(mass: BodyMassProperties): void {
  const [iXX, iYY, iZZ, iXY, iXZ, iYZ] = mass.inertia;
  const tensor = [
    [iXX, iXY, iXZ],
    [iXY, iYY, iYZ],
    [iXZ, iYZ, iZZ]
  ];
  const axes = mass.principalAxes.map((axis) => [axis.x, axis.y, axis.z]);
  for (let row = 0; row < 3; row += 1) {
    for (let column = row; column < 3; column += 1) {
      let rebuilt = 0;
      for (let k = 0; k < 3; k += 1) {
        rebuilt +=
          mass.principalMoments[k]! * axes[k]![row]! * axes[k]![column]!;
      }
      const published = tensor[row]![column]!;
      const scale = Math.max(Math.abs(iXX), Math.abs(iYY), Math.abs(iZZ), 1);
      expect(
        Math.abs(rebuilt - published) / scale,
        `tensor[${row}][${column}]`
      ).toBeLessThan(1e-9);
    }
  }
}

function expectOrthonormalAxes(mass: BodyMassProperties): void {
  const axes = mass.principalAxes.map((axis) => [axis.x, axis.y, axis.z]);
  for (const [index, axis] of axes.entries()) {
    expect(
      near(Math.hypot(axis[0]!, axis[1]!, axis[2]!), 1),
      `axis ${index} unit length`
    ).toBeLessThan(1e-9);
  }
  for (const [left, right] of [
    [0, 1],
    [0, 2],
    [1, 2]
  ] as const) {
    const dot =
      axes[left]![0]! * axes[right]![0]! +
      axes[left]![1]! * axes[right]![1]! +
      axes[left]![2]! * axes[right]![2]!;
    expect(Math.abs(dot), `axes ${left}·${right}`).toBeLessThan(1e-9);
  }
}

describe('a box tensor', () => {
  it('matches I = m(b²+c²)/12 on the diagonal with vanishing products', async () => {
    // 20 × 10 × 4 about its own centre, unit density so m = V = 800.
    const mass = await massOf(
      primitive('box', { width: 20, height: 10, depth: 4 })
    );
    const volume = 800;
    const expected = {
      iXX: (volume * (10 ** 2 + 4 ** 2)) / 12,
      iYY: (volume * (20 ** 2 + 4 ** 2)) / 12,
      iZZ: (volume * (20 ** 2 + 10 ** 2)) / 12
    };
    expect(near(mass.inertia[0], expected.iXX)).toBeLessThan(1e-9);
    expect(near(mass.inertia[1], expected.iYY)).toBeLessThan(1e-9);
    expect(near(mass.inertia[2], expected.iZZ)).toBeLessThan(1e-9);
    const trace = expected.iXX + expected.iYY + expected.iZZ;
    for (const product of mass.inertia.slice(3)) {
      expect(Math.abs(product) / trace).toBeLessThan(1e-9);
    }
  }, 120_000);

  it('has the model axes as its principal axes, paired smallest-to-x', async () => {
    // Distinct side lengths so each eigen-direction is determined up to sign:
    // Ixx < Iyy < Izz, hence axis 0 is ±X, axis 1 ±Y, axis 2 ±Z. The sign of
    // an eigenvector is arbitrary, so only the absolute components are pinned.
    const mass = await massOf(
      primitive('box', { width: 20, height: 10, depth: 4 })
    );
    const [xAxis, yAxis, zAxis] = mass.principalAxes;
    for (const [axis, component] of [
      [xAxis, 'x'],
      [yAxis, 'y'],
      [zAxis, 'z']
    ] as const) {
      expect(Math.abs(axis[component])).toBeCloseTo(1, 6);
      for (const other of ['x', 'y', 'z'] as const) {
        if (other !== component) {
          expect(Math.abs(axis[other])).toBeLessThan(1e-6);
        }
      }
    }
    expectOrthonormalAxes(mass);
    expectEigenConsistent(mass);
  }, 120_000);

  it('reads the same closed form in an inch document', async () => {
    // The kernel integrates in document units: a 1 × 2 × 3 inch box has
    // volume 6 in³ and the same textbook tensor in in⁵, not a conversion of
    // the millimetre answer. SI conversion is the display layer's job.
    const mass = await massOf(
      primitive('box', { width: 1, height: 2, depth: 3 }, 'inch')
    );
    const volume = 6;
    expect(
      near(mass.inertia[0], (volume * (2 ** 2 + 3 ** 2)) / 12)
    ).toBeLessThan(1e-9);
    expect(
      near(mass.inertia[1], (volume * (1 ** 2 + 3 ** 2)) / 12)
    ).toBeLessThan(1e-9);
    expect(
      near(mass.inertia[2], (volume * (1 ** 2 + 2 ** 2)) / 12)
    ).toBeLessThan(1e-9);
    expectEigenConsistent(mass);
  }, 120_000);
});

describe('a cylinder tensor', () => {
  it('matches axial m·r²/2 and transverse m·(3r²+h²)/12', async () => {
    // r = 10, h = 20 about its own centre; the cylinder stands on Z.
    const mass = await massOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    const volume = Math.PI * 100 * 20;
    const axial = (volume * 100) / 2;
    const transverse = (volume * (3 * 100 + 400)) / 12;
    expect(near(mass.inertia[0], transverse)).toBeLessThan(1e-9);
    expect(near(mass.inertia[1], transverse)).toBeLessThan(1e-9);
    expect(near(mass.inertia[2], axial)).toBeLessThan(1e-9);
    const trace = 2 * transverse + axial;
    for (const product of mass.inertia.slice(3)) {
      expect(Math.abs(product) / trace).toBeLessThan(1e-9);
    }
  }, 120_000);

  it('pairs the axial moment with the cylinder axis; the transverse pair stays orthonormal', async () => {
    // The two transverse moments are EQUAL, so their directions are
    // degenerate: any orthonormal pair across the axis is a correct answer,
    // and pinning one would pin eigensolver internals rather than geometry.
    const mass = await massOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    expect(Math.abs(mass.principalAxes[0].z)).toBeCloseTo(1, 6);
    expectOrthonormalAxes(mass);
    expectEigenConsistent(mass);
  }, 120_000);
});

describe('tensor, moments and axes agree', () => {
  it('rebuilds the tensor from every body the suite measures', async () => {
    for (const document of [
      primitive('box', { width: 20, height: 20, depth: 20 }),
      primitive('box', { width: 20, height: 10, depth: 4 }),
      primitive('cylinder', { radius: 10, height: 20 })
    ]) {
      expectEigenConsistent(await massOf(document));
    }
  }, 180_000);
});
