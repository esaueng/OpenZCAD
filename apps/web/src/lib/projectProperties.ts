import { withoutDerivedProjection } from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  persistedDocumentBytes,
  type ProjectDocument,
  type ProjectSummary,
  type UnitSystem
} from '@openzcad/shared';

export interface ProjectProperties {
  source: 'device' | 'account';
  olderDeviceCopy: boolean;
  updatedAt: string;
  startedAt?: string;
  oldestSaveAt?: string;
  units: UnitSystem;
  documentVersion: number;
  documentBytes: number;
  referencedSourceBytes: number;
  bodies: number;
  features: number;
  sketches: number;
  parameters: number;
  savePoints: number;
  branchedFrom?: ProjectDocument['branchedFrom'];
}

/** Inspect saved data only: no geometry rebuild, source-blob reads or writes. */
export function describeProject(
  document: ProjectDocument,
  source: ProjectProperties['source'],
  olderDeviceCopy = false
): ProjectProperties {
  const saves = [...document.revisions, ...(document.checkpoints ?? [])]
    .filter((save) => Number.isFinite(Date.parse(save.createdAt)))
    .sort(
      (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)
    );
  const initial = saves.find((save) => save.reason === 'Initial document');
  // A source can occur in several features and undo entries but is stored once.
  const sources = new Map<string, number>();
  for (const node of documentNodesWithHistory(document)) {
    if (node.kind === 'feature' && node.data.featureKind === 'imported-step') {
      const ref = node.data.stepSourceRef;
      if (ref) sources.set(ref.checksumSha256, ref.logicalBytes);
    }
  }
  return {
    source,
    olderDeviceCopy,
    updatedAt: document.derived.updatedAt,
    startedAt: document.branchedFrom?.branchedAt ?? initial?.createdAt,
    oldestSaveAt: saves[0]?.createdAt,
    units: document.units,
    documentVersion: document.version,
    documentBytes: persistedDocumentBytes(withoutDerivedProjection(document)),
    referencedSourceBytes: [...sources.values()].reduce(
      (sum, bytes) => sum + bytes,
      0
    ),
    bodies: document.bodyOrder.length,
    features: document.featureOrder.length,
    sketches: document.sketchOrder.length,
    parameters: document.parameterOrder.length,
    savePoints: document.checkpoints?.length ?? document.revisions.length,
    branchedFrom: document.branchedFrom
  };
}

export async function loadProjectProperties(
  project: ProjectSummary,
  host: {
    loadLocal(projectId: string): Promise<ProjectDocument | null>;
    loadAccount?(projectId: string): Promise<ProjectDocument>;
  }
): Promise<ProjectProperties | null> {
  const local = await host.loadLocal(project.projectId).catch(() => null);
  const localCurrent =
    local !== null &&
    (project.documentVersion !== undefined
      ? local.version >= project.documentVersion
      : local.derived.updatedAt >= project.updatedAt);
  if (localCurrent) return describeProject(local, 'device');
  if (host.loadAccount) {
    try {
      return describeProject(
        await host.loadAccount(project.projectId),
        'account'
      );
    } catch {
      // An offline account must not hide the saved device copy.
    }
  }
  return local ? describeProject(local, 'device', !localCurrent) : null;
}

export function formatProjectBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 })} ${units[index]}`;
}
