import {
  transformStampBodyIds,
  isFeatureManuallySuppressed,
  isFeatureRollbackSuppressed,
  isInPlaceTransform,
  type BodyId,
  type FeatureData,
  type FeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { listFeaturesInOrder } from './feature-order';
import { booleanConsumedBodyIds, findBodyNode } from './index';

/**
 * The separate input body a feature REPLACES — consumes, and leaves its own
 * result in place of — or null. This is the body a suppressed or failed run
 * of it hands through to its dependents (ADR-017, October and November 2026),
 * and the body two features must never both replace (ADR-025).
 *
 * - Hole, shell, solid offset, draft, fillet, chamfer, pattern and thread
 *   consume `targetBodyId` and replace it. A suppressed pattern leaves its
 *   seed.
 * - An add, cut or intersect extrude consumes `targetBodyId`; its tool comes
 *   from a sketch, so no other body is involved. A new-body extrude has no
 *   input.
 * - A boolean replaces its first operand — the target of a subtract, the
 *   first body of a union or intersect. Its tools are consumed too (see
 *   `booleanConsumedBodyIds`) but are not what it replaces: a skipped boolean
 *   leaves them unconsumed, back on screen as they were before it ran. This
 *   is deliberately not `activeWhen = 0`, which consumes the tools too: that
 *   switch is a modelled configuration whose tools are construction, while
 *   suppressing a step should show the model as if the step were not there.
 *   A boolean that keeps its target (M11 `keepOriginals` all or target)
 *   replaces nothing: the target is already live under its own id, so
 *   standing it in for the result would show it twice, as for mirror.
 * - Transform and direct edit rewrite their target in place under the same
 *   id, so a skipped one already leaves the input where dependents look.
 * - Mirror and thicken create an additional body and leave their input live;
 *   standing the input in for the copy would show the same material twice.
 * - Split consumes its input but yields two halves, and neither is the
 *   input; handing the whole body to both would double it.
 * - Primitives, sketches, revolves, lofts, sweeps and imports make a body
 *   from nothing, so there is nothing to pass on.
 *
 * Pass-through supplies a BODY only. Dependents still resolve their face and
 * edge references against that body's verified lineage (ADR-011), so a
 * reference to topology the suppressed feature itself made — its blend, its
 * bore — finds nothing and refuses exactly as a missing face always has.
 */
export function replacedInputBodyId(data: FeatureData): BodyId | null {
  switch (data.featureKind) {
    case 'hole':
    case 'shell':
    case 'solid-offset':
    case 'rib':
    case 'wrap':
    case 'draft':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'thread':
    case 'custom-feature':
      return data.targetBodyId;
    case 'gear':
      // Teeth cut into a body replace it; a new gear has no input body.
      return data.targetBodyId ?? null;
    case 'extrude':
      return (data.operation ?? 'new-body') === 'new-body'
        ? null
        : (data.targetBodyId ?? null);
    case 'boolean':
      return data.keepOriginals === 'all' || data.keepOriginals === 'target'
        ? null
        : (data.targetBodyIds[0] ?? null);
    case 'transform':
    case 'direct-edit':
    case 'mirror':
    case 'thicken':
    case 'split':
    case 'primitive':
    case 'sketch':
    case 'revolve':
    case 'loft':
    case 'sweep':
    case 'helical-sweep':
    case 'sheet-metal':
    case 'standard-part':
    case 'imported-mesh':
    case 'imported-step':
    case 'datum-plane':
    case 'datum-axis':
    case 'datum-point':
    case 'datum-csys':
      return null;
    default: {
      const unhandled: never = data;
      void unhandled;
      return null;
    }
  }
}

/**
 * The input body this feature node replaces under a different id of its own:
 * {@link replacedInputBodyId}, or null when the feature has no result id or
 * its result id IS that body (it then edits the body in place).
 */
export function featureReplacedInputBody(feature: FeatureNode): BodyId | null {
  if (!feature.bodyId) return null;
  const source = replacedInputBodyId(feature.data);
  return source === feature.bodyId ? null : source;
}

/**
 * How an active feature uses a body that existed before it: `consume` takes
 * the body out of the live set (the feature's result, or nothing, replaces
 * it), `edit` rewrites it in place under its own id. A body a feature only
 * reads and leaves live (a mirror's source, a kept boolean operand) is not
 * listed.
 */
interface BodyUse {
  bodyId: BodyId;
  use: 'consume' | 'edit';
}

function activeBodyUses(feature: FeatureNode): BodyUse[] {
  const data = feature.data;
  const uses: BodyUse[] = [];
  const add = (bodyId: BodyId | undefined, use: BodyUse['use']) => {
    if (bodyId !== undefined && !uses.some((entry) => entry.bodyId === bodyId))
      uses.push({ bodyId, use });
  };
  const replaced = featureReplacedInputBody(feature);
  if (replaced !== null) add(replaced, 'consume');
  else {
    const source = replacedInputBodyId(data);
    if (source !== null) add(source, 'edit');
  }
  if (data.featureKind === 'boolean') {
    for (const bodyId of booleanConsumedBodyIds(data)) add(bodyId, 'consume');
  } else if (data.featureKind === 'split' && data.keepOriginal !== true) {
    add(data.targetBodyId, 'consume');
  } else if (isInPlaceTransform(data) || data.featureKind === 'direct-edit') {
    add(data.targetBodyId, 'edit');
  }
  return uses;
}

/**
 * The bodies a feature uses, as the build would at its history position: an
 * active feature per {@link activeBodyUses}; a manually suppressed one only
 * the body its pass-through consumes; a rollback-paused one nothing, since
 * the build skips it without passing anything through.
 */
function bodyUses(feature: FeatureNode): BodyUse[] {
  if (isFeatureRollbackSuppressed(feature)) return [];
  if (isFeatureManuallySuppressed(feature)) {
    const passed = featureReplacedInputBody(feature);
    return passed === null ? [] : [{ bodyId: passed, use: 'consume' }];
  }
  return activeBodyUses(feature);
}

/**
 * The bodies a feature node takes out of the live set, as the build would at
 * its history position (see {@link bodyUses}): one it consumes, not one it
 * edits in place under its own id or only reads and leaves live.
 */
export function featureConsumedBodyIds(feature: FeatureNode): BodyId[] {
  return bodyUses(feature)
    .filter((entry) => entry.use === 'consume')
    .map((entry) => entry.bodyId);
}

/**
 * One branch in the feature history: `featureId` builds on, or edits in
 * place, `bodyId` after the earlier feature `consumerFeatureId` already
 * replaced it. Both run, so both results are on screen: the history has
 * forked into two overlapping lineages of the same part.
 */
export interface HistoryFork {
  /** The later feature, which builds on the stale state. */
  featureId: FeatureId;
  /** The body both features use. */
  bodyId: BodyId;
  /** The earlier feature that replaced `bodyId` first. */
  consumerFeatureId: FeatureId;
}

/**
 * Every fork in the document's history, in history order. Pure: reads the
 * stored feature order, kinds, targets and suppression state only, never
 * geometry, so a fork is reported whether or not either branch builds.
 *
 * A body is consumed by the first feature, in order, that replaces it (see
 * {@link replacedInputBodyId}), consumes it as a boolean operand or splits it.
 * Every later ACTIVE feature that consumes or edits that body again is
 * reported against it. A manually suppressed feature consumes only what its
 * pass-through consumes (the build then shows its input under its result id,
 * so a later feature on that input still forks), and is never reported
 * itself: it builds nothing of its own. A rollback-paused feature neither
 * consumes nor is reported. A failed feature consumes exactly as a built
 * one: it passes its input through under its result id (ADR-017).
 *
 * Two consumers whose results are later combined again (a subtract and an
 * intersect of one body by one tool, reassembled by a union, as the
 * imported-opening recipe builds) leave one body on screen, not two. That is
 * a construction, not a fork, and is not reported. An in-place edit of a
 * consumed body has no result of its own to rejoin, so it always is.
 */
export function historyForks(document: ProjectDocument): HistoryFork[] {
  const consumedBy = new Map<BodyId, FeatureNode>();
  const children = new Map<BodyId, BodyId[]>();
  const candidates: {
    fork: HistoryFork;
    branches?: [BodyId[], BodyId[]];
  }[] = [];
  for (const feature of listFeaturesInOrder(document)) {
    const reported = !isFeatureManuallySuppressed(feature);
    const results = resultBodies(feature);
    for (const { bodyId, use } of bodyUses(feature)) {
      if (use === 'consume') {
        children.set(bodyId, [
          ...(children.get(bodyId) ?? []),
          ...results.filter((result) => result !== bodyId)
        ]);
      }
      const consumer = consumedBy.get(bodyId);
      if (consumer !== undefined) {
        if (reported)
          candidates.push({
            fork: {
              featureId: feature.featureId,
              bodyId,
              consumerFeatureId: consumer.featureId
            },
            ...(use === 'consume'
              ? { branches: [resultBodies(consumer), results] }
              : {})
          });
      } else if (use === 'consume') {
        consumedBy.set(bodyId, feature);
      }
    }
  }
  const descendants = (roots: readonly BodyId[]): Set<BodyId> => {
    const seen = new Set<BodyId>();
    const queue = [...roots];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(children.get(next) ?? []));
    }
    return seen;
  };
  return candidates.flatMap(({ fork, branches }) => {
    if (branches) {
      const earlier = descendants(branches[0]);
      if ([...descendants(branches[1])].some((body) => earlier.has(body)))
        return [];
    }
    return [fork];
  });
}

/**
 * The bodies a feature's consumption leads to: its result, and a split's
 * second half. A manually suppressed feature leads only to its result id,
 * where its pass-through stands.
 */
function resultBodies(feature: FeatureNode): BodyId[] {
  const results: BodyId[] = [];
  if (feature.bodyId) results.push(feature.bodyId);
  if (
    feature.data.featureKind === 'split' &&
    !isFeatureManuallySuppressed(feature)
  )
    results.push(feature.data.secondBodyId);
  // M10: a linked copy's further stamps are its results too.
  if (!isFeatureManuallySuppressed(feature))
    results.push(...transformStampBodyIds(feature.data));
  return results;
}

function featureName(document: ProjectDocument, featureId: FeatureId): string {
  return (
    listFeaturesInOrder(document).find(
      (feature) => feature.featureId === featureId
    )?.name ?? String(featureId)
  );
}

function bodyLabel(document: ProjectDocument, bodyId: BodyId): string {
  return findBodyNode(document, bodyId)?.name ?? String(bodyId);
}

/** The build warning a fork raises on its later feature (no name prefix). */
export function historyForkMessage(
  document: ProjectDocument,
  fork: HistoryFork
): string {
  return `Builds on an earlier state of “${bodyLabel(document, fork.bodyId)}” that “${featureName(document, fork.consumerFeatureId)}” already replaced; this branches the history.`;
}

/** A fork an edit introduces, and how: see {@link introducedHistoryForks}. */
interface IntroducedHistoryFork {
  fork: HistoryFork;
  /**
   * `target`: the later feature is new or uses different bodies. `order`:
   * it uses the bodies it always did, and the step order put a consumer of
   * one ahead of it.
   */
  cause: 'target' | 'order';
}

/**
 * The forks of `next` that `previous` did not have and the edit between
 * them caused, each with its cause.
 *
 * - `target`: the later feature is new, or uses different bodies than in
 *   `previous`.
 * - `order`: the later feature uses the bodies it did, but in `previous` it
 *   ran ahead of the consumer (or the consumer was not there yet), and now
 *   runs after it. A placement moved below the boolean that consumes the
 *   placed body is the reported case (#2334): the boolean then cut at the
 *   unplaced position while the order committed. Moving the consumer above
 *   the placement reaches the same arrangement and is judged the same.
 *
 * Every other fork is left alone. A stored history that already forked keeps
 * loading, replaying and accepting unrelated edits, and its two branches may
 * still be reordered around each other: a feature already on either side of
 * a fork of the same body is not judged by order. Resuming or unsuppressing a
 * step neither retargets nor reorders one, so it is never refused here; and a
 * feature added while History is rolled back is judged where it lands, at
 * the marker, ahead of the paused consumer.
 */
function introducedHistoryForks(
  previous: ProjectDocument,
  next: ProjectDocument
): IntroducedHistoryFork[] {
  const position = new Map<FeatureId, number>();
  const uses = new Map<FeatureId, string>();
  listFeaturesInOrder(previous).forEach((feature, index) => {
    position.set(feature.featureId, index);
    uses.set(feature.featureId, JSON.stringify(activeBodyUses(feature)));
  });
  const current = listFeaturesInOrder(next);
  const changed = new Set(
    current
      .filter(
        (feature) =>
          uses.get(feature.featureId) !==
          JSON.stringify(activeBodyUses(feature))
      )
      .map((feature) => feature.featureId)
  );
  // The features both documents have, in `next`'s order: out of step with
  // `previous` only when the edit reordered them.
  const kept = current
    .map((feature) => position.get(feature.featureId))
    .filter((index): index is number => index !== undefined);
  const reordered = kept.some((index, at) => at > 0 && kept[at - 1]! > index);
  if (changed.size === 0 && !reordered) return [];
  const key = (fork: HistoryFork) =>
    `${fork.featureId} ${fork.bodyId} ${fork.consumerFeatureId}`;
  const side = (featureId: FeatureId, bodyId: BodyId) =>
    `${featureId} ${bodyId}`;
  const before = historyForks(previous);
  const existing = new Set(before.map(key));
  const alreadyForked = new Set(
    before.flatMap((fork) => [
      side(fork.featureId, fork.bodyId),
      side(fork.consumerFeatureId, fork.bodyId)
    ])
  );
  return historyForks(next).flatMap((fork): IntroducedHistoryFork[] => {
    if (existing.has(key(fork))) return [];
    if (changed.has(fork.featureId)) return [{ fork, cause: 'target' }];
    if (alreadyForked.has(side(fork.featureId, fork.bodyId))) return [];
    // Unchanged uses mean the feature was in `previous`.
    const was = position.get(fork.featureId)!;
    const consumerWas = position.get(fork.consumerFeatureId);
    return consumerWas === undefined || consumerWas > was
      ? [{ fork, cause: 'order' }]
      : [];
  });
}

/**
 * Forks an edit would introduce: on a feature it adds or retargets, or by
 * ordering a consumer of a body ahead of a step that still uses that body
 * (see {@link introducedHistoryForks}).
 */
export function newHistoryForks(
  previous: ProjectDocument,
  next: ProjectDocument
): HistoryFork[] {
  return introducedHistoryForks(previous, next).map((entry) => entry.fork);
}

/**
 * Refuses an edit that adds a fork (see {@link newHistoryForks}), naming the
 * feature, the body and the step that already replaced it. A fork the step
 * order introduces is refused as a reorder, with the order that avoids it.
 */
export function assertNoNewHistoryFork(
  previous: ProjectDocument,
  next: ProjectDocument
): void {
  const introduced = introducedHistoryForks(previous, next)[0];
  if (!introduced) return;
  const { fork, cause } = introduced;
  const feature = featureName(next, fork.featureId);
  const body = bodyLabel(next, fork.bodyId);
  const consumer = featureName(next, fork.consumerFeatureId);
  throw new Error(
    cause === 'order'
      ? `Cannot reorder: “${feature}” would run after “${consumer}” already replaced “${body}”, which branches the history. Keep “${feature}” before “${consumer}”.`
      : `“${feature}” would build on an earlier state of “${body}” that “${consumer}” already replaced, which branches the history. Use the body as it is now, or roll History back to before “${consumer}” to add the step there.`
  );
}
