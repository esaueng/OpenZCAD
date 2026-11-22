/**
 * S03 per-entity freedom from the pinned solver's own rank.
 *
 * The kernel reports one DOF scalar for a sketch and no per-entity freedom,
 * but it can solve with an entity held: its points become fixed solver
 * points (a circle also keeps its radius, an ellipse its axes and turn).
 * The DOF that drops when one entity is held is exactly how far that entity
 * can still move — the dimension of the sketch's free motions seen on that
 * entity's own parameters — so an entity whose hold changes nothing is
 * fully defined, whatever the rest of the sketch is doing.
 *
 * Every number here is the solver's rank, read at the solved geometry; no
 * freedom is guessed. Entities the solver cannot hold (a spline's points
 * are never held) or whose held solve does not settle stay unmeasured, and
 * callers must leave them uncoloured.
 */
import type {
  SketchSolveAnchor,
  SketchSolveOutcome
} from '@openzcad/kernel-adapter/exact';

export interface SketchEntityFreedomReport {
  /** The sketch-wide DOF every freedom below is measured against. */
  dof: number;
  /** Remaining freedoms of each measured entity; 0 is fully defined. */
  freedom: Record<string, number>;
  /**
   * Entities asked about but left unmeasured: not solver geometry (text,
   * a legacy rectangle), a spline, or a held solve that did not settle.
   */
  unmeasured: string[];
}

/**
 * The most solver entities a reading holds one at a time. Each hold is a
 * fresh solve of the whole sketch, so the reading grows with the square of
 * the sketch: 150 related lines took about 2.3 s on the pinned kernel, 60
 * stay near 0.4 s. A denser sketch keeps the sketch-wide status.
 */
export const MAX_FREEDOM_ENTITIES = 60;

type SolveWith = (anchor?: SketchSolveAnchor) => Promise<SketchSolveOutcome>;

const settled = (outcome: SketchSolveOutcome) =>
  outcome.converged &&
  !outcome.rolledBack &&
  outcome.classification !== 'unsatisfied';

/**
 * Measure each named entity's remaining freedom, or null when the sketch
 * itself does not settle (its rank is then no evidence of anything) or has
 * more than {@link MAX_FREEDOM_ENTITIES} entities to hold.
 */
export async function measureSketchEntityFreedom(
  solve: SolveWith,
  objectIds: readonly string[]
): Promise<SketchEntityFreedomReport | null> {
  const base = await solve();
  if (!settled(base)) {
    return null;
  }
  const kinds = new Map(
    base.objects.map((object) => [String(object.objectId), object.kind])
  );
  const freedom: Record<string, number> = {};
  const unmeasured: string[] = [];
  const asked = [...new Set(objectIds)];
  const holdable = (objectId: string) => {
    const kind = kinds.get(objectId);
    return kind !== undefined && kind !== 'spline';
  };
  if (asked.filter(holdable).length > MAX_FREEDOM_ENTITIES) {
    return null;
  }
  for (const objectId of asked) {
    if (!holdable(objectId)) {
      unmeasured.push(objectId);
      continue;
    }
    if (base.dof.dof === 0) {
      // Nothing in the sketch can move, so nothing held can move less.
      freedom[objectId] = 0;
      continue;
    }
    const held = await solve({ objectIds: [objectId] });
    if (!settled(held)) {
      unmeasured.push(objectId);
      continue;
    }
    freedom[objectId] = Math.max(0, base.dof.dof - held.dof.dof);
  }
  return { dof: base.dof.dof, freedom, unmeasured };
}

/** The measured entities nothing can move, for the fully-defined colour. */
export function fixedEntityIds(report: SketchEntityFreedomReport): string[] {
  return Object.entries(report.freedom)
    .filter(([, free]) => free === 0)
    .map(([objectId]) => objectId);
}

export interface FreeEntityRow {
  objectId: string;
  label: string;
  /** Remaining freedoms; always at least 1. */
  freedom: number;
}

/**
 * The entities that can still move, in sketch order, named the way the rest
 * of the sketch UI names them.
 */
export function freeEntityRows(
  report: SketchEntityFreedomReport,
  objectIds: readonly string[],
  labelOf: (objectId: string) => string
): FreeEntityRow[] {
  return objectIds.flatMap((objectId) => {
    const free = report.freedom[objectId];
    return free !== undefined && free > 0
      ? [{ objectId, label: labelOf(objectId), freedom: free }]
      : [];
  });
}
