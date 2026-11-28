import {
  assertModelPmiSet,
  deepClone,
  renameModelDatumReferences,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * D07 model PMI commands. Each carries the whole entry (add, update) or
 * its id (delete), so undo, redo and replay reproduce the same annotations
 * without reading the model: a PMI edit never rebuilds.
 */

export interface ModelPmiAddInput {
  annotation: ModelPmiAnnotation;
}

/** The entry as it should now be, whole; its id names the one replaced. */
export interface ModelPmiUpdateInput {
  annotation: ModelPmiAnnotation;
  /**
   * #2375 (schema v157): on a datum feature whose letter changes, every
   * frame that named its old letter names the new one, each reference
   * keeping its slot and modifier, in the same command (one undo step).
   * Absent, only the entry changes: a log written before v157 replays as
   * it was recorded.
   */
  followReferences?: true;
}

export interface ModelPmiDeleteInput {
  pmiId: ModelPmiId;
}

function withModelPmi(
  document: ProjectDocument,
  edit: (annotations: ModelPmiAnnotation[]) => ModelPmiAnnotation[]
): ProjectDocument {
  const before = document.pmi?.annotations ?? [];
  const annotations = edit(deepClone(before));
  // No change, no edit: the command manager records no version or undo.
  if (JSON.stringify(annotations) === JSON.stringify(before)) return document;
  const pmi = annotations.length > 0 ? { annotations } : undefined;
  assertModelPmiSet(pmi);
  const { pmi: _previous, ...rest } = document;
  return {
    ...rest,
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(pmi ? { pmi } : {}),
    version: document.version + 1
  };
}

function pmiIndex(annotations: ModelPmiAnnotation[], pmiId: ModelPmiId) {
  const index = annotations.findIndex((entry) => entry.pmiId === pmiId);
  if (index < 0) throw new Error(`PMI annotation ${pmiId} not found.`);
  return index;
}

export function addModelPmi(
  document: ProjectDocument,
  input: ModelPmiAddInput
): ProjectDocument {
  return withModelPmi(document, (annotations) => {
    if (annotations.some((entry) => entry.pmiId === input.annotation.pmiId))
      throw new Error(
        `PMI annotation ${input.annotation.pmiId} already exists.`
      );
    return [...annotations, deepClone(input.annotation)];
  });
}

export function updateModelPmi(
  document: ProjectDocument,
  input: ModelPmiUpdateInput
): ProjectDocument {
  return withModelPmi(document, (annotations) => {
    const index = pmiIndex(annotations, input.annotation.pmiId);
    const previous = annotations[index]!;
    annotations[index] = deepClone(input.annotation);
    if (
      input.followReferences === true &&
      previous.kind === 'datum-feature' &&
      input.annotation.kind === 'datum-feature' &&
      previous.letter !== input.annotation.letter
    )
      return renameModelDatumReferences(
        annotations,
        previous.letter,
        input.annotation.letter
      );
    return annotations;
  });
}

export function deleteModelPmi(
  document: ProjectDocument,
  input: ModelPmiDeleteInput
): ProjectDocument {
  return withModelPmi(document, (annotations) => {
    annotations.splice(pmiIndex(annotations, input.pmiId), 1);
    return annotations;
  });
}
