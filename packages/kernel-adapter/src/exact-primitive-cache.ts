import { isFeatureSuppressed, type FeatureNode } from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';

interface Entry {
  index: number;
  digest: string;
  shape: ExactShape;
}

function copyShape(shape: ExactShape): ExactShape {
  return {
    solids: [...shape.solids],
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

/** Same-kernel primitive results; every actual topology restore retires its tail. */
export class PrimitiveBuildCache {
  private readonly entries = new Map<FeatureNode['featureId'], Entry>();

  clear(): void {
    this.entries.clear();
  }

  prune(features: readonly FeatureNode[]): void {
    const present = new Set(features.map((feature) => feature.featureId));
    for (const key of this.entries.keys()) {
      if (!present.has(key)) this.entries.delete(key);
    }
  }

  restoredThrough(index: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.index > index) this.entries.delete(key);
    }
  }

  private matching(feature: FeatureNode, digest: string): Entry | undefined {
    if (
      feature.data.featureKind !== 'primitive' ||
      isFeatureSuppressed(feature)
    ) {
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
    // Only primitives are reused. Dependent builders replay against this run's
    // shapes, consumed set, sketch bases, diagnostics and references. Retaining
    // the arena avoids retiring independent primitive handles just because a
    // dependent builder happens to follow them in history order.
    return (
      tail.length > 0 &&
      tail.every(preservesPrimitiveInputs) &&
      tail.some((feature, offset) =>
        this.matching(feature, digests[startIndex + offset]!)
      )
    );
  }

  restore(
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult
  ): boolean {
    const entry = this.matching(feature, digest);
    if (!entry || !feature.bodyId) return false;
    result.shapes.set(feature.bodyId, copyShape(entry.shape));
    return true;
  }

  store(
    index: number,
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult
  ): void {
    if (feature.data.featureKind !== 'primitive' || !feature.bodyId) return;
    const shape = result.shapes.get(feature.bodyId);
    if (shape) {
      this.entries.set(feature.featureId, {
        index,
        digest,
        shape: copyShape(shape)
      });
    }
  }
}
