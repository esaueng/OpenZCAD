/**
 * What `massProperties` actually returns on the pinned Remus build, and how
 * far its numbers can be trusted.
 *
 * The measurement overhaul wants to publish centre of mass, inertia, and
 * principal axes — none of which this app has ever surfaced, and all of which
 * come from this one call. Two things had to be settled before any of that can
 * be built on, and neither is answerable from the typings:
 *
 * 1. The installed package declarations document `massProperties` as
 *    "Returns a JSON string"
 *    while typing it `any`. If it is a string and a consumer casts instead of
 *    parsing, every field reads `undefined` and a solid part publishes
 *    `0.00 mm^3` — a failure that renders as data rather than as an error. So
 *    the shape is pinned here, not assumed at the call site.
 *
 * 2. `massProperties.volume` is NOT a more accurate `volume`. The doc comment
 *    on the wasm side says integration "runs on the exact face geometry
 *    (analytic and NURBS surfaces, no tessellation), so there is no deflection
 *    parameter", which reads like a strict improvement on `kernel.volume`'s
 *    deflection-bounded integral. It is not one:
 *    `test/filleted-body-volume.test.ts:21-24` already refuses `mass_properties`
 *    as an oracle because it shares `integrate_face` with `solid_volume` and
 *    "their agreement is structurally blind". This file measures the agreement
 *    rather than repeating the claim in either direction.
 *
 * Everything here talks to the kernel directly rather than through
 * `syncDocument`, because the adapter does not call `massProperties` at all
 * yet — that is what the next stage adds.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/** The deflection `exact.ts` uses for every published measurement. */
const MEASUREMENT_DEFLECTION = 0.08;

let kernel: RemusKernel | null = null;

function useKernel(): RemusKernel {
  kernel ??= new RemusKernel();
  return kernel;
}

afterAll(() => {
  kernel?.free();
  kernel = null;
});

interface ParsedMassProperties {
  volume: number;
  centerOfMass: number[];
  inertia: number[];
  principalMoments: number[];
  principalAxes: number[];
}

/**
 * Calls `massProperties` the way a consumer must: parse when it is a string,
 * accept an object if the binding ever changes, and report which happened so
 * the shape itself can be asserted.
 *
 * Typed end to end on purpose. The wasm binding returns `any`, so every
 * property read downstream is unchecked unless a boundary like this one exists
 * — which is exactly the shape the adapter needs when it publishes this.
 */
function readMassProperties(solid: number): {
  raw: unknown;
  wasString: boolean;
  parsed: ParsedMassProperties;
} {
  const raw = useKernel().massProperties(solid) as unknown;
  const wasString = typeof raw === 'string';
  const parsed = (wasString ? JSON.parse(raw) : raw) as ParsedMassProperties;
  return { raw, wasString, parsed };
}

describe('massProperties, on the pinned build', () => {
  it('returns a JSON STRING, so a cast would silently publish undefined', () => {
    const solid = useKernel().makeBox(20, 20, 20);
    const { raw, wasString, parsed } = readMassProperties(solid);

    // The pin that matters. If this ever flips to an object the adapter's
    // parse step becomes dead code rather than a bug, but a consumer that
    // casts a string is broken in a way no type checker can see.
    expect(wasString).toBe(true);
    expect(typeof raw).toBe('string');

    // What casting instead of parsing would actually produce: a string has
    // no `volume`, so the published number would be `undefined` and would
    // format as 0 rather than raising.
    expect((raw as { volume?: number }).volume).toBeUndefined();

    // And the shape after parsing, field by field, since the `any` return
    // type means nothing downstream checks these.
    expect(typeof parsed.volume).toBe('number');
    expect(Array.isArray(parsed.centerOfMass)).toBe(true);
    expect(parsed.centerOfMass).toHaveLength(3);
    expect(parsed.inertia).toHaveLength(6);
    expect(parsed.principalMoments).toHaveLength(3);
    // Row-major flat 9, NOT three nested vectors — a consumer that expects
    // `principalAxes[0]` to be a vector gets a scalar.
    expect(parsed.principalAxes).toHaveLength(9);
    expect(typeof parsed.principalAxes[0]).toBe('number');
  }, 120_000);

  it('agrees with the closed form on a box, and with kernel.volume exactly', () => {
    const solid = useKernel().makeBox(20, 20, 20);
    const { parsed } = readMassProperties(solid);
    const deflected = useKernel().volume(solid, MEASUREMENT_DEFLECTION);

    // The same closed form `filleted-body-volume.test.ts:236` pins with
    // `toBe(8000)`.
    expect(parsed.volume).toBeCloseTo(8000, 9);
    // Structurally blind agreement, measured rather than assumed: on an
    // all-planar body the two integrators return the same number, so
    // publishing `massProperties.volume` as `volume` would change nothing
    // here and cannot be justified by accuracy on this shape.
    expect(parsed.volume).toBeCloseTo(deflected, 9);

    // Remus's box is corner-origin, so the centroid is the half-diagonal.
    expect(parsed.centerOfMass[0]).toBeCloseTo(10, 9);
    expect(parsed.centerOfMass[1]).toBeCloseTo(10, 9);
    expect(parsed.centerOfMass[2]).toBeCloseTo(10, 9);

    // Solid cube about its own centre, unit density: I = m*s^2/6 with m = V.
    const expected = (8000 * 400) / 6;
    for (const moment of parsed.principalMoments) {
      expect(moment).toBeCloseTo(expected, 3);
    }
    // Products of inertia vanish on the symmetry axes: [Ixx,Iyy,Izz,Ixy,Ixz,Iyz].
    expect(parsed.inertia[3]).toBeCloseTo(0, 6);
    expect(parsed.inertia[4]).toBeCloseTo(0, 6);
    expect(parsed.inertia[5]).toBeCloseTo(0, 6);
  }, 120_000);

  it('is LESS accurate than kernel.volume on a curved body, not more', () => {
    // The measurement that settles it. A cylinder is analytic and curved, so
    // this is exactly where "integrates the exact surface, no deflection"
    // should beat a deflection-bounded integral. Measured on the pinned
    // build, it loses:
    //
    //   exact  = pi * 100 * 20  = 6283.185307179586...
    //   volume                  = 6283.185307179587    rel  ~2e-16
    //   massProperties.volume   = 6283.185307180698    rel  ~1.8e-13
    //
    // Three orders of magnitude worse. That is still far inside anything a
    // user reads, but it kills the premise that `massProperties.volume` is
    // the better number: it is not, and `BodyRepresentation.volume` must
    // keep coming from `kernel.volume`, whose value is additionally pinned
    // bit-exact for analytic bodies by `test/filleted-body-volume.test.ts`.
    const solid = useKernel().makeCylinder(10, 20);
    const { parsed } = readMassProperties(solid);
    const deflected = useKernel().volume(solid, MEASUREMENT_DEFLECTION);
    const exact = Math.PI * 100 * 20;

    const massError = Math.abs(parsed.volume - exact) / exact;
    const volumeError = Math.abs(deflected - exact) / exact;

    expect(parsed.volume).toBeCloseTo(exact, 6);
    expect(massError).toBeGreaterThan(volumeError);
    // Both stay well inside display precision, so this is a provenance
    // argument rather than a correctness one.
    expect(massError).toBeLessThan(1e-11);

    // Centre of mass on the axis, half way up.
    expect(parsed.centerOfMass[0]).toBeCloseTo(0, 6);
    expect(parsed.centerOfMass[1]).toBeCloseTo(0, 6);
    expect(parsed.centerOfMass[2]).toBeCloseTo(10, 6);

    // Solid cylinder: I_axial = m*r^2/2, I_transverse = m*(3r^2 + h^2)/12.
    // At r = 10, h = 20 the axial moment is the SMALLEST of the three, since
    // axial < transverse whenever h > r*sqrt(3) ~ 17.32. Worth stating: the
    // ordering is a property of the proportions, not of the axis, so nothing
    // downstream may assume "principalMoments[2] is the spin axis" — the
    // matching row of `principalAxes` is the only way to know which is which.
    const axial = (exact * 100) / 2;
    const transverse = (exact * (3 * 100 + 400)) / 12;
    const moments = parsed.principalMoments;

    // Documented as ascending; pinned because the axis pairing depends on it.
    expect(moments[0]).toBeLessThanOrEqual(moments[1]!);
    expect(moments[1]).toBeLessThanOrEqual(moments[2]!);

    const near = (value: number, expected: number) =>
      Math.abs(value - expected) / expected;
    expect(near(moments[0]!, axial)).toBeLessThan(1e-9);
    expect(near(moments[1]!, transverse)).toBeLessThan(1e-9);
    expect(near(moments[2]!, transverse)).toBeLessThan(1e-9);
  }, 120_000);

  it('throws on a degenerate solid rather than returning zero', () => {
    // `kernel.volume` answers 0 for a shape with no volume; this call is
    // documented to error instead. That difference is the whole reason the
    // adapter must wrap it in try/catch: an exception here would otherwise
    // abort a whole document rebuild over one unmeasurable body.
    const vertex = useKernel().makeVertex(0, 0, 0);
    expect(() => {
      useKernel().massProperties(vertex);
    }).toThrow();
  }, 120_000);
});
