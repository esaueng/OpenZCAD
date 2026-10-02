import { documentNodesWithHistory } from './document-history';
import {
  isImportedSourceReference,
  type FeatureData,
  type ProjectDocument
} from './index';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime source-field contract for exact imports received from storage or peers. */
export function isImportedStepSourceData(
  value: unknown
): value is Extract<FeatureData, { featureKind: 'imported-step' }> {
  if (!isRecord(value)) return false;
  return (
    value.featureKind === 'imported-step' &&
    typeof value.artifactId === 'string' &&
    typeof value.sourceName === 'string' &&
    (value.stepText === undefined || typeof value.stepText === 'string') &&
    (value.stepSourceRef === undefined ||
      isImportedSourceReference(value.stepSourceRef)) &&
    (value.stepText === undefined) !== (value.stepSourceRef === undefined)
  );
}

/** Checks active imports and imports that undo/redo can restore. Not a full document validator. */
export function hasValidImportedStepSources(
  document: ProjectDocument
): boolean {
  if (!isRecord(document.nodes)) return false;
  for (const node of documentNodesWithHistory(document)) {
    if (!isRecord(node)) return false;
    if (node.kind !== 'feature') continue;
    if (!isRecord(node.data)) return false;
    if (
      (node.featureKind === 'imported-step' ||
        node.data.featureKind === 'imported-step') &&
      !isImportedStepSourceData(node.data)
    )
      return false;
  }
  return true;
}
