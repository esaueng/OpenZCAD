import { describe, expect, it } from 'vitest';
import {
  assertDocumentTextBudget,
  documentTextBudgetError,
  MAX_DOCUMENT_TEXT_CODE_UNITS,
  MAX_DOCUMENT_TEXT_OBJECTS,
  MAX_SKETCH_TEXT_OBJECTS,
  MAX_TEXT_OBJECT_CODE_UNITS,
  type DocumentChange,
  type ProjectDocument
} from '@openzcad/shared';

const textNode = (text: string) => ({
  kind: 'sketch-object',
  data: { objectKind: 'text', text, construction: true }
});
const sketchNode = (objectIds: string[]) => ({ kind: 'sketch', objectIds });

// Synthetic deserialized data exercises the same pre-normalization boundary.
function document(
  nodes: Record<string, unknown>,
  changes: DocumentChange[] = []
): ProjectDocument {
  return {
    nodes,
    editHistory: { entries: [{ changes }] }
  } as unknown as ProjectDocument;
}

describe('document text outline budgets', () => {
  it('refuses excessive stored text even when no sketch currently references it', () => {
    const nodes = Object.fromEntries(
      Array.from(
        {
          length: MAX_DOCUMENT_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS + 1
        },
        (_, index) => [
          `label-${index}`,
          textNode('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS))
        ]
      )
    );
    expect(() => assertDocumentTextBudget(document(nodes))).toThrow(
      'Project text exceeds'
    );
    const emptyNodes = Object.fromEntries(
      Array.from({ length: MAX_DOCUMENT_TEXT_OBJECTS + 1 }, (_, index) => [
        `label-${index}`,
        textNode('')
      ])
    );
    expect(() => assertDocumentTextBudget(document(emptyNodes))).toThrow(
      'Project text exceeds'
    );
  });

  it('counts repeated sketch references and references from multiple sketches', () => {
    expect(() =>
      assertDocumentTextBudget(
        document({
          label: textNode('A'),
          sketch: sketchNode(
            Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, () => 'label')
          )
        })
      )
    ).toThrow('Sketch text exceeds');
    const sketches = Object.fromEntries(
      Array.from({ length: MAX_DOCUMENT_TEXT_OBJECTS + 1 }, (_, index) => [
        `sketch-${index}`,
        sketchNode(['label'])
      ])
    );
    expect(() =>
      assertDocumentTextBudget(document({ label: textNode('A'), ...sketches }))
    ).toThrow('Project text references exceed');
  });

  it('counts node-map aliases independently of a forged duplicate node id', () => {
    const node = { ...textNode(''), id: 'same-id' };
    const nodes = Object.fromEntries(
      Array.from({ length: MAX_DOCUMENT_TEXT_OBJECTS + 1 }, (_, index) => [
        `alias-${index}`,
        node
      ])
    );
    expect(() => assertDocumentTextBudget(document(nodes))).toThrow(
      'Project text exceeds'
    );
  });

  it('refuses coercible numeric sketch references instead of undercounting them', () => {
    const candidate = document({
      '1': textNode('A'),
      sketch: {
        kind: 'sketch',
        objectIds: Array(MAX_SKETCH_TEXT_OBJECTS + 1).fill(1)
      }
    });
    expect(() => assertDocumentTextBudget(candidate)).toThrow(
      'references must be strings'
    );
  });

  it.each(['before', 'after'] as const)(
    'refuses oversized keyed and whole-map undo/redo %s variants',
    (side) => {
      const node = textNode('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS + 1));
      for (const change of [
        {
          kind: 'value' as const,
          field: 'nodes' as const,
          key: 'label',
          [side]: node
        },
        {
          kind: 'value' as const,
          field: 'nodes' as const,
          [side]: { label: node }
        },
        {
          kind: 'value' as const,
          field: 'nodes' as const,
          key: 'sketch',
          [side]: sketchNode(
            Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, () => 'label')
          )
        }
      ]) {
        expect(() =>
          assertDocumentTextBudget(document({ label: textNode('A') }, [change]))
        ).toThrow('outline limit');
      }
    }
  );

  it('allows repeated edits and both complete document budgets without charging copies', () => {
    const changes: DocumentChange[] = Array.from({ length: 100 }, () => ({
      kind: 'value',
      field: 'nodes',
      key: 'label',
      before: textNode('A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS)),
      after: textNode('B')
    }));
    expect(
      documentTextBudgetError(
        document(
          { label: textNode('B'), sketch: sketchNode(['label']) },
          changes
        )
      )
    ).toBeNull();
    const nodes = Object.fromEntries(
      Array.from({ length: MAX_DOCUMENT_TEXT_OBJECTS }, (_, index) => [
        `label-${index}`,
        textNode(
          index < MAX_DOCUMENT_TEXT_CODE_UNITS / MAX_TEXT_OBJECT_CODE_UNITS
            ? 'A'.repeat(MAX_TEXT_OBJECT_CODE_UNITS)
            : ''
        )
      ])
    );
    expect(documentTextBudgetError(document(nodes))).toBeNull();
  });
});
