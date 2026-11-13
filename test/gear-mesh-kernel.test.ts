import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  axisAngleQuaternion,
  type GearMeshGear,
  type RigidTransform
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  createGearMeshProbe,
  DEG,
  gear,
  solved
} from './support/gearMeshKernel';

/**
 * M14 meshing-pair helper against the kernel's own teeth, the slow cases
 * (full suite; `gear-mesh.test.ts` keeps the fast ones in CI smoke): spur
 * play and tightness, a pinion in its ring, an opposite-hand helical pair,
 * and single-helix and herringbone pairs turned end for end, each built by
 * Remus where the helper puts it and sampled on a grid across the pitch
 * point.
 */
const X = { x: 1, y: 0, z: 0 };

describe(
  'meshed pairs on the exact kernel, sampled',
  { timeout: 120_000 },
  () => {
    let kernel: RemusKernel;
    beforeAll(() => {
      kernel = new RemusKernel();
    });
    afterAll(() => kernel.free());
    const { build, overlap, pitchPoint } = createGearMeshProbe(() => kernel);

    it('interleaves an external spur pair with its play and no more', () => {
      const a = gear({ backlash: 0.1, phaseDeg: 5 });
      const b = gear({ teeth: 31, backlash: 0.1, profileShift: 0.25 });
      const mesh = solved(a, b);
      const { p, tangent, normal } = pitchPoint(a, mesh);
      const sa = build(a, a.frame);
      const pitch = 2 * Math.PI;
      const at = (turnMm: number) =>
        overlap(
          sa,
          build(b, mesh.frame, (turnMm / (31 * 1)) * (180 / Math.PI)),
          p,
          tangent,
          normal,
          pitch,
          2,
          [2.5]
        );
      const meshed = at(0);
      expect(meshed.both).toBe(0);
      // Both gears' teeth are on the grid: the pair is in mesh, not apart.
      expect(meshed.first).toBeGreaterThan(40);
      expect(meshed.second).toBeGreaterThan(40);
      // Turned past half the 0.2 play either way, the teeth collide: the
      // centres are no further apart than the working distance.
      expect(at(0.35).both).toBeGreaterThan(0);
      expect(at(-0.35).both).toBeGreaterThan(0);
      // Half a pitch out, tooth meets tooth.
      expect(at(pitch / 2).both).toBeGreaterThan(20);
    });

    it('interleaves an opposite-hand helical pair across the face', () => {
      const a = gear({ helixAngleDeg: 20, phaseDeg: 2 });
      const b = gear({
        teeth: 27,
        helixAngleDeg: 20,
        hand: 'left',
        backlash: 0.1
      });
      const mesh = solved(a, b);
      const { p, tangent, normal } = pitchPoint(a, mesh);
      const sa = build(a, a.frame);
      const pitch = (2 * Math.PI) / Math.cos(20 * DEG);
      const meshed = overlap(
        sa,
        build(b, mesh.frame),
        p,
        tangent,
        normal,
        pitch,
        2,
        [0.5, 4.5]
      );
      expect(meshed.both).toBe(0);
      expect(meshed.first).toBeGreaterThan(40);
      // The same placement with a right-hand wheel collides: hands matter.
      const wrongHand = mesh;
      expect(
        overlap(
          sa,
          build({ ...b, hand: 'right' }, wrongHand.frame),
          p,
          tangent,
          normal,
          pitch,
          2,
          [0.5, 4.5]
        ).both
      ).toBeGreaterThan(0);
    });

    it('interleaves a pinion inside its ring', () => {
      const ring = gear({ gearType: 'internal', teeth: 54, backlash: 0.1 });
      const pinion = gear({ teeth: 17, phaseDeg: 7, backlash: 0.1 });
      const mesh = solved(ring, pinion);
      const { p, tangent, normal } = pitchPoint(ring, mesh);
      const sr = build(ring, ring.frame);
      const pitch = 2 * Math.PI;
      const meshed = overlap(
        sr,
        build(pinion, mesh.frame),
        p,
        tangent,
        normal,
        pitch,
        2,
        [2.5]
      );
      expect(meshed.both).toBe(0);
      expect(meshed.first).toBeGreaterThan(40);
      expect(meshed.second).toBeGreaterThan(40);
      const off = overlap(
        sr,
        build(pinion, mesh.frame, 180 / 17),
        p,
        tangent,
        normal,
        pitch,
        2,
        [2.5]
      );
      expect(off.both).toBeGreaterThan(20);
    });

    it(
      'interleaves helical and herringbone pairs facing opposite ways, across both halves',
      { timeout: 300_000 },
      () => {
        const upsideDown: RigidTransform = {
          t: { x: 0, y: 0, z: 12 },
          q: axisAngleQuaternion(X, Math.PI)
        };
        // Both halves, on a coarser grid: herringbone flanks classify slowly.
        const zs = [1, 7];
        const pitch = (2 * Math.PI) / Math.cos(20 * DEG);
        const check = (a: GearMeshGear, b: GearMeshGear) => {
          const mesh = solved(a, b, upsideDown);
          expect(mesh.frame.zAxis.z).toBeCloseTo(-1, 12);
          const { p, tangent, normal } = pitchPoint(a, mesh);
          const sa = build(a, a.frame);
          const meshed = overlap(
            sa,
            build(b, mesh.frame),
            p,
            tangent,
            normal,
            pitch,
            2,
            zs,
            0.2
          );
          expect(meshed.both).toBe(0);
          expect(meshed.first).toBeGreaterThan(30);
          expect(meshed.second).toBeGreaterThan(30);
          return { mesh, sa, p, tangent, normal };
        };
        // A single helix keeps its hand: opposite hands, flipped.
        check(
          gear({ helixAngleDeg: 20, faceWidth: 8 }),
          gear({
            teeth: 27,
            helixAngleDeg: 20,
            hand: 'left',
            faceWidth: 8,
            backlash: 0.1
          })
        );
        // A flipped herringbone meshes with the same stored hand.
        const a = gear({ helixAngleDeg: 20, herringbone: true, faceWidth: 8 });
        const b = gear({
          teeth: 27,
          helixAngleDeg: 20,
          herringbone: true,
          faceWidth: 8,
          backlash: 0.1
        });
        const { mesh, sa, p, tangent, normal } = check(a, b);
        // The opposite stored hand, turned so its mid-plane teeth sit where the
        // right one's do, crosses the halves: the mid-plane is clear but both
        // halves collide.
        const rB = (2 / Math.cos(20 * DEG)) * (27 / 2);
        const realign = (8 * Math.tan(20 * DEG)) / rB / DEG;
        const wrong = build({ ...b, hand: 'left' }, mesh.frame, realign);
        const at = (z: number) =>
          overlap(sa, wrong, p, tangent, normal, pitch, 2, [z], 0.2).both;
        expect(at(4)).toBe(0);
        expect(at(1)).toBeGreaterThan(0);
        expect(at(7)).toBeGreaterThan(0);
      }
    );
  }
);
