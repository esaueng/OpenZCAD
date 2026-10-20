import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureNode
} from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import { cloneBuildState } from './exact-history-cache';

interface Input {
  bodyId: BodyId;
  shape: ExactShape;
  consumed: boolean;
  mesh: boolean;
  partialRevolve: boolean;
}

interface Entry {
  index: number;
  digest: string;
  inputs: Input[];
  shapes: Map<BodyId, ExactShape>;
  consumed: BodyId[];
  mesh: BodyId[];
  partialRevolve: BodyId[];
}

function targets(feature: FeatureNode): BodyId[] | null {
  if (isFeatureSuppressed(feature)) return null;
  const data = feature.data;
  if (data.featureKind === 'transform') return [data.targetBodyId];
  // Unions retain per-sync strict verdicts and display meshes. Leave their
  // acceptance path intact; the expensive fixed carving intersections can
  // already be reused before the parameter-dependent final union.
  if (data.featureKind === 'boolean' && data.operation === 'intersect')
    return data.targetBodyIds;
  return null;
}

function sameShape(a: ExactShape, b: ExactShape): boolean {
  if (
    a.solids.length !== b.solids.length ||
    a.solids.some((id, index) => id !== b.solids[index]) ||
    a.sweepSource !== b.sweepSource
  )
    return false;
  if (!a.lineage || !b.lineage) return a.lineage === b.lineage;
  for (const key of ['faceReferences', 'edgeReferences'] as const) {
    const left = a.lineage[key],
      right = b.lineage[key];
    if (left.size !== right.size) return false;
    for (const [handle, reference] of left)
      if (right.get(handle) !== reference) return false;
  }
  return (
    a.lineage.diagnostics.length === b.lineage.diagnostics.length &&
    a.lineage.diagnostics.every(
      (value, i) => value === b.lineage!.diagnostics[i]
    )
  );
}

function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  return (
    a.size === b.size &&
    [...a].every(([key, value]) => b.has(key) && b.get(key) === value)
  );
}
function sameEntries<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Reusable, immutable construction branches in one retained kernel lifetime.
 * A feature digest alone is insufficient: exact operand handles, lineage and
 * mesh-origin flags must also match. No failed result or mutable document is
 * cached. Actual kernel restores retire tail entries through the owner.
 */
export class PreparedEditSession {
  private readonly entries = new Map<FeatureNode['featureId'], Entry>();
  private pending: {
    feature: FeatureNode;
    digest: string;
    inputs: Input[];
    before: ExactBuildResult;
  } | null = null;

  clear(): void {
    this.entries.clear();
    this.pending = null;
  }

  prune(features: readonly FeatureNode[]): void {
    const present = new Set(features.map((feature) => feature.featureId));
    for (const key of this.entries.keys())
      if (!present.has(key)) this.entries.delete(key);
  }

  restoredThrough(index: number): void {
    this.pending = null;
    for (const [key, entry] of this.entries)
      if (entry.index > index) this.entries.delete(key);
  }

  has(feature: FeatureNode, digest: string): boolean {
    return (
      targets(feature) !== null &&
      this.entries.get(feature.featureId)?.digest === digest
    );
  }

  restore(
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult,
    allowReuse: boolean
  ): boolean {
    this.pending = null;
    const ids = targets(feature);
    if (!ids || result.warnings.length || result.featureWarnings.length)
      return false;
    // Intersection outputs are new bodies in an audited history. Decline
    // malformed/overwriting contexts rather than replaying relative deltas
    // against pre-existing output metadata.
    if (
      feature.data.featureKind === 'boolean' &&
      feature.bodyId &&
      (result.shapes.has(feature.bodyId) ||
        result.consumed.has(feature.bodyId) ||
        result.meshBodies.has(feature.bodyId) ||
        result.partialRevolveBodies.has(feature.bodyId))
    )
      return false;
    const inputs: Input[] = [];
    for (const bodyId of ids) {
      const shape = result.shapes.get(bodyId);
      if (!shape) return false;
      inputs.push({
        bodyId,
        shape,
        consumed: result.consumed.has(bodyId),
        mesh: result.meshBodies.has(bodyId),
        partialRevolve: result.partialRevolveBodies.has(bodyId)
      });
    }
    const entry = this.entries.get(feature.featureId);
    if (
      allowReuse &&
      entry?.digest === digest &&
      inputs.length === entry.inputs.length &&
      inputs.every((input, i) => {
        const old = entry.inputs[i]!;
        return (
          input.bodyId === old.bodyId &&
          input.consumed === old.consumed &&
          input.mesh === old.mesh &&
          input.partialRevolve === old.partialRevolve &&
          sameShape(input.shape, old.shape)
        );
      })
    ) {
      const copy = cloneBuildState({ ...result, shapes: entry.shapes });
      for (const [id, shape] of copy.shapes) result.shapes.set(id, shape);
      for (const id of entry.consumed) result.consumed.add(id);
      for (const id of entry.mesh) result.meshBodies.add(id);
      for (const id of entry.partialRevolve)
        result.partialRevolveBodies.add(id);
      return true;
    }
    this.pending = { feature, digest, inputs, before: cloneBuildState(result) };
    return false;
  }

  store(
    index: number,
    feature: FeatureNode,
    digest: string,
    result: ExactBuildResult
  ): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.feature !== feature || pending.digest !== digest)
      return;
    const before = pending.before;
    // Cache only successful audited shape/consumption updates. Any new warning,
    // repair, datum/sketch/import side effect or removal keeps ordered replay.
    if (
      result.warnings.length ||
      result.featureWarnings.length ||
      !sameEntries(result.referenceRepairs, before.referenceRepairs) ||
      !sameEntries(
        result.faceReferenceRepairs ?? [],
        before.faceReferenceRepairs ?? []
      ) ||
      !sameMap(result.sketchBases, before.sketchBases) ||
      !sameMap(result.datumFrames, before.datumFrames) ||
      !sameMap(result.datumAxes, before.datumAxes) ||
      !sameMap(
        result.importedStepDiagnostics,
        before.importedStepDiagnostics
      ) ||
      [...before.shapes.keys()].some((id) => !result.shapes.has(id)) ||
      [...before.consumed].some((id) => !result.consumed.has(id)) ||
      [...before.meshBodies].some((id) => !result.meshBodies.has(id)) ||
      [...before.partialRevolveBodies].some(
        (id) => !result.partialRevolveBodies.has(id)
      )
    )
      return;
    const shapes = new Map(
      [...result.shapes].filter(([id, shape]) => {
        const old = before.shapes.get(id);
        return !old || !sameShape(old, shape);
      })
    );
    if (!shapes.size) return;
    const copy = cloneBuildState({ ...result, shapes });
    this.entries.delete(feature.featureId);
    this.entries.set(feature.featureId, {
      index,
      digest,
      inputs: pending.inputs,
      shapes: copy.shapes,
      consumed: [...result.consumed].filter((id) => !before.consumed.has(id)),
      mesh: [...result.meshBodies].filter((id) => !before.meshBodies.has(id)),
      partialRevolve: [...result.partialRevolveBodies].filter(
        (id) => !before.partialRevolveBodies.has(id)
      )
    });
    // Only the latest value per feature is retained; the kernel's replay-work
    // and checkpoint-byte budgets still own arena retention and recycling.
    while (this.entries.size > 64)
      this.entries.delete(this.entries.keys().next().value!);
  }
}
