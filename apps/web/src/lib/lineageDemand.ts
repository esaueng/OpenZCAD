import { useEffect, useMemo, useRef, useState } from 'react';
import type { BodyId, TopologySelection } from '@openzcad/shared';
import type { InteractionState } from './interaction/machine';

/**
 * Transient boolean-lineage demand (K05 on-demand probe).
 *
 * A set of body ids whose producing booleans must run the entity-evolution
 * probe. UI state only: it rides the geometry sync request like `analysis`,
 * is mixed into the per-feature history digest and the worker rebuild cache
 * key, and never reaches the persisted document, the canonical content, or
 * cloud sync.
 *
 * Sticky per open document: ids are only added while the document is open,
 * never removed, so lineage does not flip back and forth. Cleared when the
 * open document (project) changes.
 */

/** Sorted, deduplicated demand for wire/cache keys. */
export function normalizeLineageDemand(
  demand: readonly BodyId[] | ReadonlySet<BodyId> | undefined | null
): BodyId[] {
  if (!demand) {
    return [];
  }
  const ids: readonly BodyId[] = Array.isArray(demand)
    ? (demand as readonly BodyId[])
    : [...demand];
  const unique: BodyId[] = [...new Set<BodyId>(ids)];
  return unique.sort();
}

/** Stable key for a demand set; `[]` when empty. */
export function lineageDemandKey(
  demand: readonly BodyId[] | ReadonlySet<BodyId> | undefined | null
): string {
  return JSON.stringify(normalizeLineageDemand(demand));
}

/** Bodies a selection demands lineage for: face/edge picks on B demand B. */
export function demandedBodiesForSelections(
  selections: readonly TopologySelection[] | TopologySelection | null | undefined
): BodyId[] {
  if (!selections) {
    return [];
  }
  const list: readonly TopologySelection[] = Array.isArray(selections)
    ? selections
    : [selections];
  const bodies = new Set<BodyId>();
  for (const selection of list) {
    // Any sub-shape pick demands its body. `body` picks do not: they name
    // the publisher without proving a topology read. A future `vertex` pick
    // is covered by the same rule via the else branch.
    if (selection && selection.kind !== 'body') {
      bodies.add(selection.bodyId);
    }
  }
  return [...bodies];
}

/** Bodies an interaction state demands lineage for (started commands count). */
export function demandedBodiesForInteraction(
  interaction: InteractionState | null | undefined
): BodyId[] {
  if (!interaction || interaction.mode === 'idle' || interaction.mode === 'sketch') {
    return [];
  }
  if (interaction.mode === 'edges') {
    return demandedBodiesForSelections(interaction.edges);
  }
  if (interaction.mode === 'face') {
    const bodyId: unknown = interaction.target.bodyId;
    if (typeof bodyId === 'string' && bodyId.length > 0) {
      return [bodyId as BodyId];
    }
    return [];
  }
  if (interaction.mode === 'region') {
    // A sketch region names no body; its extrude will consume bodies later,
    // but the region pick itself demands no boolean lineage.
    return [];
  }
  return [];
}

/** Merge new bodies into a sticky demand set; never shrinks. */
export function mergeLineageDemand(
  current: ReadonlySet<BodyId>,
  added: readonly BodyId[] | ReadonlySet<BodyId>
): Set<BodyId> {
  const next = new Set(current);
  for (const id of added) {
    next.add(id);
  }
  return next;
}

/**
 * Sticky lineage demand for the open document.
 *
 * - Adds bodies from topology selections and command (interaction) state.
 * - Never shrinks while `projectId` is stable.
 * - Clears when `projectId` changes (document switch).
 *
 * Returns the sorted demand array for sync requests plus an `addBodies`
 * escape hatch for command entry points that pick topology without going
 * through the selection state (hole face pick, face-attached sketch, direct
 * edit, dimension).
 */
export function useLineageDemand(input: {
  projectId: string | undefined;
  selections: readonly TopologySelection[];
  interaction: InteractionState | null | undefined;
}): { demand: BodyId[]; addBodies: (bodyIds: readonly BodyId[]) => void } {
  const { projectId, selections, interaction } = input;
  const [demanded, setDemanded] = useState<ReadonlySet<BodyId>>(new Set());
  const projectRef = useRef(projectId);

  useEffect(() => {
    if (projectRef.current !== projectId) {
      projectRef.current = projectId;
      setDemanded(new Set());
    }
  }, [projectId]);

  const fresh = useMemo(() => {
    const bodies = new Set<BodyId>();
    for (const bodyId of demandedBodiesForSelections(selections)) {
      bodies.add(bodyId);
    }
    for (const bodyId of demandedBodiesForInteraction(interaction)) {
      bodies.add(bodyId);
    }
    return [...bodies];
  }, [selections, interaction]);

  useEffect(() => {
    if (fresh.length === 0) {
      return;
    }
    setDemanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const bodyId of fresh) {
        if (!next.has(bodyId)) {
          next.add(bodyId);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [fresh]);

  const demand = useMemo(() => [...demanded].sort(), [demanded]);

  return {
    demand,
    addBodies: (bodyIds: readonly BodyId[]) => {
      if (bodyIds.length === 0) {
        return;
      }
      setDemanded((current) => mergeLineageDemand(current, bodyIds));
    }
  };
}
