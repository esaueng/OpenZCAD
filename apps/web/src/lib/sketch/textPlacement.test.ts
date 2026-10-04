/**
 * The text card and the plane click must refuse exactly what the commit
 * would: the document-wide text budget, evaluated with the draft added.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_TEXT_CODE_UNITS,
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_SKETCH_TEXT_CODE_UNITS,
  MAX_TEXT_OBJECT_CODE_UNITS,
  MAX_SKETCH_TEXT_OBJECTS,
  documentTextBudgetError,
  type ProjectDocument
} from '@openzcad/shared';
import { newSketchTextDraft } from '../interaction/machine';
import {
  canPlaceTextDraft,
  resolvedTextDraftSize,
  textDraftPlaceable,
  textPlacementBudgetError
} from './textPlacement';

type BudgetDocument = Pick<ProjectDocument, 'nodes' | 'editHistory'>;

/** `count` text objects spread over sketches of at most the sketch limit. */
function documentWithText(count: number): BudgetDocument {
  const nodes: Record<string, unknown> = {};
  let sketchIndex = 0;
  for (let start = 0; start < count; start += MAX_SKETCH_TEXT_OBJECTS) {
    const objectIds: string[] = [];
    for (
      let index = start;
      index < Math.min(count, start + MAX_SKETCH_TEXT_OBJECTS);
      index += 1
    ) {
      const id = `text_${index}`;
      nodes[id] = {
        kind: 'sketch-object',
        objectKind: 'text',
        data: { objectKind: 'text', text: 'A' }
      };
      objectIds.push(id);
    }
    nodes[`node_sketch_${sketchIndex}`] = {
      kind: 'sketch',
      sketchId: `sketch_${sketchIndex}`,
      objectIds
    };
    sketchIndex += 1;
  }
  return { nodes } as unknown as BudgetDocument;
}

describe('textPlacementBudgetError', () => {
  it('allows a placement that stays within every limit', () => {
    const document = documentWithText(3);
    expect(textPlacementBudgetError(document, 'sketch_0', 'Boa')).toBeNull();
    // A session with no sketch yet adds one.
    expect(textPlacementBudgetError(document, null, 'Boa')).toBeNull();
  });

  it('refuses the object that would cross the document limit it sits at', () => {
    const document = documentWithText(MAX_DOCUMENT_TEXT_OBJECTS);
    // At the limit the document itself is fine, so the old check (the
    // document's own error plus the active sketch) let this through.
    expect(documentTextBudgetError(document)).toBeNull();
    expect(textPlacementBudgetError(document, null, 'A')).toMatch(
      /Project text/
    );
  });

  it('counts text that only undo history still holds', () => {
    const document = documentWithText(MAX_DOCUMENT_TEXT_OBJECTS - 1);
    const withHistory = {
      ...document,
      editHistory: {
        entries: [
          {
            changes: [
              {
                kind: 'value',
                field: 'nodes',
                key: 'text_deleted',
                before: {
                  kind: 'sketch-object',
                  data: { objectKind: 'text', text: 'gone' }
                }
              }
            ]
          }
        ]
      }
    } as unknown as BudgetDocument;
    expect(documentTextBudgetError(withHistory)).toBeNull();
    expect(textPlacementBudgetError(withHistory, null, 'A')).toMatch(
      /Project text/
    );
  });

  it('refuses a sketch already at its own limit', () => {
    const document = documentWithText(MAX_SKETCH_TEXT_OBJECTS);
    expect(textPlacementBudgetError(document, 'sketch_0', 'A')).toMatch(
      /Sketch text/
    );
    // The same string fits in a new sketch.
    expect(textPlacementBudgetError(document, null, 'A')).toBeNull();
  });

  it('never lets a stand-in key mask a real node with the same id', () => {
    // The document sits exactly at its code-unit ceiling, and one of its
    // longest strings is stored under the id the stand-in used to take
    // (and a sketch under the stand-in sketch's id).
    const long = 'x'.repeat(MAX_TEXT_OBJECT_CODE_UNITS);
    const perSketch = MAX_SKETCH_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS;
    const count = MAX_DOCUMENT_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS;
    const nodes: Record<string, unknown> = {};
    for (let sketch = 0; sketch * perSketch < count; sketch += 1) {
      const objectIds: string[] = [];
      for (let index = 0; index < perSketch; index += 1) {
        const id =
          sketch === 0 && index === 0
            ? 'sketch-text-draft'
            : `text_${sketch}_${index}`;
        nodes[id] = {
          kind: 'sketch-object',
          data: { objectKind: 'text', text: long }
        };
        objectIds.push(id);
      }
      nodes[sketch === 0 ? 'sketch-text-draft-sketch' : `node_${sketch}`] = {
        kind: 'sketch',
        sketchId: `sketch_${sketch}`,
        objectIds
      };
    }
    const document = { nodes } as unknown as BudgetDocument;
    expect(documentTextBudgetError(document)).toBeNull();
    // One more code unit anywhere crosses the ceiling.
    expect(textPlacementBudgetError(document, null, 'A')).toMatch(
      /Project text/
    );
  });

  it('keeps clear of keys that only undo history holds', () => {
    const document = documentWithText(MAX_DOCUMENT_TEXT_OBJECTS - 1);
    // A deleted text node, remembered by history under the old stand-in id.
    const withHistory = {
      ...document,
      editHistory: {
        entries: [
          {
            changes: [
              {
                kind: 'value',
                field: 'nodes',
                key: 'sketch-text-draft',
                before: {
                  kind: 'sketch-object',
                  data: { objectKind: 'text', text: 'gone' }
                }
              }
            ]
          }
        ]
      }
    } as unknown as BudgetDocument;
    expect(documentTextBudgetError(withHistory)).toBeNull();
    expect(textPlacementBudgetError(withHistory, null, 'A')).toMatch(
      /Project text/
    );
  });
});

describe('textDraftPlaceable', () => {
  it('needs a string and a size that resolves now, as the card and the click do', () => {
    const draft = { ...newSketchTextDraft(), text: 'Boa' };
    expect(textDraftPlaceable(draft, {})).toBe(true);
    expect(textDraftPlaceable({ ...draft, text: '' }, {})).toBe(false);
    expect(textDraftPlaceable({ ...draft, size: 0 }, {})).toBe(false);
    expect(textDraftPlaceable({ ...draft, size: -2 }, {})).toBe(false);
    expect(textDraftPlaceable(null, {})).toBe(false);
  });

  it('reads a parameter-driven size from the scope at call time', () => {
    const draft = { ...newSketchTextDraft(), text: 'Boa', size: 'h' };
    expect(resolvedTextDraftSize(draft, { h: 8 })).toBe(8);
    expect(textDraftPlaceable(draft, { h: 8 })).toBe(true);
    // `h` set to 0 elsewhere while the card is open: nothing to place.
    expect(resolvedTextDraftSize(draft, { h: 0 })).toBeNull();
    expect(canPlaceTextDraft(draft, { h: 0 }, {})).toBe(false);
    // `h` removed: the expression no longer resolves.
    expect(canPlaceTextDraft(draft, {}, {})).toBe(false);
  });
});

describe('canPlaceTextDraft', () => {
  const draft = { ...newSketchTextDraft(), text: 'Boa' };

  it('places a placeable draft when nothing blocks it', () => {
    expect(canPlaceTextDraft(draft, {}, {})).toBe(true);
    expect(
      canPlaceTextDraft(draft, {}, { busy: false, budgetError: null })
    ).toBe(true);
  });

  it('places nothing while a solve or rebuild owns the sketch', () => {
    // The card disables Place while busy; the plane click asks this same
    // rule, so a click mid-solve commits nothing either.
    expect(canPlaceTextDraft(draft, {}, { busy: true })).toBe(false);
  });

  it('places nothing over budget, or for a draft the card cannot place', () => {
    expect(
      canPlaceTextDraft(draft, {}, { budgetError: 'Project text exceeds' })
    ).toBe(false);
    expect(canPlaceTextDraft({ ...draft, size: 0 }, {}, {})).toBe(false);
    expect(canPlaceTextDraft({ ...draft, text: '' }, {}, {})).toBe(false);
  });
});
