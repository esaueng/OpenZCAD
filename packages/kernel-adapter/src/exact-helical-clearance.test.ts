import { describe, expect, it } from 'vitest';
import {
  helicalCoilOverlap,
  type HelicalClearanceKernel
} from './exact-helical-clearance';

type Triple = readonly [number, number, number];
type Curve = (t: number) => Triple;
const TAU = 2 * Math.PI;
const Z: Triple = [0, 0, 1];
const O: Triple = [0, 0, 0];

/** A face whose edges are the given curves, each over [0, 1]. */
function faceOf(...curves: Curve[]): HelicalClearanceKernel {
  return {
    getFaceEdges: () => Uint32Array.from(curves.map((_curve, index) => index)),
    getEdgeParamSpan: () => Float64Array.of(0, 1),
    evaluateEdgeCurve: (edge: number, t: number) =>
      Float64Array.from(curves[edge]!(t)),
    getNurbsCurveData: () => JSON.stringify({ distinctKnots: [0, 1] })
  };
}

/** A circle of `radius` about `centre` in the plane of `u` and `v`. */
const circle =
  (centre: Triple, radius: number, u: Triple, v: Triple): Curve =>
  (t) => {
    const c = radius * Math.cos(TAU * t);
    const s = radius * Math.sin(TAU * t);
    return [
      centre[0] + u[0] * c + v[0] * s,
      centre[1] + u[1] * c + v[1] * s,
      centre[2] + u[2] * c + v[2] * s
    ];
  };

/** The straight sides of the polygon through `points`, each `[r, z]`, in the XZ plane. */
function polygon(points: readonly (readonly [number, number])[]): Curve[] {
  return points.map((from, index) => {
    const to = points[(index + 1) % points.length]!;
    return (t: number): Triple => [
      from[0] + (to[0] - from[0]) * t,
      0,
      from[1] + (to[1] - from[1]) * t
    ];
  });
}

/** Whether a sweep of the profile about world Z is refused, at one turn unless told. */
const refused = (
  kernel: HelicalClearanceKernel,
  pitch: number,
  turns = 1,
  origin: Triple = O,
  axis: Triple = Z
) => helicalCoilOverlap(kernel, 0, origin, axis, pitch, turns) !== null;

/** The Ø3 mm wire 12 mm out, in the plane through the axis. */
const wire = faceOf(circle([12, 0, 0], 1.5, [1, 0, 0], Z));

describe('helicalCoilOverlap', () => {
  it('refuses a full turn that does not carry a round wire clear of itself', () => {
    for (const pitch of [0.1, 2.99, 2.997, -2.997, 2.999925, 3]) {
      expect(helicalCoilOverlap(wire, 0, O, Z, pitch, 1), String(pitch)).toBe(
        `helical sweep coils would overlap: one turn carries the profile ${String(Math.abs(pitch))} along the axis, onto itself`
      );
    }
    expect(refused(wire, 2.997, 6.25)).toBe(true);
  });

  it('refuses coils that only touch, to the model tolerance', () => {
    // Two turns meeting along a curve are not a solid, and a gap under the
    // tolerance (1e-6 mm at this size) is not one the kernel can keep.
    expect(refused(wire, 3 + 1e-9)).toBe(true);
    expect(refused(wire, 3 + 5e-7)).toBe(true);
    expect(refused(wire, 3 + 2e-6)).toBe(false);
  });

  it('builds a turn with clearance', () => {
    expect(refused(wire, 3.0001)).toBe(false);
    expect(refused(wire, 3.02)).toBe(false);
    expect(refused(wire, -3.02, 40)).toBe(false);
  });

  it('asks nothing of a sweep short of a full turn, however near', () => {
    // Until the profile comes back round there is nothing for it to meet;
    // 0.99999999 of a turn is not rounded up to one.
    expect(refused(wire, 2.99, 0.999)).toBe(false);
    expect(refused(wire, 2.997, 0.99999999)).toBe(false);
    expect(refused(wire, 0.1, 0.5)).toBe(false);
    expect(refused(wire, 2.997, 1)).toBe(true);
    expect(refused(wire, 2.997, Number.NaN)).toBe(false);
  });

  it('reads the same wire on an oblique axis (#2188)', () => {
    // The wire of #2188: Ø3 mm at (27.6, 0, −11.2), its plane holding the
    // axis through (18, 0, −4) along (0.6, 0, 0.8). Read from 48 points the
    // kernel made its height 2.9938 mm and built a 2.997 mm pitch.
    const origin: Triple = [18, 0, -4];
    const axis: Triple = [0.6, 0, 0.8];
    const oblique = faceOf(circle([27.6, 0, -11.2], 1.5, [1, 0, 0], Z));
    for (const pitch of [2.99, 2.997, -2.997, 3]) {
      expect(refused(oblique, pitch, 1, origin, axis), String(pitch)).toBe(
        true
      );
    }
    expect(refused(oblique, 3.0001, 1, origin, axis)).toBe(false);
    expect(refused(oblique, -3.02, 2, origin, axis)).toBe(false);
  });

  it('finds the tallest point wherever the curves join', () => {
    // The wire as six 60° arcs. With a join 0.01 rad before the highest
    // point, that point lies on an arc a hair inside its end: a search
    // that looks for a peak between an edge's own samples never sees it,
    // and read 2.99985 mm where the wire is 3 mm tall.
    for (const lead of [0.01, 0, -0.01, 0.3, 1e-7]) {
      const arcs = Array.from({ length: 6 }, (_unused, index): Curve => {
        const from = Math.PI / 2 - lead + (index * TAU) / 6;
        return (t) => {
          const angle = from + (t * TAU) / 6;
          return [12 + 1.5 * Math.cos(angle), 0, 1.5 * Math.sin(angle)];
        };
      });
      const drawn = faceOf(...arcs);
      expect(refused(drawn, 2.999925), String(lead)).toBe(true);
      expect(refused(drawn, 3), String(lead)).toBe(true);
      expect(refused(drawn, 3.0001), String(lead)).toBe(false);
    }
  });

  it('measures a slanted ellipse along the axis, not from its lowest point to its highest', () => {
    // Semi-axes 4 × 0.5 mm, the long one turned 0.75 rad from the radial
    // direction. It stands 5.501979 mm from lowest point to highest, but a
    // turn moves it straight along the axis, and the longest line along the
    // axis inside it (through its centre) is 1.357528 mm.
    const a = 4;
    const b = 0.5;
    const tilt = 0.75;
    const ellipse = faceOf((t) => {
      const c = a * Math.cos(TAU * t);
      const s = b * Math.sin(TAU * t);
      return [
        12 + c * Math.cos(tilt) - s * Math.sin(tilt),
        0,
        c * Math.sin(tilt) + s * Math.cos(tilt)
      ];
    });
    const height = 2 * Math.hypot(a * Math.sin(tilt), b * Math.cos(tilt));
    const chord = 2 / Math.hypot(Math.sin(tilt) / a, Math.cos(tilt) / b);
    expect(height).toBeCloseTo(5.501979, 6);
    expect(chord).toBeCloseTo(1.357528, 6);
    for (const pitch of [5.500979, -5.500979, 3, 1.5, chord + 1e-4]) {
      expect(refused(ellipse, pitch), String(pitch)).toBe(false);
    }
    for (const pitch of [chord + 5e-7, chord, chord - 1e-4, -1.3, 0.2]) {
      expect(refused(ellipse, pitch), String(pitch)).toBe(true);
    }
  });

  it('reads straight sides, and a profile that nests in its own copy', () => {
    const rectangle = faceOf(
      ...polygon([
        [11, 0],
        [13, 0],
        [13, 4],
        [11, 4]
      ])
    );
    for (const pitch of [0.5, 3.9, 4, 4 + 5e-7]) {
      expect(refused(rectangle, pitch), String(pitch)).toBe(true);
    }
    expect(refused(rectangle, 4.0001)).toBe(false);
    // A chevron 1 mm thick along the axis and 6 mm tall: each turn sits in
    // the one below like stacked angle iron.
    const chevron = faceOf(
      ...polygon([
        [8, 0],
        [12, 5],
        [16, 0],
        [16, -1],
        [12, 4],
        [8, -1]
      ])
    );
    for (const pitch of [0.9, 1, -1]) {
      expect(refused(chevron, pitch), String(pitch)).toBe(true);
    }
    for (const pitch of [1.0001, 3, 5.9, -1.0001]) {
      expect(refused(chevron, pitch), String(pitch)).toBe(false);
    }
  });

  it('reads curves of many spans, with their widest place between the samples', () => {
    // A lens between two parabolas, 1.5 mm through the middle, drawn so the
    // middle falls at no round fraction of either curve's parameter.
    const along = (t: number) => -1 + 2 * t ** 1.3;
    const lens: HelicalClearanceKernel = {
      ...faceOf(
        (t) => [12 + 2 * along(t), 0, 1 - along(t) ** 2],
        (t) => [12 - 2 * along(t), 0, -0.5 * (1 - along(t) ** 2)]
      ),
      getNurbsCurveData: () =>
        JSON.stringify({ distinctKnots: [0, 0.2, 0.4, 0.6, 0.8, 1] })
    };
    for (const pitch of [1.5 - 1e-5, 1.5, 1.5 + 5e-7]) {
      expect(refused(lens, pitch), String(pitch)).toBe(true);
    }
    expect(refused(lens, 1.5001)).toBe(false);
  });

  it('is not misled by a hole', () => {
    // A tube section: the copy meets the outline whatever is cut from the
    // middle, and a hole brings no meeting of its own once the outline
    // clears.
    const outline = circle([12, 0, 0], 3, [1, 0, 0], Z);
    const hole = circle([12, 0, 0], 2, [1, 0, 0], Z);
    for (const tube of [faceOf(outline, hole), faceOf(hole, outline)]) {
      for (const pitch of [1, 4.5, 5.5, 6]) {
        expect(refused(tube, pitch), String(pitch)).toBe(true);
      }
      expect(refused(tube, 6.0001)).toBe(false);
    }
  });

  describe('a profile out of any plane through the axis', () => {
    /**
     * The longest line along `h` inside the curve's image in
     * `(r, h = z − pitch·φ/2π)`, by brute force: the image is an oval, cut
     * here by 400 lines of constant radius. `axis` is square to world X,
     * which the angle is read from.
     */
    function longestChord(curve: Curve, axis: Triple, pitch: number): number {
      const count = 20_000;
      const points = Array.from({ length: count + 1 }, (_unused, index) => {
        const p = curve(index / count);
        const z = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2];
        const radial: Triple = [
          p[0] - axis[0] * z,
          p[1] - axis[1] * z,
          p[2] - axis[2] * z
        ];
        const phi = Math.atan2(
          radial[1] * axis[2] - radial[2] * axis[1],
          radial[0]
        );
        return [Math.hypot(...radial), z - (pitch * phi) / TAU] as const;
      });
      let low = Infinity;
      let high = -Infinity;
      for (const [radius] of points) {
        low = Math.min(low, radius);
        high = Math.max(high, radius);
      }
      let longest = 0;
      for (let line = 1; line < 400; line += 1) {
        const r = low + ((high - low) * line) / 400;
        let bottom = Infinity;
        let top = -Infinity;
        for (let index = 0; index < count; index += 1) {
          const a = points[index]!;
          const b = points[index + 1]!;
          if (a[0] <= r === b[0] <= r) continue;
          const h = a[1] + ((b[1] - a[1]) * (r - a[0])) / (b[0] - a[0]);
          bottom = Math.min(bottom, h);
          top = Math.max(top, h);
        }
        longest = Math.max(longest, top - bottom);
      }
      return longest;
    }

    it('is measured by the screw, with the pitch and against it', () => {
      // A wire in the XZ plane wound about an axis leaning 30° out of that
      // plane. Its points stand at different angles about the axis, and a
      // turn carries each on by pitch × angle / 2π, so what a turn must
      // clear depends on the pitch and on its sign.
      const lean = Math.PI / 6;
      const axis: Triple = [0, Math.sin(lean), Math.cos(lean)];
      const curve = circle([12, 0, 0], 1.5, [1, 0, 0], Z);
      const leaning = faceOf(curve);
      for (const pitch of [2.3, 2.45, 2.6, 2.75, 2.9]) {
        for (const signed of [pitch, -pitch]) {
          const chord = longestChord(curve, axis, signed);
          expect(Math.abs(chord - pitch)).toBeGreaterThan(1e-3);
          expect(refused(leaning, signed, 1, O, axis), String(signed)).toBe(
            chord > pitch
          );
        }
      }
      // The two directions do part company: 2.6 mm climbs clear one way
      // and not the other.
      expect(longestChord(curve, axis, 2.6)).toBeGreaterThan(2.6);
      expect(longestChord(curve, axis, -2.6)).toBeLessThan(2.6);
      expect(refused(leaning, 2.6, 1, O, axis)).toBe(true);
      expect(refused(leaning, -2.6, 1, O, axis)).toBe(false);
    });

    it('is followed round the axis past half a turn', () => {
      // A C-shaped strip, 300° of a ring, climbing as it goes round: its
      // angle runs on through ±180° without a jump back. Climbing `rise`
      // faster than the screw per radian, its image is `rise × 300°` tall.
      const sweep = (300 / 360) * TAU;
      const pitch = 6;
      const strip = (rise: number) => {
        const climb = pitch / TAU + rise;
        const arc =
          (radius: number, from: number, to: number): Curve =>
          (t) => {
            const angle = from + (to - from) * t;
            return [
              radius * Math.cos(angle),
              radius * Math.sin(angle),
              4 + climb * angle
            ];
          };
        const end =
          (angle: number, from: number, to: number): Curve =>
          (t) => {
            const radius = from + (to - from) * t;
            return [
              radius * Math.cos(angle),
              radius * Math.sin(angle),
              4 + climb * angle
            ];
          };
        return faceOf(
          arc(10, 0, sweep),
          end(sweep, 10, 9),
          arc(9, sweep, 0),
          end(0, 9, 10)
        );
      };
      // Read with a jump at ±180° the 0.9-pitch strip would seem to span
      // 1.08 pitches and be refused.
      expect(refused(strip((0.9 * pitch) / sweep), pitch)).toBe(false);
      expect(refused(strip((1.1 * pitch) / sweep), pitch)).toBe(true);
      // Square to the axis it has no height at all, and climbs clear.
      expect(refused(strip(-pitch / TAU), pitch)).toBe(false);
    });

    it('is read the same wherever it starts, however its curves are cut and ordered', () => {
      // 338° of a ring, climbing as it goes, begun at any angle: the angle
      // is read from the first point met, and the 22° left empty is found
      // whichever edges run across ±180° from there.
      const sweep = (338 / 360) * TAU;
      const pitch = 6;
      const strip = (
        rise: number,
        start: number,
        cut: number,
        turn: number
      ) => {
        const climb = pitch / TAU + rise;
        const at = (radius: number, angle: number): Triple => [
          radius * Math.cos(start + angle),
          radius * Math.sin(start + angle),
          4 + climb * angle
        ];
        const arc =
          (radius: number, from: number, to: number): Curve =>
          (t) =>
            at(radius, from + (to - from) * t);
        const end =
          (angle: number, from: number, to: number): Curve =>
          (t) =>
            at(from + (to - from) * t, angle);
        const edges = [
          arc(10, 0, cut * sweep),
          arc(10, cut * sweep, sweep),
          end(sweep, 10, 9),
          arc(9, sweep, cut * sweep),
          arc(9, cut * sweep, 0),
          end(0, 9, 10)
        ];
        return faceOf(...edges.slice(turn), ...edges.slice(0, turn));
      };
      for (const start of [0, 1, 2.5, 3.1, 4.4, 5.9]) {
        for (const cut of [0.03, 0.5, 0.97]) {
          for (let turn = 0; turn < 6; turn += 1) {
            const name = `${String(start)} ${String(cut)} ${String(turn)}`;
            expect(
              refused(strip((0.9 * pitch) / sweep, start, cut, turn), pitch),
              name
            ).toBe(false);
            expect(
              refused(strip((1.1 * pitch) / sweep, start, cut, turn), pitch),
              name
            ).toBe(true);
          }
        }
      }
    });
  });

  it('settles a wire in a bounded number of readings', () => {
    let readings = 0;
    const counted: HelicalClearanceKernel = {
      ...wire,
      evaluateEdgeCurve: (edge, t) => {
        readings += 1;
        return wire.evaluateEdgeCurve(edge, t);
      }
    };
    for (const pitch of [2.997, 3, 3 + 2e-6, 3.02]) {
      readings = 0;
      helicalCoilOverlap(counted, 0, O, Z, pitch, 1);
      expect(readings, String(pitch)).toBeLessThan(2000);
    }
  });

  it('answers nothing for a profile it cannot read, leaving the kernel to refuse', () => {
    // Touching the axis, where the angle has no value.
    const onAxis = circle([1.5, 0, 0], 1.5, [1, 0, 0], Z);
    expect(helicalCoilOverlap(faceOf(onAxis), 0, O, Z, 0.5, 1)).toBeNull();
    // Round the axis, which leaves no side of it empty.
    const round = circle([0, 0, 0], 5, [1, 0, 0], [0, 1, 0]);
    expect(helicalCoilOverlap(faceOf(round), 0, O, Z, 0.5, 1)).toBeNull();
    expect(helicalCoilOverlap(faceOf(), 0, O, Z, 0.5, 1)).toBeNull();
    const broken: HelicalClearanceKernel = {
      ...wire,
      getFaceEdges: () => {
        throw new Error('invalid face handle');
      }
    };
    expect(helicalCoilOverlap(broken, 0, O, Z, 0.5, 1)).toBeNull();
    const torn: HelicalClearanceKernel = {
      ...wire,
      evaluateEdgeCurve: (edge, t) =>
        t > 0.4 && t < 0.41
          ? Float64Array.of(Number.NaN, 0, 0)
          : wire.evaluateEdgeCurve(edge, t)
    };
    expect(helicalCoilOverlap(torn, 0, O, Z, 2.997, 1)).toBeNull();
  });
});
