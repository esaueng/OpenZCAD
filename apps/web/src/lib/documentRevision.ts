import type { ProjectDocument } from '@openzcad/shared';

/**
 * A token that changes whenever the open document's content may have
 * changed, for views that must not act on a result built from an older
 * document (the flat-pattern export).
 *
 * `projectId:version` alone is not enough: adopting a document (a reload,
 * a restore, a collaborator's replacement) can bring different content at
 * the same version. Documents are replaced, never mutated, so the object
 * itself identifies its content; each distinct object gets its own serial.
 */
const serials = new WeakMap<ProjectDocument, number>();
let nextSerial = 1;

export function documentRevision(document: ProjectDocument): string {
  let serial = serials.get(document);
  if (serial === undefined) {
    serial = nextSerial;
    nextSerial += 1;
    serials.set(document, serial);
  }
  return `${document.projectId}:${document.version}:${serial}`;
}
