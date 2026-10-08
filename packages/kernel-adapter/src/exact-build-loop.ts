import { OperationCancellationToken, type RemusKernel } from './remus-runtime';
import {
  isBuildCancelled,
  throwIfBuildCancelled,
  type BuildCancellation,
  type BuildCancellationSignal
} from './exact-cancellation';
import {
  getParameterScope,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureId,
  type FeatureNode,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import type { ExactBuildResult, ImportedStepDiagnostics } from './exact-types';
import type {
  StrictUnionVerdict as BooleanHelperStrictUnionVerdict,
  UnionVerdictsWithMeshBudget
} from './exact-boolean-helpers';
import { buildFeature } from './exact-feature-builders';
import { kernelRefusalRecordOf } from './kernel-refusal';
import {
  firstManualSuppressionIndex,
  passSuppressedFeatureThrough,
  withholdReferenceRepairs
} from './exact-suppression';

/**
 * A parsed STEP import held for reuse: the translator's exact arena document
 * plus the diagnostics the parse produced, so a cache hit reports what the
 * original parse reported rather than a silently emptier set.
 */
export interface CachedImportedStep {
  document: Uint8Array;
  /**
   * Accepted roots' zero-based indices in the file's declared order, so a
   * cache restore excludes rejected roots before applying subset selection.
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
    document: Uint8Array,
    acceptedDeclaredIndices: number[],
    diagnostics: ImportedStepDiagnostics,
    pinned: ReadonlySet<string>
  ): 'cached' | 'budget-exceeded' | 'rejected-roots';
}

/**
 * Strict verdicts the union gate established while producing a solid, keyed
 * by kernel handle, handed to the same sync's measurement pass so it does
 * not validate the same handle again. Scoped to one sync: handles are never
 * mutated in place after their feature ran, and the map dies with the sync.
 */
export type StrictUnionVerdicts = UnionVerdictsWithMeshBudget;

/**
 * What the union gate learned about a solid while producing it, so the
 * later checks on the same handle (the union refusal, the strict
 * measurement pass) reuse the verdict instead of validating a NURBS-heavy
 * body again. `meshClosed` stays undefined when it was never needed: a
 * solid whose strict validation already failed is refused without
 * tessellating it.
 */
export type StrictUnionVerdict = BooleanHelperStrictUnionVerdict;

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
  /**
   * Transient lineage demand for this rebuild: body ids whose producing
   * booleans must probe. UI state only, never persisted; threaded into
   * `booleanEvolutionProbeNeeded` alongside the persisted gate.
   */
  lineageDemand?: ReadonlySet<BodyId>;
  importedSteps?: ImportedStepStore;
  /**
   * Strict verdicts the union gate established on the solids it produced,
   * keyed by kernel handle, for the measurement pass of the same sync.
   * Scoped to one sync: handles are never mutated in place after their
   * feature ran, and the map is dropped before the next sync builds
   * anything.
   */
  strictVerdicts?: StrictUnionVerdicts;
  /**
   * The linear display deflection a body was last meshed at, if the adapter
   * holds one (see `heldDisplayTessellation`). The union gate meshes its
   * result at that value when the body's size stays close, so the projection
   * it retains for measurement is the one measurement asks for and the
   * kernel's per-face mesh reuse applies to it.
   */
  heldDisplayDeflection?: (bodyId: BodyId) => number | undefined;
  /**
   * This rebuild's cancellation state. Always set by the loop itself (one
   * shared kernel token per build); builders read the token for the
   * cancellable booleans and the signal for their own probes. Optional only
   * so a directly constructed context still compiles.
   */
  cancellation?: BuildCancellation;
}

/** The narrowed data payload for one feature kind (or a union of kinds). */
export type FeatureDataOf<K extends FeatureNode['data']['featureKind']> =
  Extract<FeatureNode['data'], { featureKind: K }>;

export interface PrimitiveReuse {
  restore(
    index: number,
    feature: FeatureNode,
    result: ExactBuildResult
  ): boolean;
  store(index: number, feature: FeatureNode, result: ExactBuildResult): void;
}

function* buildDocumentHistorySteps(
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
  onFeature?: (index: number, result: ExactBuildResult) => void,
  /** Diagnostic hook before synchronous feature work begins. */
  onFeatureStart?: (index: number) => void,
  /** Receives the union gate's verdicts; see {@link FeatureBuildContext}. */
  strictVerdicts?: StrictUnionVerdicts,
  primitiveReuse?: PrimitiveReuse,
  /**
   * Cooperative cancel for a superseded rebuild. Checked at each feature
   * boundary; a fired signal throws the typed `cancelled` refusal instead of
   * returning, so a cancelled build commits nothing. Absent, the loop runs
   * exactly as before.
   */
  signal?: BuildCancellationSignal,
  /**
   * Transient lineage demand for this rebuild. Threaded into the context so
   * `buildBooleanFeature` probes demanded bodies; the history digest carries
   * the same bit so a carrier-only checkpoint is never reused once demanded.
   */
  lineageDemand?: ReadonlySet<BodyId> | readonly BodyId[],
  /** See {@link FeatureBuildContext.heldDisplayDeflection}. */
  heldDisplayDeflection?: (bodyId: BodyId) => number | undefined
): Generator<void, ExactBuildResult> {
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
  // Features after this index build on a model with a step left out; see
  // `withholdReferenceRepairs`. Read from the document, not from this run, so
  // a prefix-restored build draws the same line as a full one.
  const firstSuppressed = firstManualSuppressionIndex(features);
  const normalizedDemand =
    lineageDemand === undefined
      ? undefined
      : lineageDemand instanceof Set
        ? lineageDemand
        : new Set(lineageDemand);
  // One shared token per build: it latches on the first observed cancel, so
  // every later boolean in the same superseded build refuses at the kernel.
  const cancellation: BuildCancellation | undefined =
    signal === undefined
      ? undefined
      : { signal, token: new OperationCancellationToken() };
  const ctx: FeatureBuildContext = {
    kernel,
    document,
    scope,
    result,
    importSources,
    pinnedImports,
    ...(normalizedDemand !== undefined
      ? { lineageDemand: normalizedDemand }
      : {}),
    importedSteps,
    strictVerdicts,
    ...(heldDisplayDeflection === undefined ? {} : { heldDisplayDeflection }),
    ...(cancellation === undefined ? {} : { cancellation })
  };

  try {
    for (let index = startIndex; index < features.length; index += 1) {
      const feature = features[index]!;
      // A superseded rebuild stops at the next feature boundary: the
      // in-flight WASM call still runs to completion, everything after it
      // does not start.
      throwIfBuildCancelled(signal);
      onFeatureStart?.(index);
      if (isFeatureSuppressed(feature)) {
        const message = `Feature "${feature.name}": Suppressed; skipped during exact rebuild.`;
        result.warnings.push(message);
        // Suppression is a status, not a failure. It reads identically to the
        // catch below once it is a string, which is why the attribution has to
        // be recorded rather than parsed back out.
        attribute(result, feature, message, 'suppressed');
        // A skipped step that replaced one body leaves that body, unchanged,
        // where its dependents look for the result (F1 follow-up).
        passSuppressedFeatureThrough(result, feature);
        onFeature?.(index, result);
        yield;
        continue;
      }
      try {
        if (!primitiveReuse?.restore(index, feature, result)) {
          buildFeature(ctx, feature);
          primitiveReuse?.store(index, feature, result);
        }
        if (firstSuppressed >= 0 && index > firstSuppressed) {
          withholdReferenceRepairs(result, feature);
        }
      } catch (error) {
        // Cancellation is not a feature verdict: recording it as a warning
        // would continue the build it exists to stop, and commit a partial
        // result as if the remaining features had run.
        if (isBuildCancelled(error)) {
          throw error;
        }
        const reason =
          error instanceof Error ? error.message : 'exact geometry failed';
        const message = `Feature "${feature.name}": ${reason}`;
        result.warnings.push(message);
        // A refused kernel operation carries its category with it, however
        // deeply the builder wrapped the error. Recording it here is what lets
        // downstream code tell "the engine will not do this pair" from "the
        // body came back malformed" without matching on the sentence.
        attribute(
          result,
          feature,
          message,
          'build-failed',
          kernelRefusalRecordOf(error)
        );
      }
      onFeature?.(index, result);
      yield;
    }
    return result;
  } finally {
    cancellation?.token.free();
  }
}

/** Synchronous replay for callers that do not need worker message delivery. */
export function buildDocumentHistory(
  ...args: Parameters<typeof buildDocumentHistorySteps>
): ExactBuildResult {
  const steps = buildDocumentHistorySteps(...args);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Same ordered replay, with optional task-level yields between features. The
 * generator owns the cancellation token; closing it also frees the token when
 * the scheduler throws. Kernel calls and checkpoint commits remain indivisible.
 */
export async function buildDocumentHistoryAsync(
  controls: {
    yieldControl?: () => Promise<void> | void;
    /** Open synchronous read scopes only while advancing the generator. */
    runStep?: <T>(step: () => T) => T;
  },
  ...args: Parameters<typeof buildDocumentHistorySteps>
): Promise<ExactBuildResult> {
  const steps = buildDocumentHistorySteps(...args);
  const runStep = controls.runStep ?? ((step) => step());
  try {
    let step = runStep(() => steps.next());
    while (!step.done) {
      const pending = controls.yieldControl?.();
      if (pending) await pending;
      step = runStep(() => steps.next());
    }
    return step.value;
  } catch (error) {
    // Throwing into the suspended loop runs its token-owning finally block.
    runStep(() => steps.throw(error));
    throw error;
  }
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
  kind: FeatureWarning['kind'],
  kernelRefusal?: FeatureWarning['kernelRefusal']
): void {
  result.featureWarnings.push({
    featureId: feature.featureId,
    featureName: feature.name,
    message,
    kind,
    ...(kernelRefusal ? { kernelRefusal } : {})
  });
}

/** Advance each feature inside its memo scope, yielding only after closing it. */
export async function buildDocumentHistoryCooperatively(
  scheduling: {
    run<T>(work: () => T): T;
    checkpoint(): Promise<void>;
  },
  ...args: Parameters<typeof buildDocumentHistorySteps>
): Promise<ExactBuildResult> {
  const steps = buildDocumentHistorySteps(...args);
  try {
    while (true) {
      const step = scheduling.run(() => steps.next());
      if (step.done) return step.value;
      await scheduling.checkpoint();
    }
  } catch (error) {
    // Close the generator's transaction/cancellation token even if yielding
    // itself fails. The generator's finally runs before the error propagates.
    scheduling.run(() => steps.throw(error));
    throw error;
  }
}
