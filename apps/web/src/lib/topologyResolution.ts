import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  TopologyReferenceV5,
  TopologySelection
} from '@openzcad/shared';

/**
 * Fail-closed lookup of the face or edge a stored reference points at.
 *
 * ADR-011 is explicit that a reference resolves only when EXACTLY ONE
 * sub-shape carries the hash: "Zero matches raise 'no longer exists';
 * multiple matches raise 'geometrically ambiguous'. A missed resolution can
 * never select a nearby or positional substitute."
 *
 * Every consumer in this app reached for `Array.prototype.find` instead, which
 * silently answers "the first one". That is not a theoretical gap. A sphere
 * primitive publishes TWO faces carrying ONE hash — measured, not inferred:
 * `syncDocument` on a plain sphere returns `faces 2, unique 1` — because
 * BrepKit's two hemispheres are geometrically identical and ADR-011 hashes
 * geometry. Picking either hemisphere therefore bound to the first, and a
 * plate with two identical through-holes behaved the same way. The numbers
 * happened to agree, which is precisely why nobody noticed: the binding was
 * wrong even when the value looked right, and a measurement that survives a
 * rebuild by luck is not durable.
 */

export type TopologyResolutionReason =
  /** The body itself is gone from the projection. */
  | 'body-missing'
  /** No sub-shape carries this identity any more. */
  | 'not-found'
  /** More than one does, so choosing between them would be a guess. */
  | 'ambiguous';

/**
 * Which rung of the ladder answered. Load-bearing for anything anchored to a
 * raw position rather than to a named feature of the topology: an ADR-011 hash
 * is computed from quantized GEOMETRY, so a body that moved gets new hashes
 * and `hash` resolving proves the surface is where it was. `lineage` proves
 * only that the same feature produced it — ADR-013 verifies lineage across a
 * rigid-transform subset precisely so a MOVED face still resolves — which
 * means a stored surface point may no longer lie on it.
 */
export type TopologyResolutionRung = 'lineage' | 'hash';

export type TopologyLookup<T> =
  | { ok: true; entry: T; index: number; via: TopologyResolutionRung }
  | { ok: false; reason: TopologyResolutionReason };

/** What to say to a person when a measurement stops resolving. */
export function topologyResolutionMessage(
  reason: TopologyResolutionReason
): string {
  switch (reason) {
    case 'body-missing':
      return 'The body this measured is no longer in the model.';
    case 'not-found':
      return 'The geometry this measured no longer exists.';
    case 'ambiguous':
      return 'Two or more features now match this equally — re-pick to say which.';
  }
}

interface Identified {
  topologyId: string;
  hash: number;
  reference?: TopologyReferenceV5;
}

type Identity = Pick<TopologySelection, 'topologyId' | 'hash' | 'reference'>;

/**
 * Collects every entry matching a predicate rather than stopping at the first,
 * because the COUNT is the answer: one resolves, none is gone, more than one
 * is ambiguous and must fail rather than pick.
 */
function matchesOf<T>(
  entries: readonly T[],
  predicate: (entry: T) => boolean
): { entry: T; index: number }[] {
  const found: { entry: T; index: number }[] = [];
  entries.forEach((entry, index) => {
    if (predicate(entry)) {
      found.push({ entry, index });
    }
  });
  return found;
}

function lineageMatches<T extends Identified>(
  entries: readonly T[],
  reference: TopologyReferenceV5
): { entry: T; index: number }[] {
  return matchesOf(
    entries,
    (entry) =>
      entry.reference?.kind === reference.kind &&
      entry.reference.producingFeatureId === reference.producingFeatureId &&
      entry.reference.lineageName === reference.lineageName
  );
}

function hashMatches<T extends Identified>(
  entries: readonly T[],
  identity: Identity
): { entry: T; index: number }[] {
  if (identity.topologyId === undefined && identity.hash === undefined) {
    return [];
  }
  return matchesOf(
    entries,
    (entry) =>
      (identity.topologyId !== undefined &&
        entry.topologyId === identity.topologyId) ||
      (identity.hash !== undefined && entry.hash === identity.hash)
  );
}

/**
 * The resolution ladder: ADR-013 lineage first, then the ADR-011 hash.
 *
 * A lineage rung that finds NOTHING falls through to the hash rung rather than
 * failing there. That is deliberate and worth stating, because the stricter
 * reading — treat a lineage miss as terminal — costs real work for no safety.
 * ADR-013 layers lineage names additively ON TOP of the hash and verifies them
 * only for primitives, sweeps, and a rigid-transform subset; booleans, blends,
 * patterns, direct edits, and imported STEP stay hash-only by design. So a face
 * measured on a plain body loses its lineage the moment a boolean is applied
 * downstream, while its hash — the authoritative identity under ADR-011 —
 * survives untouched. Failing closed there would strand a still-valid
 * measurement.
 *
 * A lineage rung that finds MORE THAN ONE fails immediately and does not fall
 * through: two entries claiming the same lineage name is an ambiguity that the
 * hash cannot adjudicate, and ADR-011 forbids picking.
 */
function resolve<T extends Identified>(
  entries: readonly T[] | undefined,
  identity: Identity,
  kind: 'face' | 'edge'
): TopologyLookup<T> {
  if (!entries) {
    return { ok: false, reason: 'body-missing' };
  }
  // The hash rung is evaluated first even though lineage outranks it, so that
  // a lineage answer can still report whether the geometry itself is unchanged.
  const byHash = hashMatches(entries, identity);
  if (identity.reference?.kind === kind) {
    const lineage = lineageMatches(entries, identity.reference);
    if (lineage.length === 1) {
      const entry = lineage[0]!;
      const unmoved = byHash.length === 1 && byHash[0]!.index === entry.index;
      return {
        ok: true,
        entry: entry.entry,
        index: entry.index,
        via: unmoved ? 'hash' : 'lineage'
      };
    }
    if (lineage.length > 1) {
      return { ok: false, reason: 'ambiguous' };
    }
  }
  if (byHash.length === 1) {
    return {
      ok: true,
      entry: byHash[0]!.entry,
      index: byHash[0]!.index,
      via: 'hash'
    };
  }
  return { ok: false, reason: byHash.length === 0 ? 'not-found' : 'ambiguous' };
}

export function resolveFace(
  body: BodyRepresentation | undefined,
  identity: Identity
): TopologyLookup<FaceTopology> {
  if (!body) {
    return { ok: false, reason: 'body-missing' };
  }
  return resolve(body.topology?.faces, identity, 'face');
}

export function resolveEdge(
  body: BodyRepresentation | undefined,
  identity: Identity
): TopologyLookup<EdgeTopology> {
  if (!body) {
    return { ok: false, reason: 'body-missing' };
  }
  return resolve(body.topology?.edges, identity, 'edge');
}
