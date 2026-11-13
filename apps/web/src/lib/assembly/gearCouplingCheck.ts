import {
  isGearMeshRefusal,
  type AssemblyCoupling,
  type AssemblyJoint,
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
 */

interface JointGear {
  componentId: string;
  gear: GearMeshGear;
}

/** The gear a joint carries: its child part, else its parent. */
function gearOnJoint(
  context: GearMeshContext,
  joint: AssemblyJoint | undefined
): JointGear | null {
  if (!joint) return null;
  for (const componentId of [
    joint.child.componentId,
    joint.parent.componentId
  ]) {
    const gear = context.gearOf(componentId);
    if (!isGearMeshRefusal(gear)) return { componentId, gear };
  }
  return null;
}

/** The two gears a coupling ties, driver first; null when either is not one. */
export function gearCouplingPair(
  context: GearMeshContext,
  coupling: AssemblyCoupling
): { driver: JointGear; driven: JointGear } | null {
  const joint = (id: string) => context.set.joints.find((j) => j.id === id);
  const driver = gearOnJoint(context, joint(coupling.driver.jointId));
  const driven = gearOnJoint(context, joint(coupling.driven.jointId));
  return driver && driven && driver.componentId !== driven.componentId
    ? { driver, driven }
    : null;
}

/** The coupling that already moves these two gears together, if any. */
export function gearPairCoupling(
  context: GearMeshContext,
  firstId: string,
  secondId: string
): AssemblyCoupling | null {
  for (const coupling of context.set.couplings ?? []) {
    const pair = gearCouplingPair(context, coupling);
    if (!pair) continue;
    const ids = [pair.driver.componentId, pair.driven.componentId];
    if (ids.includes(firstId) && ids.includes(secondId)) return coupling;
  }
  return null;
}

function number(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * Why a coupling no longer matches its gears, or null when it does (or when
 * its joints do not carry two readable gears, so nothing can be said).
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
