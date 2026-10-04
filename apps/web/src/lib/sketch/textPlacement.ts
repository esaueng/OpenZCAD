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
import { evalParamValue } from '../model';
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

/**
 * The draft's em size resolved against the parameter scope as it is now, or
 * null when it does not resolve to a positive length. Evaluated at call time,
 * never stored: a size written as `h` stops being placeable the moment `h`
 * changes to 0 in the Parameters panel, with no edit to the card.
 */
export function resolvedTextDraftSize(
  draft: SketchTextDraft,
  scope: Record<string, number>
): number | null {
  const size = evalParamValue(draft.size, scope);
  return size !== null && size > 0 ? size : null;
}

/**
 * Whether the draft can be placed at all: a string to place and a size that
 * resolves in the current scope. The card and the plane click both ask this,
 * so a click never commits a draft whose card says it cannot be placed.
 */
export function textDraftPlaceable(
  draft: SketchTextDraft | null | undefined,
  scope: Record<string, number>
): boolean {
  return Boolean(
    draft &&
    draft.text.length > 0 &&
    resolvedTextDraftSize(draft, scope) !== null
  );
}

/**
 * The one placement rule the card's Place and the plane click both consult:
 * a placeable draft, nothing busy (a solve or rebuild in flight owns the
 * sketch until it answers), and no budget refusal for the draft.
 */
export function canPlaceTextDraft(
  draft: SketchTextDraft | null | undefined,
  scope: Record<string, number>,
  blockers: { busy?: boolean; budgetError?: string | null }
): boolean {
  return (
    textDraftPlaceable(draft, scope) && !blockers.busy && !blockers.budgetError
  );
}

/** Every node key the budget walk can see: current nodes and undo history. */
function budgetNodeKeys(
  document: Pick<ProjectDocument, 'nodes' | 'editHistory'>
): Set<string> {
  const keys = new Set(Object.keys(document.nodes));
  for (const entry of document.editHistory?.entries ?? []) {
    for (const change of entry.changes) {
      if (change.kind !== 'value' || change.field !== 'nodes') continue;
      if (change.key !== undefined) {
        keys.add(change.key);
        continue;
      }
      for (const value of [change.before, change.after]) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const key of Object.keys(value)) keys.add(key);
        }
      }
    }
  }
  return keys;
}

/** `base`, or `base-1`, `base-2`, ... — the first one `used` does not hold. */
function unusedKey(used: Set<string>, base: string): string {
  let key = base;
  for (let suffix = 1; used.has(key); suffix += 1) {
    key = `${base}-${suffix}`;
  }
  used.add(key);
  return key;
}

/**
 * Why placing a text object with `text` would be refused, if it would.
 *
 * The document-wide budget is evaluated on the document as it would be with
 * the object added — to the active sketch's object list, or to a new sketch
 * while the session has none yet — together with what undo history already
 * holds. That is the same `documentTextBudgetError` the command manager
 * asserts after the add, so the card and the click refuse exactly what the
 * commit would, instead of enabling Place for an add that then fails. The
 * sketch-level limits are part of the same check. The stand-in nodes take
 * keys no node or history entry uses, so they never mask a real one.
 * (Approximation: history the add would evict still counts, so a refusal can
 * come one edit early.)
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
  const used = budgetNodeKeys(document);
  const draftKey = unusedKey(used, 'sketch-text-draft');
  const sketchKey = entry
    ? entry[0]
    : unusedKey(used, 'sketch-text-draft-sketch');
  return documentTextBudgetError({
    editHistory: document.editHistory,
    nodes: {
      ...document.nodes,
      [draftKey]: {
        kind: 'sketch-object',
        data: { objectKind: 'text', text }
      },
      [sketchKey]: {
        ...(existing ?? {}),
        kind: 'sketch',
        objectIds: [...(existing?.objectIds ?? []), draftKey]
      }
    } as unknown as ProjectDocument['nodes']
  });
}
