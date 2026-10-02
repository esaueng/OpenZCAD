import type { ProjectDocument } from './index';

/**
 * Text outlines expand into many exact curves, followed by pairwise glyph
 * overlap tests. Bound the input before that work, including whitespace and
 * line breaks. UTF-16 length is constant-time and never splits a surrogate
 * pair: requests are accepted whole or refused whole.
 *
 * 256 units allow long labels while bounding one overlap pass to at most
 * 32,640 glyph pairs. Collection limits also prevent splitting a large label
 * across objects. These limits apply to construction text too, since the
 * viewport expands its outlines.
 */
export const MAX_TEXT_OBJECT_CODE_UNITS = 256;
export const MAX_SKETCH_TEXT_CODE_UNITS = 1024;
export const MAX_SKETCH_TEXT_OBJECTS = 32;
export const MAX_DOCUMENT_TEXT_CODE_UNITS = 4096;
export const MAX_DOCUMENT_TEXT_OBJECTS = 128;

export function textObjectBudgetError(text: unknown): string | null {
  if (typeof text !== 'string') {
    return 'Text must be a string before its outlines can be expanded.';
  }
  return text.length > MAX_TEXT_OBJECT_CODE_UNITS
    ? `Text exceeds the outline limit of ${MAX_TEXT_OBJECT_CODE_UNITS} UTF-16 code units per object. Shorten the text before rebuilding.`
    : null;
}

/** Count occurrences, including repeated references to the same object. */
export function textSketchBudgetError(texts: Iterable<unknown>): string | null {
  let objectCount = 0;
  let codeUnits = 0;
  for (const text of texts) {
    const error = textObjectBudgetError(text);
    if (error) return error;
    objectCount += 1;
    codeUnits += (text as string).length;
    if (
      objectCount > MAX_SKETCH_TEXT_OBJECTS ||
      codeUnits > MAX_SKETCH_TEXT_CODE_UNITS
    ) {
      return `Sketch text exceeds the outline limit of ${MAX_SKETCH_TEXT_OBJECTS} objects or ${MAX_SKETCH_TEXT_CODE_UNITS} UTF-16 code units. Reduce the sketch text before rebuilding.`;
    }
  }
  return null;
}

/**
 * Bound every node variant that undo/redo can restore. Repeated edits to one
 * storage key count once at its largest text size, rather than charging every
 * historical copy. Sketch references count occurrences, so duplicate object
 * ids and the same label consumed by several sketches cannot multiply work.
 */
export function documentTextBudgetError(
  document: Pick<ProjectDocument, 'nodes' | 'editHistory'>
): string | null {
  const textLengths = new Map<string, number>();
  const sketches = new Map<string, string[][]>();
  let storedUnits = 0;
  let error: string | null = null;
  const visit = (key: string, node: unknown): void => {
    if (error || !node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (
      record.kind === 'sketch-object' &&
      record.data &&
      typeof record.data === 'object'
    ) {
      const data = record.data as Record<string, unknown>;
      if (data.objectKind !== 'text') return;
      error = textObjectBudgetError(data.text);
      if (error) return;
      const length = (data.text as string).length;
      const previous = textLengths.get(key);
      if (previous === undefined || length > previous) {
        textLengths.set(key, length);
        storedUnits += length - (previous ?? 0);
      }
      if (
        storedUnits > MAX_DOCUMENT_TEXT_CODE_UNITS ||
        textLengths.size > MAX_DOCUMENT_TEXT_OBJECTS
      ) {
        error = `Project text exceeds the outline limit of ${MAX_DOCUMENT_TEXT_OBJECTS} objects or ${MAX_DOCUMENT_TEXT_CODE_UNITS} UTF-16 code units, including undo history.`;
      }
    } else if (record.kind === 'sketch' && Array.isArray(record.objectIds)) {
      const variants = sketches.get(key);
      if (variants) variants.push(record.objectIds as string[]);
      else sketches.set(key, [record.objectIds as string[]]);
    }
  };
  const visitNodes = (nodes: unknown): void => {
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return;
    for (const [key, node] of Object.entries(nodes)) {
      visit(key, node);
      if (error) return;
    }
  };
  visitNodes(document.nodes);
  for (const entry of document.editHistory?.entries ?? []) {
    if (error) return error;
    for (const change of entry.changes) {
      if (change.kind !== 'value' || change.field !== 'nodes') continue;
      for (const value of [change.before, change.after]) {
        if (change.key === undefined) visitNodes(value);
        else visit(change.key, value);
        if (error) return error;
      }
    }
  }
  if (error) return error;
  let projectCount = 0;
  let projectUnits = 0;
  for (const variants of sketches.values()) {
    let maxCount = 0;
    let maxUnits = 0;
    for (const ids of variants) {
      let count = 0;
      let units = 0;
      for (const id of ids) {
        // Consumers index document.nodes[id]. Reject coercible non-string
        // ids rather than letting that lookup bypass the multiplicity count.
        if (typeof id !== 'string')
          return 'Sketch object references must be strings before text outlines can be expanded.';
        const length = textLengths.get(id);
        if (length === undefined) continue;
        count += 1;
        units += length;
        if (
          count > MAX_SKETCH_TEXT_OBJECTS ||
          units > MAX_SKETCH_TEXT_CODE_UNITS
        ) {
          return `Sketch text exceeds the outline limit of ${MAX_SKETCH_TEXT_OBJECTS} objects or ${MAX_SKETCH_TEXT_CODE_UNITS} UTF-16 code units. Reduce the sketch text before rebuilding.`;
        }
      }
      maxCount = Math.max(maxCount, count);
      maxUnits = Math.max(maxUnits, units);
    }
    projectCount += maxCount;
    projectUnits += maxUnits;
    if (
      projectCount > MAX_DOCUMENT_TEXT_OBJECTS ||
      projectUnits > MAX_DOCUMENT_TEXT_CODE_UNITS
    ) {
      return `Project text references exceed the outline limit of ${MAX_DOCUMENT_TEXT_OBJECTS} objects or ${MAX_DOCUMENT_TEXT_CODE_UNITS} UTF-16 code units. Reduce the project text before rebuilding.`;
    }
  }
  return null;
}

export function assertDocumentTextBudget(
  document: Pick<ProjectDocument, 'nodes' | 'editHistory'>
): void {
  const error = documentTextBudgetError(document);
  if (error) throw new Error(error);
}
