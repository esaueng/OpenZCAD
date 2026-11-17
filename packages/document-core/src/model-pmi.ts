import {
  assertModelPmiSet,
  deepClone,
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
    annotations[pmiIndex(annotations, input.annotation.pmiId)] = deepClone(
      input.annotation
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
