import type { ProjectDocument } from '@openzcad/shared';

/**
 * Parameters defined from an expression field (G5), tracked so an Inspector
 * edit form survives them.
 *
 * An edit form keys on the document version, so an undo or a collaborator's
 * edit reloads it. A parameter defined from one of that form's own fields
 * must not: the draft it was defined for ("hgt" in Height) would be replaced
 * by the stored value, and the definition would have been for nothing. A
 * definition can commit more than one version, and the workspace renders
 * them before the definition returns, so its versions are recognised by
 * their history label while it is in flight.
 */
export interface FieldDefinitionTracker {
  /** History label of each definition in flight → form version it began at. */
  pending: Map<string, number>;
  /** `projectId:version` a definition committed → form version it keeps. */
  versions: Map<string, number>;
}

type VersionedDocument = Pick<
  ProjectDocument,
  'projectId' | 'version' | 'revisions'
>;

export function createFieldDefinitionTracker(): FieldDefinitionTracker {
  return { pending: new Map(), versions: new Map() };
}

/**
 * The history label a parameter definition commits under: the one the
 * workspace's parameter set (`handleSetParameter` in App) gives its
 * transaction.
 */
export function fieldDefinitionLabel(name: string): string {
  return `Set parameter ${name}`;
}

/**
 * Marks a definition of `name` as in flight from `document`; call the result
 * once it has committed or been refused.
 */
export function beginFieldDefinition(
  tracker: FieldDefinitionTracker,
  name: string,
  document: VersionedDocument
): () => void {
  const label = fieldDefinitionLabel(name);
  tracker.pending.set(label, editFormVersion(tracker, document));
  return () => {
    tracker.pending.delete(label);
  };
}

/** The version an Inspector edit form keys on for `document`. */
export function editFormVersion(
  tracker: FieldDefinitionTracker,
  document: VersionedDocument
): number {
  const key = `${document.projectId}:${document.version}`;
  const reason = document.revisions.at(-1)?.reason;
  const base = reason === undefined ? undefined : tracker.pending.get(reason);
  if (base !== undefined && !tracker.versions.has(key)) {
    tracker.versions.set(key, base);
  }
  return tracker.versions.get(key) ?? document.version;
}
