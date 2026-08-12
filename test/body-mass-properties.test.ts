import { afterAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Mass properties as the app actually publishes them, against closed forms.
 *
 * Every expectation here is written out from the geometry rather than read
 * back from the kernel, for the same reason `filleted-body-volume.test.ts`
 * refuses `mass_properties` as an oracle: two numbers from one integrator
 * agreeing proves nothing about either.
 */

let adapter: ExactKernelAdapter | null = null;

afterAll(() => {
  adapter?.dispose();
  adapter = null;
});

async function bodyOf(document: ProjectDocument): Promise<BodyRepresentation> {
  adapter ??= await createExactKernelAdapter();
  const derived = await adapter.syncDocument(document);
  return derived.bodyRepresentations[document.bodyOrder.at(-1)!]!;
}

function primitive(
  primitiveKind: 'box' | 'cylinder' | 'sphere',
  dimensions: Record<string, number>
): ProjectDocument {
  let doc = createProjectDocument('P', toUserId('user_mass'));
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

describe('a box', () => {
  it('reports its centroid at the half-diagonal, not at the origin', async () => {
    // BrepKit builds boxes corner-at-origin, so a centre of mass at (0,0,0)
    // would mean the field is unset rather than measured.
    const body = await bodyOf(
      primitive('box', { width: 20, height: 20, depth: 20 })
    );
    const mass = body.massProperties;
    expect(mass).toBeDefined();
    expect(mass!.centerOfMass.x).toBeCloseTo(10, 9);
    expect(mass!.centerOfMass.y).toBeCloseTo(10, 9);
    expect(mass!.centerOfMass.z).toBeCloseTo(10, 9);
  }, 120_000);

  it('reports the cube moment m*s^2/6 on all three axes', async () => {
    const body = await bodyOf(
      primitive('box', { width: 20, height: 20, depth: 20 })
    );
    const mass = body.massProperties!;
    const expected = (8000 * 400) / 6;
    for (const moment of mass.principalMoments) {
      expect(near(moment, expected)).toBeLessThan(1e-9);
    }
    // Products of inertia vanish on the symmetry axes.
    expect(Math.abs(mass.inertia[3])).toBeLessThan(1e-6);
    expect(Math.abs(mass.inertia[4])).toBeLessThan(1e-6);
    expect(Math.abs(mass.inertia[5])).toBeLessThan(1e-6);
  }, 120_000);
});

describe('a cylinder', () => {
  it('puts the spin axis FIRST when it is taller than r*sqrt(3)', async () => {
    // The ordering is a property of the proportions, not of the axis: axial
    // beats transverse only while h < r*sqrt(3) ~ 17.32. At r=10, h=20 the
    // smallest moment is the axial one, so nothing downstream may assume
    // `principalMoments[2]` is the spin axis. Pinned because that assumption
    // is the natural one to make and it is wrong here.
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    const mass = body.massProperties!;
    const volume = Math.PI * 100 * 20;
    const axial = (volume * 100) / 2;
    const transverse = (volume * (3 * 100 + 400)) / 12;

    expect(axial).toBeLessThan(transverse);
    expect(near(mass.principalMoments[0], axial)).toBeLessThan(1e-9);
    expect(near(mass.principalMoments[1], transverse)).toBeLessThan(1e-9);
    expect(near(mass.principalMoments[2], transverse)).toBeLessThan(1e-9);

    // Ascending, which is what makes pairing an axis with its moment work.
    expect(mass.principalMoments[0]).toBeLessThanOrEqual(
      mass.principalMoments[1]
    );
    expect(mass.principalMoments[1]).toBeLessThanOrEqual(
      mass.principalMoments[2]
    );
  }, 120_000);

  it('gives each moment an axis of unit length', async () => {
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    const mass = body.massProperties!;
    expect(mass.principalAxes).toHaveLength(3);
    for (const axis of mass.principalAxes) {
      expect(near(Math.hypot(axis.x, axis.y, axis.z), 1)).toBeLessThan(1e-9);
    }
    // The axis belonging to the axial moment is the cylinder's own axis, and
    // it is the FIRST one here — the pairing, not the position, is what
    // identifies it.
    const spin = mass.principalAxes[0];
    expect(Math.abs(spin.z)).toBeCloseTo(1, 6);
  }, 120_000);
});

describe('a sphere', () => {
  it('reports 2/5 m r^2 on every axis', async () => {
    const body = await bodyOf(primitive('sphere', { radius: 10 }));
    const mass = body.massProperties!;
    const volume = (4 / 3) * Math.PI * 1000;
    const expected = 0.4 * volume * 100;
    for (const moment of mass.principalMoments) {
      expect(near(moment, expected)).toBeLessThan(1e-6);
    }
  }, 120_000);
});

describe('what is deliberately absent', () => {
  it('publishes no volume beside the moments', async () => {
    // The kernel's integrator returns one, and it is LESS accurate than
    // `BodyRepresentation.volume` — 1.8e-13 against 2e-16 on a cylinder.
    // Publishing both would invite a consumer to pick the wrong one for
    // `mass = density * volume`, so only the better one is reachable.
    const body = await bodyOf(
      primitive('cylinder', { radius: 10, height: 20 })
    );
    expect(body.volume).toBe(Math.PI * 100 * 20);
    expect(
      (body.massProperties as unknown as Record<string, unknown>).volume
    ).toBeUndefined();
  }, 120_000);
});
