import type { PickDetail } from '@openzcad/viewport/types';
import type {
  BodyId,
  ProjectDocument,
  SketchId,
  TopologySelection
} from '@openzcad/shared';
import { bodiesRebuiltByMove } from './featureHistory';

/**
 * A viewport selection held back by the unapplied-Move question (F15): a
 * pick, a double-clicked edge run, or a box selection that would replace
 * the Move card. A pick made by right-clicking carries the menu's screen
 * point, so the menu opens there once the selection has landed.
 */
export type PendingSelectionSwitch =
  | {
      kind: 'pick';
      selection: TopologySelection;
      additive: boolean;
      detail?: PickDetail;
      contextMenu?: { x: number; y: number };
    }
  | { kind: 'edge-chain'; selections: TopologySelection[] }
  | { kind: 'box'; bodyIds: string[] };

/** The answer to the unapplied-Move question. */
export type MoveAnswer = 'apply' | 'discard' | 'cancel';

export interface SelectionReplay {
  /** What lands once the Move is settled, or null when nothing does. */
  replay: PendingSelectionSwitch | null;
  /** Face and edge picks dropped as stale; only Apply drops any. */
  dropped: number;
}

/**
 * What a selection held back by the unapplied-Move question becomes once the
 * question is answered.
 *
 * Applying a Move rebuilds the moved body and every body downstream of what
 * moved (`bodiesRebuiltByMove`: for a sketch, the extrudes it drives and what
 * is built on them). Body ids survive that rebuild — a Move keeps its target
 * body's id, and a sketch-driven extrude keeps its result's — but face and
 * edge ids do not: a face or edge picked on the preview names topology the
 * rebuild replaces. So only face and edge picks on a rebuilt body are
 * stale; a body-level pick always lands. A box selection carries bodies
 * only, so it is never stale. A right-click's menu follows its pick: it
 * opens at the click point when the pick lands, and not when it is dropped.
 *
 *   selection          target body               Apply    Discard  Cancel
 *   -----------------  ------------------------  -------  -------  ------
 *   body pick          moved body                lands    lands    none
 *   body pick          downstream of what moved  lands    lands    none
 *   body pick          unrelated                 lands    lands    none
 *   face / edge pick   moved body                dropped  lands    none
 *   face / edge pick   downstream of what moved  dropped  lands    none
 *   face / edge pick   unrelated                 lands    lands    none
 *   edge run           (each edge as a pick)     stale edges dropped, rest lands
 *   box selection      any                       lands    lands    none
 *   right-click        as its pick; the menu opens wherever the pick lands
 *
 * "none": Cancel leaves the Move, its values and the current selection as
 * they were.
 */
export function selectionRebuiltByMove(
  document: ProjectDocument,
  preview: { bodyId: string; target?: 'body' | 'sketch' },
  pending: PendingSelectionSwitch,
  answer: MoveAnswer
): SelectionReplay {
  if (answer === 'cancel') return { replay: null, dropped: 0 };
  if (answer === 'discard' || pending.kind === 'box') {
    return { replay: pending, dropped: 0 };
  }
  const rebuilt = bodiesRebuiltByMove(
    document,
    preview.target === 'sketch'
      ? { kind: 'sketch', sketchId: preview.bodyId as SketchId }
      : { kind: 'body', bodyId: preview.bodyId as BodyId }
  );
  const stale = (selection: TopologySelection) =>
    selection.kind !== 'body' && rebuilt.has(selection.bodyId);
  if (pending.kind === 'pick') {
    return stale(pending.selection)
      ? { replay: null, dropped: 1 }
      : { replay: pending, dropped: 0 };
  }
  const kept = pending.selections.filter((selection) => !stale(selection));
  return {
    replay: kept.length > 0 ? { ...pending, selections: kept } : null,
    dropped: pending.selections.length - kept.length
  };
}
