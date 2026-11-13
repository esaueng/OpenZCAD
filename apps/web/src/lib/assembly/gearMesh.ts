import { gearMeshGearOfBody } from '@openzcad/document-core';
import {
  isGearMeshRefusal,
  solveAssembly,
  type AssemblySet,
  type AssemblySolution,
  type BodyId,
  type GearMeshGear,
  type GearMeshRefusal,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Mesh gears (M14 meshing-pair helper, AS02 joints): pick the gear that
 * stays put and the one that meshes with it; the helper works out the
 * working centre distance and the tooth phase and saves either an ordinary
 * rigid joint that places the second gear there and retains the tooth
 * phase, or (AS02 gear coupling) a joint per gear on the part they are
 * mounted on plus the coupling that makes them turn together. Pure: the
 * card and tests share it. This module only reads which parts are gears;
 * the pair math and the joints live in `gearMeshJoint.ts` and
 * `gearCoupling.ts`, loaded with the card.
 */

/** Fixed together by one rigid joint, or turning together through a coupling. */
export type GearMeshMotion = 'fixed' | 'coupled';

export interface GearMeshDraft {
  /** The gear that stays put; grounded on Mesh when nothing places it. */
  baseId: string | null;
  /** The gear placed against it. */
  movingId: string | null;
  /** Absent means fixed: the conservative default. */
  motion?: GearMeshMotion;
  /**
   * Turning together: the part both gears are mounted on. Not needed when
   * the first gear already turns on a joint (its other part is used).
   */
  carrierId?: string | null;
}

export interface GearMeshContext {
  set: AssemblySet;
  /** The saved solution (no transient values). */
  solution: AssemblySolution;
  /** The gear a component shows, or why it is not one that can mesh. */
  gearOf(componentId: string): GearMeshGear | GearMeshRefusal;
}

/** The Mesh gears context for a saved document. */
export function gearMeshContext(
  document: ProjectDocument,
  bodyOf: (componentId: string) => BodyId | null
): GearMeshContext | null {
  const set = document.assembly;
  if (!set) return null;
  const cache = new Map<string, GearMeshGear | GearMeshRefusal>();
  return {
    set,
    solution: solveAssembly(set),
    gearOf(componentId) {
      const cached = cache.get(componentId);
      if (cached) return cached;
      const bodyId = bodyOf(componentId);
      const gear: GearMeshGear | GearMeshRefusal = bodyId
        ? gearMeshGearOfBody(document, bodyId)
        : { code: 'gear-mesh:not-a-gear', message: 'That part has no body.' };
      cache.set(componentId, gear);
      return gear;
    }
  };
}

/** Components that show a gear (any gear, even one the helper refuses). */
export function gearComponentIds(context: GearMeshContext): string[] {
  return context.set.components
    .filter((c) => {
      const gear = context.gearOf(c.id);
      return !isGearMeshRefusal(gear) || gear.code !== 'gear-mesh:not-a-gear';
    })
    .map((c) => c.id);
}

/** The fixed gear as the base, the first free gear as the one that meshes. */
export function defaultGearMesh(
  context: GearMeshContext,
  ids: readonly string[] = gearComponentIds(context)
): GearMeshDraft {
  const components = ids.flatMap((id) => {
    const component = context.set.components.find((c) => c.id === id);
    return component ? [component] : [];
  });
  const base = components.find((c) => c.grounded) ?? components[0] ?? null;
  const moving =
    components.find(
      (c) =>
        c.id !== base?.id &&
        !c.grounded &&
        (context.solution.roles.get(c.id) ?? 'free') === 'free'
    ) ??
    components.find((c) => c.id !== base?.id) ??
    null;
  return { baseId: base?.id ?? null, movingId: moving?.id ?? null };
}
