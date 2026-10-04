/**
 * The text card and the plane click must refuse exactly what the commit
 * would: the document-wide text budget, evaluated with the draft added.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_SKETCH_TEXT_OBJECTS,
  documentTextBudgetError,
  type ProjectDocument
} from '@openzcad/shared';
import { textPlacementBudgetError } from './textPlacement';

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
});
