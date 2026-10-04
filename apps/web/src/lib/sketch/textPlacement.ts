/**
 * Turning the text card's draft into a sketch object.
 *
 * Kept apart from the session math so it loads with the viewport and the card
 * rather than with the app shell: nothing on first paint places text.
 */
import {
  documentTextBudgetError,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import type { SketchTextDraft } from '../interaction/machine';
import type { SketchPoint } from './session';

/**
 * Text is placed with a single click rather than a drag: its extent comes from
 * the string and the em size, not from how far the pointer travelled, so there
 * is nothing for a drag to mean. The click sets the baseline origin; the
 * draft the card composed supplies everything else. The live outline that
 * follows the pointer is built by this same call, so the preview and the
 * placed object cannot disagree.
 */
export function textObjectFromPoint(
  point: SketchPoint,
  draft: SketchTextDraft
): SketchObjectData {
  return {
    objectKind: 'text',
    text: draft.text,
    fontFamily: draft.fontFamily,
    fontStyle: draft.fontStyle,
    size: draft.size,
    x: point.x,
    y: point.y,
    // Left is the schema default; leaving it out keeps the stored object
    // what it was before alignment existed.
    ...(draft.align === 'left' ? {} : { align: draft.align })
  };
}

/** Node id the draft stands in under while the budget is checked. */
const DRAFT_NODE_ID = 'sketch-text-draft';

/**
 * Why placing a text object with `text` would be refused, if it would.
 *
 * The document-wide budget is evaluated on the document as it would be with
 * the object added — to the active sketch's object list, or to a new sketch
 * while the session has none yet — together with what undo history already
 * holds. That is the same `documentTextBudgetError` the command manager
 * asserts after the add, so the card and the click refuse exactly what the
 * commit would, instead of enabling Place for an add that then fails. The
 * sketch-level limits are part of the same check. (Approximation: history the
 * add would evict still counts, so a refusal can come one edit early.)
 */
export function textPlacementBudgetError(
  document: Pick<ProjectDocument, 'nodes' | 'editHistory'>,
  sketchId: string | null,
  text: string
): string | null {
  const entry = sketchId
    ? Object.entries(document.nodes).find(
        ([, node]) => node.kind === 'sketch' && node.sketchId === sketchId
      )
    : undefined;
  const existing = entry?.[1].kind === 'sketch' ? entry[1] : null;
  const draft = {
    kind: 'sketch-object',
    data: { objectKind: 'text', text }
  };
  return documentTextBudgetError({
    editHistory: document.editHistory,
    nodes: {
      ...document.nodes,
      [DRAFT_NODE_ID]: draft,
      [entry ? entry[0] : `${DRAFT_NODE_ID}-sketch`]: {
        ...(existing ?? {}),
        kind: 'sketch',
        objectIds: [...(existing?.objectIds ?? []), DRAFT_NODE_ID]
      }
    } as unknown as ProjectDocument['nodes']
  });
}
