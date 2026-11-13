import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cross3,
  frameInWorld,
  gearMeshFrame,
  solveAssembly,
  type AssemblyFrame,
  type AssemblySet,
  type RigidTransform,
  type Vector3
} from '@openzcad/shared';
import { assemblyRuntime } from '../apps/web/src/lib/assembly/assemblyRuntime';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import {
  PLATE,
  add,
  assembled,
  draft,
  gearOf,
  length,
  pitchPoint,
  place,
  placedGear,
  type GearCouplingFixture,
  type Part
} from './support/gearCoupling';
import { createGearMeshProbe } from './support/gearMeshKernel';

/**
 * AS02 gear coupling against the kernel's own teeth (full suite; the fast
 * ratio and sign checks are in `gear-coupling.test.ts`). A pair is placed
 * through Place gears, one joint is driven through several angles, and at
 * each the two gears are built by Remus where the coupled solve poses them
 * and sampled on a grid across the pitch point, as the M14 helper's own
 * kernel suite does: the teeth must stay interleaved and never overlap.
 * The same drive with the ratio's sign reversed is the control: there the
 * teeth do collide.
 */
afterEach(() => assemblyRuntime.reset());

describe(
  'coupled pairs on the exact kernel, driven through several angles',
  { timeout: 300_000 },
  () => {
    let kernel: RemusKernel;
    beforeAll(() => {
      kernel = new RemusKernel();
    });
    afterAll(() => kernel.free());
    const { build, overlap } = createGearMeshProbe(() => kernel);

    /** Each gear built where the solve poses it, sampled about `p`. */
    function sample(
      fixture: GearCouplingFixture,
      set: AssemblySet,
      driverJointId: string,
      driverValue: number,
      ids: [string, string],
      p: Vector3,
      tangent: Vector3,
      normal: Vector3,
      pitch: number
    ) {
      const poses = solveAssembly(
        set,
        new Map([[driverJointId, [driverValue]]])
      ).poses;
      const [first, second] = ids.map((id) => {
        const gear = gearOf(fixture, id);
        const frame = frameInWorld(
          poses.get(id) as RigidTransform,
          gearMeshFrame(gear.frame) as AssemblyFrame
        );
        return build(gear, frame);
      }) as [number, number];
      // Mid-face, where spur teeth are as anywhere along the face.
      return overlap(first, second, p, tangent, normal, pitch, 2, [2.5]);
    }

    /** The saved assembly with the coupling's sign reversed. */
    function reversed(set: AssemblySet): AssemblySet {
      return {
        ...set,
        couplings: (set.couplings ?? []).map((c) => ({
          ...c,
          ratio: -c.ratio,
          offset: -c.offset
        }))
      };
    }

    function gearGrid(
      fixture: GearCouplingFixture,
      plan: ReturnType<typeof place>,
      ids: [string, string]
    ) {
      const p = pitchPoint(fixture, plan, ids[0], ids[1]);
      const poses = solveAssembly(fixture.set()).poses;
      const a = placedGear(fixture, ids[0], poses);
      const b = placedGear(fixture, ids[1], poses);
      const between = add(b.centre, a.centre, -1);
      const normal = add({ x: 0, y: 0, z: 0 }, between, 1 / length(between));
      return { p, normal, tangent: cross3(a.frame.zAxis, normal) };
    }

    it('keeps an external spur pair in mesh as the pinion turns', () => {
      const pinion: Part = {
        id: 'pinion',
        name: 'Pinion',
        gear: { backlash: 0.1, phaseDeg: 5 }
      };
      const wheel: Part = {
        id: 'wheel',
        name: 'Wheel',
        gear: { teeth: 31, backlash: 0.1, profileShift: 0.25 }
      };
      const fixture = assembled([pinion, wheel, PLATE]);
      const plan = place(fixture, draft('pinion', 'wheel'));
      expect(plan.coupling.ratio).toBeCloseTo(-20 / 31, 12);
      const { p, tangent, normal } = gearGrid(fixture, plan, [
        'pinion',
        'wheel'
      ]);
      const set = fixture.set();
      const pitch = 2 * Math.PI;
      const at = (angle: number, from = set) =>
        sample(
          fixture,
          from,
          plan.driverJointId,
          angle,
          ['pinion', 'wheel'],
          p,
          tangent,
          normal,
          pitch
        );
      // Part of a tooth, several teeth, most of a turn, and backwards.
      for (const angle of [0, 4.5, 23, 151.3, -77]) {
        const meshed = at(angle);
        expect(meshed.both, `overlap at ${angle}°`).toBe(0);
        expect(meshed.first).toBeGreaterThan(40);
        expect(meshed.second).toBeGreaterThan(40);
      }
      // Half a tooth of the pinion, the wheel turned the wrong way: the
      // teeth meet head on.
      expect(at(4.5, reversed(set)).both).toBeGreaterThan(0);
    });

    it('keeps a pinion in mesh inside its ring', () => {
      const ring: Part = {
        id: 'ring',
        name: 'Ring',
        gear: {
          gearType: 'internal',
          teeth: 54,
          backlash: 0.1,
          rimDiameter: 132
        }
      };
      const planet: Part = {
        id: 'planet',
        name: 'Planet',
        gear: { teeth: 17, phaseDeg: 7, backlash: 0.1 }
      };
      const fixture = assembled([ring, planet, PLATE]);
      const plan = place(fixture, draft('ring', 'planet'));
      expect(plan.coupling.ratio).toBeCloseTo(54 / 17, 12);
      const { p, tangent, normal } = gearGrid(fixture, plan, [
        'ring',
        'planet'
      ]);
      const set = fixture.set();
      const at = (angle: number, from = set) =>
        sample(
          fixture,
          from,
          plan.driverJointId,
          angle,
          ['ring', 'planet'],
          p,
          tangent,
          normal,
          2 * Math.PI
        );
      for (const angle of [0, 1.7, 40, -95]) {
        const meshed = at(angle);
        expect(meshed.both, `overlap at ${angle}°`).toBe(0);
        expect(meshed.first).toBeGreaterThan(40);
        expect(meshed.second).toBeGreaterThan(40);
      }
      expect(at(1.7, reversed(set)).both).toBeGreaterThan(0);
    });

    it('keeps a rack in mesh as its pinion rolls along it', () => {
      const rack: Part = {
        id: 'rack',
        name: 'Rack',
        gear: { gearType: 'rack', teeth: 12, backlash: 0.1 }
      };
      const pinion: Part = {
        id: 'pinion',
        name: 'Pinion',
        gear: { teeth: 15, phaseDeg: 4, origin: { x: 30, y: 20, z: 0 } }
      };
      const fixture = assembled([pinion, rack, PLATE]);
      const plan = place(fixture, draft('pinion', 'rack'));
      const p = pitchPoint(fixture, plan, 'pinion', 'rack');
      const poses = solveAssembly(fixture.set()).poses;
      const placedRack = placedGear(fixture, 'rack', poses);
      const tangent = placedRack.frame.xAxis;
      const normal = cross3(placedRack.frame.zAxis, tangent);
      const set = fixture.set();
      const at = (angle: number, from = set) =>
        sample(
          fixture,
          from,
          plan.driverJointId,
          angle,
          ['pinion', 'rack'],
          p,
          tangent,
          normal,
          2 * Math.PI
        );
      // The rack's own limit bounds the roll: stay well inside it.
      for (const angle of [0, 5, 33, -41]) {
        const meshed = at(angle);
        expect(meshed.both, `overlap at ${angle}°`).toBe(0);
        expect(meshed.first).toBeGreaterThan(40);
        expect(meshed.second).toBeGreaterThan(40);
      }
      // 6° is a quarter tooth of 15: sent the wrong way the rack ends half a
      // pitch out, tooth on tooth. (At half a tooth it would be a whole
      // pitch out and mesh again.)
      expect(at(6, reversed(set)).both).toBeGreaterThan(0);
    });
  }
);
