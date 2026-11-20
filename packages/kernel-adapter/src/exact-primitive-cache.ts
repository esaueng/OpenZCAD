import {
  isFeatureSuppressed,
  type FeatureNode,
  type StandardPartBuild
} from '@openzcad/shared';
import type {
  ExactBuildResult,
  ExactShape,
  ImportedStepDiagnostics
} from './exact-types';
import { PreparedEditSession } from './prepared-edit-session';

interface Entry {
  index: number;
  digest: string;
  shape: ExactShape;
  /** A standard part's derived lengths (M17), restored with its shape. */
  standardPart?: StandardPartBuild;
  /** An imported STEP body's reader verdicts, restored with its shape. */
  importDiagnostics?: ImportedStepDiagnostics;
}

/**
 * Builders whose result is a pure function of their own data and digest:
 * a primitive, (M17) a standard part on a plane, which reads no other
 * body and makes its solids afresh, and (H02) an imported STEP body, whose
 * digest names its source bytes, reader, selection, planar emboss and
 * placement, and whose import reads no parameter and no other body. A part
 * in a hole reads the hole's body, so it is rebuilt.
 *
 * Reusing an import is the H02 detached Text cache: a history that imports
 * its fixed lettering after the parameter-driven holder (every recipe saved
 * before the import was moved ahead of the suffix) keeps the lettering's
 * solids in the live arena across holder edits instead of re-importing them.
 * Nothing is restored from a checkpoint, so no kernel branch operation is
 * involved; any restore before the import retires the entry with its handles.
 */
function selfContained(feature: FeatureNode): boolean {
  const data = feature.data;
  return (
    data.featureKind === 'primitive' ||
    data.featureKind === 'imported-step' ||
    (data.featureKind === 'standard-part' && data.hole === undefined)
  );
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
  if (selfContained(feature)) return true;
  switch (feature.data.featureKind) {
    case 'primitive':
    case 'imported-step':
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
export class PrimitiveBuildCache {
  private readonly entries = new Map<FeatureNode['featureId'], Entry>();
  private readonly prepared = new PreparedEditSession();

  clear(): void {
    this.prepared.clear();
    this.entries.clear();
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
    if (entry.importDiagnostics)
      result.importedStepDiagnostics.set(
        feature.bodyId,
        structuredClone(entry.importDiagnostics)
      );
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
    // Only a clean exact import: a mesh fallback or a warning keeps replay.
    if (
      feature.data.featureKind === 'imported-step' &&
      (result.meshBodies.has(feature.bodyId) ||
        result.featureWarnings.some(
          (warning) => warning.featureId === feature.featureId
        ) ||
        !result.importedStepDiagnostics.has(feature.bodyId))
    )
      return;
    if (shape) {
      const standardPart = result.standardParts?.get(feature.featureId);
      const importDiagnostics = result.importedStepDiagnostics.get(
        feature.bodyId
      );
      this.entries.set(feature.featureId, {
        index,
        digest,
        shape: copyShape(shape),
        ...(feature.data.featureKind === 'imported-step' && importDiagnostics
          ? { importDiagnostics: structuredClone(importDiagnostics) }
          : {}),
        ...(standardPart
          ? { standardPart: { lengthsMm: [...standardPart.lengthsMm] } }
          : {})
      });
    }
  }
}
