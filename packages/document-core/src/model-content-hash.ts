import type { ProjectDocument } from '@openzcad/shared';

/**
 * What a document carries that no rebuild or geometry check reads: its
 * history records, and the state derived from a build. The version is a
 * counter of edits, not content: two documents can share a version and
 * differ (a room's document adopted in place), or differ in version alone.
 */
const NOT_MODEL_CONTENT: ReadonlySet<string> = new Set([
  'version',
  'derived',
  'editHistory',
  'revisions',
  'checkpoints',
  'commandLog'
]);

/** cyrb53: two 32-bit lanes folded to 53 bits, in base 36. */
function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A hash of the model a geometry check reads: every part of the document
 * but its history records, derived state and version counter, so features,
 * parameters, the configuration table and its rows, the assembly and the
 * units are all in it. A result is of the model whose hash it was started
 * with; the document version alone does not say that, since a model can be
 * replaced at the same version.
 *
 * Deliberately wide: content a check never reads (a name) changes it too,
 * which only ever marks a result out of date or builds a row again. It is
 * the serialized content's hash, so two documents that read the same but
 * list their keys in another order hash differently; that errs the same way.
 */
export function modelContentHash(document: ProjectDocument): string {
  // The document's own fields only: a nested `version` is content.
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document))
    if (!NOT_MODEL_CONTENT.has(key)) content[key] = value;
  const text = JSON.stringify(content);
  return `${text.length.toString(36)}.${hashText(text)}`;
}
