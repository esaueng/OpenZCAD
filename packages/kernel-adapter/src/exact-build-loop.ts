import type {
  RemusKernel
}  from './remus-runtime';
import {
  getParameterScope,
  listFeaturesInOrder
}  from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
}  from '@openzcad/shared';
import type {
  ExactBuildResult,
  ImportedStepDiagnostics
}  from './exact-types';
import {
  buildFeature
}  from './exact-feature-builders';

/**
 * A parsed STEP import held for reuse: the kernel's serialised solids plus the
 * diagnostics the parse produced, so a cache hit reports exactly what the
 * original parse reported rather than a silently emptier set.
 */
export interface CachedImportedStep {
  solids: Uint8Array[];
  /**
   * Each cached solid's zero-based index in the file's declared order, so a
   * feature that selects a subset can filter a file-level cache entry.
   */
  acceptedDeclaredIndices: number[];
  diagnostics: ImportedStepDiagnostics;
}

/**
 * Adapter-owned cache of parsed imports. The build loop only reads and
 * writes through this seam; retention and eviction stay with the owner.
 */
export interface ImportedStepStore {
  lookup(checksum: string): CachedImportedStep | undefined;
  store(
    checksum: string,
    kernel: RemusKernel,
    solids: number[],
    acceptedDeclaredIndices: number[],
    diagnostics: ImportedStepDiagnostics,
    pinned: ReadonlySet<string>
  ): void;
}

/**
 * Everything a per-feature builder may touch: the kernel, the document and
 * its parameter scope, the accumulating build result, and the import seams.
 * One shared shape keeps the 21 builders' signatures uniform.
 */
export interface FeatureBuildContext {
  kernel: RemusKernel;
  document: ProjectDocument;
  scope: Record<string, number>;
  result: ExactBuildResult;
  importSources: ReadonlyMap<string, Uint8Array>;
  pinnedImports: ReadonlySet<string>;
  importedSteps?: ImportedStepStore;
}

/** The narrowed data payload for one feature kind (or a union of kinds). */
export type FeatureDataOf<K extends FeatureNode['data']['featureKind']> =
  Extract<FeatureNode['data'], { featureKind: K }>;

export function buildDocumentHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  importSources: ReadonlyMap<string, Uint8Array> = new Map(),
  /** Import checksums this build reads; see {@link ImportedStepStore}. */
  pinnedImports: ReadonlySet<string> = new Set(importSources.keys()),
  /**
   * Prefix-restore continuation: the kernel already holds the state after
   * feature `startIndex - 1` and `initial` is that point's JS state, so
   * the loop replays only `startIndex..end`. The scope errors seeded into
   * fresh warnings below are already inside `initial`.
   */
  resume?: { startIndex: number; initial: ExactBuildResult },
  /** Parsed imported-STEP results shared across rebuilds, keyed by checksum. */
  importedSteps?: ImportedStepStore,
  /** Runs after every feature index this call executed, failed included. */
  onFeature?: (index: number, result: ExactBuildResult) => void
): ExactBuildResult {
  const { scope, errors } = getParameterScope(document);
  const result: ExactBuildResult = resume?.initial ?? {
    shapes: new Map(),
    sketchBases: new Map(),
    consumed: new Set(),
    importedStepDiagnostics: new Map(),
    meshBodies: new Set(),
    partialRevolveBodies: new Set(),
    warnings: [...errors],
    featureWarnings: [],
    referenceRepairs: []
  };
  const startIndex = resume?.startIndex ?? 0;
  const features = listFeaturesInOrder(document);
  const ctx: FeatureBuildContext = {
    kernel,
    document,
    scope,
    result,
    importSources,
    pinnedImports,
    importedSteps
  };

  for (let index = startIndex; index < features.length; index += 1) {
    const feature = features[index]!;
    if (isFeatureSuppressed(feature)) {
      const message = `Feature "${feature.name}": Suppressed; skipped during exact rebuild.`;
      result.warnings.push(message);
      // Suppression is a status, not a failure. It reads identically to the
      // catch below once it is a string, which is why the attribution has to
      // be recorded rather than parsed back out.
      attribute(result, feature, message, 'suppressed');
      onFeature?.(index, result);
      continue;
    }
    try {
      buildFeature(ctx, feature);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'exact geometry failed';
      const message = `Feature "${feature.name}": ${reason}`;
      result.warnings.push(message);
      attribute(result, feature, message, 'build-failed');
    }
    onFeature?.(index, result);
  }
  return result;
}

/**
 * Records who a loop-raised warning belongs to, alongside the string itself.
 *
 * The list is session-only — `attachDerivedState` strips it — so it never
 * reaches a saved or replayed document, and nothing downstream may treat it
 * as model state.
 */
function attribute(
  result: { warnings: string[]; featureWarnings: FeatureWarning[] },
  feature: { featureId: FeatureId; name: string },
  message: string,
  kind: FeatureWarning['kind']
): void {
  result.featureWarnings.push({
    featureId: feature.featureId,
    featureName: feature.name,
    message,
    kind
  });
}
