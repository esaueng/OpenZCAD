import {
  isFeatureSuppressed,
  type FeatureNode,
  type StandardPartBuild
} from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import {
  PreparedEditSession,
  type PreparedEditEntries
} from './prepared-edit-session';

interface Entry {
  index: number;
  digest: string;
  shape: ExactShape;
  /** A standard part's derived lengths (M17), restored with its shape. */
  standardPart?: StandardPartBuild;
}

/**
 * Builders whose result is a pure function of their own data and digest:
 * a primitive, and (M17) a standard part on a plane, which reads no other
 * body and makes its solids afresh. A part in a hole reads the hole's
 * body, so it is rebuilt.
 */
function selfContained(feature: FeatureNode): boolean {
  const data = feature.data;
  return (
    data.featureKind === 'primitive' ||
    (data.featureKind === 'standard-part' && data.hole === undefined)
  );
}

function copyShape(shape: ExactShape): ExactShape {
  return {
    solids: [...shape.solids],
    ...(shape.rectangularStock !== undefined
      ? { rectangularStock: shape.rectangularStock }
      : {}),
    ...(shape.lineage
      ? {
          lineage: {
            faceReferences: new Map(shape.lineage.faceReferences),
            edgeReferences: new Map(shape.lineage.edgeReferences),
            diagnostics: [...shape.lineage.diagnostics]
          }
        }
      : {})
  };
}

/**
 * Audited builders leave input solids intact: transforms copy first, modifiers
 * and booleans produce new solids, and sketches change only build-local state.
 * They still replay in history order and read the newly rebuilt operands. An
 * unreviewed builder must retain the checkpoint restore path.
 */
function preservesPrimitiveInputs(feature: FeatureNode): boolean {
  if (selfContained(feature)) return true;
  switch (feature.data.featureKind) {
    case 'primitive':
    case 'sketch':
    case 'extrude':
    case 'revolve':
    case 'transform':
    case 'boolean':
    case 'fillet':
    case 'chamfer':
    case 'pattern':
    case 'direct-edit':
      return true;
    default:
      return false;
  }
}

/** Same-kernel immutable results; every actual topology restore retires its tail. */
/**
 * The independent-reuse tables of one kernel state, as a persisted session
 * carries them (`exact-session-snapshot.ts`). Structured-clonable; every
 * handle names an entity of the kernel snapshot stored beside it.
 */
export interface PrimitiveReuseState {
  primitives: [FeatureNode['featureId'], Entry][];
  prepared: PreparedEditEntries;
}

export class PrimitiveBuildCache {
  private readonly entries = new Map<FeatureNode['featureId'], Entry>();
  private readonly prepared = new PreparedEditSession();

  clear(): void {
    this.prepared.clear();
    this.entries.clear();
  }

  /** The tables for a persisted session of the kernel's current state. */
  exportState(): PrimitiveReuseState {
    return {
      primitives: structuredClone([...this.entries]),
      prepared: this.prepared.exportEntries()
    };
  }

  /**
   * Adopts a persisted session's tables after its kernel snapshot was
   * restored, so the first edit after a reopen reuses independent results
   * as the session that captured them did instead of replaying them.
   * `digests` are the restored history's; an entry whose feature is not at
   * its recorded position with its recorded digest is dropped.
   */
  importState(
    state: PrimitiveReuseState,
    features: readonly FeatureNode[],
    digests: readonly string[]
  ): void {
    this.clear();
    const indexOf = new Map(
      features.map((feature, index) => [feature.featureId, index])
    );
    const current = (
      featureId: FeatureNode['featureId'],
      index: number,
      digest: string
    ) => indexOf.get(featureId) === index && digests[index] === digest;
    for (const [featureId, entry] of state.primitives)
      if (current(featureId, entry.index, entry.digest))
        this.entries.set(featureId, entry);
    this.prepared.importEntries(state.prepared, current);
  }

  prune(features: readonly FeatureNode[]): void {
    this.prepared.prune(features);
    const present = new Set(features.map((feature) => feature.featureId));
    for (const key of this.entries.keys()) {
      if (!present.has(key)) this.entries.delete(key);
    }
  }

  restoredThrough(index: number): void {
    this.prepared.restoredThrough(index);
    for (const [key, entry] of this.entries) {
      if (entry.index > index) this.entries.delete(key);
    }
  }

  private matching(feature: FeatureNode, digest: string): Entry | undefined {
    if (!selfContained(feature) || isFeatureSuppressed(feature)) {
      return undefined;
    }
    const entry = this.entries.get(feature.featureId);
    return entry?.digest === digest ? entry : undefined;
  }

  canReuseTail(
    features: readonly FeatureNode[],
    digests: readonly string[],
    startIndex: number
  ): boolean {
    const tail = features.slice(startIndex);
    // Primitives and audited immutable branches can be reused. Other builders
    // replay against this run's shapes, consumption, diagnostics and references. Retaining
    // the arena avoids retiring independent primitive handles just because a
    // dependent builder happens to follow them in history order.
    return (
      tail.length > 0 &&
      tail.every(preservesPrimitiveInputs) &&
      tail.some(
        (feature, offset) =>
          this.matching(feature, digests[startIndex + offset]!) ||
          this.prepared.has(feature, digests[startIndex + offset]!)
      )
    );
  }

  restore(
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult,
    allowReuse = true
  ): boolean {
    const entry = this.matching(feature, digest);
    if (!entry || !feature.bodyId || !allowReuse)
      return this.prepared.restore(feature, digest, result, allowReuse);
    result.shapes.set(feature.bodyId, copyShape(entry.shape));
    if (entry.standardPart) {
      (result.standardParts ??= new Map()).set(feature.featureId, {
        lengthsMm: [...entry.standardPart.lengthsMm]
      });
    }
    return true;
  }

  store(
    index: number,
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult
  ): void {
    this.prepared.store(index, feature, digest, result);
    if (!selfContained(feature) || !feature.bodyId) return;
    const shape = result.shapes.get(feature.bodyId);
    if (shape) {
      const standardPart = result.standardParts?.get(feature.featureId);
      this.entries.set(feature.featureId, {
        index,
        digest,
        shape: copyShape(shape),
        ...(standardPart
          ? { standardPart: { lengthsMm: [...standardPart.lengthsMm] } }
          : {})
      });
    }
  }
}
