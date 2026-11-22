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
import type {
  EntityId,
  ProjectDocument,
  SketchId,
  SketchObjectData
} from '@openzcad/shared';
import { solvedSketchCommands } from './applySolve';

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
 * The most solver entities (splines included) a reading covers. Each hold
 * is a fresh solve of the whole sketch, so the reading grows with the
 * square of the sketch: 150 related lines took about 2.3 s on the pinned
 * kernel, 60 stay near 0.4 s. A denser sketch keeps the sketch-wide status.
 */
export const MAX_FREEDOM_ENTITIES = 60;

type SolveWith = (
  document: ProjectDocument,
  anchor?: SketchSolveAnchor
) => Promise<SketchSolveOutcome>;

const settled = (outcome: SketchSolveOutcome) =>
  outcome.converged &&
  !outcome.rolledBack &&
  outcome.classification !== 'unsatisfied';

/**
 * Measure each named entity's remaining freedom, or null when the sketch
 * itself does not settle (its rank is then no evidence of anything) or has
 * more than {@link MAX_FREEDOM_ENTITIES} solver entities.
 *
 * Every entity is held where the solve puts it, not where it is stored: a
 * stored sketch the solve still moves (a sloped line under a horizontal
 * relation) could not be held at its stored place, and its rank there is
 * not the sketch's.
 */
export async function measureSketchEntityFreedom(
  solve: SolveWith,
  document: ProjectDocument,
  sketchId: SketchId,
  objectIds: readonly string[]
): Promise<SketchEntityFreedomReport | null> {
  const first = await solve(document);
  if (!settled(first)) {
    return null;
  }
  // Each one solve, at the solved geometry: as many held solves as entities
  // the kernel solves, splines included, each the size of the whole sketch.
  if (first.objects.length > MAX_FREEDOM_ENTITIES) {
    return null;
  }
  const solved = withSolvedGeometry(document, sketchId, first);
  const base = solved === document ? first : await solve(solved);
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
    const held = await solve(solved, { objectIds: [objectId] });
    if (!settled(held)) {
      unmeasured.push(objectId);
      continue;
    }
    freedom[objectId] = Math.max(0, base.dof.dof - held.dof.dof);
  }
  return { dof: base.dof.dof, freedom, unmeasured };
}

/**
 * The document with the solve's geometry in place of the stored geometry,
 * for solving only: every move is taken (no skip tolerance, since the
 * solver's own is finer than the apply step's), and only the moved sketch
 * nodes are copied, so a large model never is.
 */
function withSolvedGeometry(
  document: ProjectDocument,
  sketchId: SketchId,
  outcome: SketchSolveOutcome
): ProjectDocument {
  const moved = solvedSketchCommands(document, sketchId, outcome, 0);
  if (moved.length === 0) return document;
  const nodes = { ...document.nodes };
  for (const command of moved) {
    const { objectId, data } = command.payload as {
      objectId: EntityId;
      data: SketchObjectData;
    };
    const node = nodes[objectId];
    if (node?.kind === 'sketch-object') {
      nodes[objectId] = { ...node, data };
    }
  }
  return { ...document, nodes };
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
