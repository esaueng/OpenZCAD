import {
  isGearMeshRefusal,
  type AssemblyCoupling,
  type GearMeshGear
} from '@openzcad/shared';
import type { GearMeshContext } from './gearMesh';

/**
 * Whether a gear coupling still matches its gears (AS02 gear coupling). A
 * coupling's ratio is fixed when the pair is placed; editing a gear's tooth
 * count (or a rack pinion's module) afterwards leaves the stored ratio
 * turning the teeth out of mesh. Nothing is changed for the user: the
 * joint's details and Place gears say so and ask for the pair to be placed
 * again. Reads gears only, so it loads with the sidebar, not the pair math.
 *
 * The gears are the ones the coupling records (`coupling.gears`), not the
 * ends of its joints: a gear keyed to a shaft rides the shaft's joint
 * through a rigid joint, and two gears on one shaft share it, so the
 * joints alone do not say which gears mesh. A coupling without the record
 * was not made from a gear pair and is never judged.
 */

interface CoupledGear {
  componentId: string;
  gear: GearMeshGear;
}

/** The two gears a coupling ties, driver first; null when it has none. */
export function gearCouplingPair(
  context: GearMeshContext,
  coupling: AssemblyCoupling
): { driver: CoupledGear; driven: CoupledGear } | null {
  if (!coupling.gears) return null;
  const read = (componentId: string): CoupledGear | null => {
    if (!context.set.components.some((c) => c.id === componentId)) return null;
    const gear = context.gearOf(componentId);
    return isGearMeshRefusal(gear) ? null : { componentId, gear };
  };
  const driver = read(coupling.gears.driver);
  const driven = read(coupling.gears.driven);
  return driver && driven ? { driver, driven } : null;
}

/** The coupling that already moves these two gears together, if any. */
export function gearPairCoupling(
  context: GearMeshContext,
  firstId: string,
  secondId: string
): AssemblyCoupling | null {
  return (
    (context.set.couplings ?? []).find((coupling) => {
      const gears = coupling.gears;
      return (
        !!gears &&
        ((gears.driver === firstId && gears.driven === secondId) ||
          (gears.driver === secondId && gears.driven === firstId))
      );
    }) ?? null
  );
}

function number(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * Why a coupling no longer matches its gears, or null when it does (or when
 * it records no gear pair, or a part is no longer a readable gear, so
 * nothing can be said).
 */
export function gearCouplingMismatch(
  context: GearMeshContext,
  coupling: AssemblyCoupling
): string | null {
  const pair = gearCouplingPair(context, coupling);
  if (!pair) return null;
  const a = pair.driver.gear;
  const b = pair.driven.gear;
  const rackDrives = a.gearType === 'rack';
  const rackDriven = b.gearType === 'rack';
  if (rackDrives && rackDriven) return null;
  const stored = Math.abs(coupling.ratio);
  let expected: number;
  let describe: (ratio: number) => string;
  if (!rackDrives && !rackDriven) {
    // Driven turns per driver turn: the tooth counts, driver over driven.
    expected = a.teeth / b.teeth;
    describe = (ratio) => `${number(ratio)} turns per turn`;
  } else {
    // A rack travels its pinion's pitch circumference, π·m·z, per turn.
    const pinion = rackDrives ? b : a;
    const perDegree = (Math.PI * pinion.module * pinion.teeth) / 360;
    expected = rackDrives ? 1 / perDegree : perDegree;
    describe = (ratio) =>
      `${number(rackDrives ? 360 / ratio : ratio * 360)} of travel per turn`;
  }
  if (Math.abs(stored - expected) <= 1e-9 * Math.max(stored, expected))
    return null;
  const name = (componentId: string) =>
    context.set.components.find((c) => c.id === componentId)?.name ?? 'a gear';
  return `${name(pair.driver.componentId)} and ${name(pair.driven.componentId)} no longer match ${coupling.name}: their teeth now give ${describe(expected)}, and it was placed for ${describe(stored)}. Remove it and place the gears again.`;
}
