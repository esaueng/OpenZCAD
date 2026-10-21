/**
 * A second JS lineage view of the SAME live checkpoint geometry. Only the
 * empty-demand view is retained; other effective probe combinations must
 * match the ordinary checkpoint or replay. No probe/scratch handles survive
 * here: every retained reference belongs to a shipped shape.
 */
import type { BodyId, FeatureNode, ProjectDocument } from '@openzcad/shared';
import { findSketch } from '@openzcad/document-core';
import type { ExactBuildResult, ExactShape } from './exact-types';
import type { RemusKernel } from './remus-runtime';
import {
  booleanEvolutionProbeNeeded,
  BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE,
  declinedBooleanEvidence,
  deriveBooleanLineage
} from './exact-boolean-evolution';
import {
  mergeRemusLineageStates,
  propagateRemusRigidTransformLineage,
  remusHashOnlyLineage,
  type RemusBooleanOperand,
  type RemusLineageState,
  type RemusTopologyCandidate
} from './remus-lineage';
import { topologyCandidatesForSolid } from './exact-lineage-builders';

export interface IdleLineageView {
  lineages: Map<BodyId, RemusLineageState | undefined>;
  /** A conservative flag: some prior feature selected different lineage. */
  diverged: boolean;
}

/** These outputs depend on their own inputs, never a prior shape's lineage. */
function independentLineageOutput(
  feature: FeatureNode,
  document: ProjectDocument
): boolean {
  const data = feature.data;
  if (data.featureKind === 'primitive' || data.featureKind === 'imported-step')
    return true;
  return (
    data.featureKind === 'extrude' &&
    (data.operation === undefined || data.operation === 'new-body') &&
    (data.endCondition === undefined || data.endCondition === 'blind') &&
    findSketch(document, data.sketchId)?.planeRef.type === 'canonical'
  );
}

/** Builders whose alternate metadata never resolves a reference-bound frame. */
export function supportsIdleLineageView(
  feature: FeatureNode,
  document: ProjectDocument
): boolean {
  const data = feature.data;
  return (
    independentLineageOutput(feature, document) ||
    (data.featureKind === 'sketch' &&
      findSketch(document, data.sketchId)?.planeRef.type === 'canonical') ||
    data.featureKind === 'boolean' ||
    (data.featureKind === 'transform' && !data.axisRotation)
  );
}

function cloneLineage(lineage: RemusLineageState): RemusLineageState {
  return {
    faceReferences: new Map(lineage.faceReferences),
    edgeReferences: new Map(lineage.edgeReferences),
    diagnostics: [...lineage.diagnostics]
  };
}

/** Preserve equality aliases with the independently cloned ordinary snapshot. */
export function cloneIdleLineageView(
  view: IdleLineageView,
  original: ExactBuildResult,
  cloned: ExactBuildResult
): IdleLineageView {
  return {
    diverged: view.diverged,
    lineages: new Map(
      [...view.lineages].map(([id, lineage]) => [
        id,
        lineage === original.shapes.get(id)?.lineage
          ? cloned.shapes.get(id)?.lineage
          : lineage && cloneLineage(lineage)
      ])
    )
  };
}

export function currentIdleLineageView(
  result: ExactBuildResult
): IdleLineageView {
  return {
    diverged: false,
    lineages: new Map(
      [...result.shapes].map(([id, shape]) => [id, shape.lineage])
    )
  };
}

/** Account retained JS provenance separately from kernel topology estimates. */
export function idleLineageViewBytes(
  view: IdleLineageView,
  digests: readonly string[]
): number {
  return new TextEncoder().encode(
    JSON.stringify({
      digests,
      diverged: view.diverged,
      lineages: [...view.lineages].map(([id, lineage]) => [
        id,
        lineage && {
          faces: [...lineage.faceReferences],
          edges: [...lineage.edgeReferences],
          diagnostics: lineage.diagnostics
        }
      ])
    })
  ).byteLength;
}

/** Build-local owner; an unaudited path abandons the alternate view. */
export class IdleLineageViewBuilder {
  private view: IdleLineageView | undefined;
  private before = new Map<BodyId, ExactShape>();
  private handled = new Set<BodyId>();

  constructor(
    private readonly document: ProjectDocument,
    initial: ExactBuildResult,
    view?: IdleLineageView,
    knownIdle = false
  ) {
    this.view =
      view ?? (knownIdle ? currentIdleLineageView(initial) : undefined);
  }

  begin(result: ExactBuildResult): void {
    if (!this.view) return;
    this.before = new Map(result.shapes);
    this.handled.clear();
  }

  abandon(): void {
    this.view = undefined;
  }

  /** Preserve audited geometry reuse; decline only unavailable alternate metadata. */
  reused(
    feature: FeatureNode,
    result: ExactBuildResult,
    kernel: RemusKernel,
    demand?: ReadonlySet<BodyId>
  ): void {
    const view = this.view;
    if (!view || feature.data.featureKind === 'primitive') return;
    try {
      const data = feature.data;
      if (data.featureKind === 'transform') {
        const source = this.before.get(data.targetBodyId);
        const outputId = data.copy ? feature.bodyId : data.targetBodyId;
        if (
          !data.axisRotation &&
          source &&
          outputId &&
          view.lineages.get(data.targetBodyId) === source.lineage
        ) {
          view.lineages.set(outputId, result.shapes.get(outputId)?.lineage);
          this.handled.add(outputId);
          return;
        }
      } else if (
        data.featureKind === 'boolean' &&
        data.operation === 'intersect' &&
        feature.bodyId
      ) {
        const operands = data.targetBodyIds.map((id) => this.before.get(id));
        const output = result.shapes.get(feature.bodyId);
        if (
          operands.length === 2 &&
          operands.every((shape) => shape?.solids.length === 1) &&
          output?.solids.length === 1 &&
          output.lineage
        ) {
          const shapes = operands as ExactShape[];
          this.boolean({
            feature,
            operands: shapes,
            candidates: shapes.map((shape) => ({
              lineage: shape.lineage,
              candidates: topologyCandidatesForSolid(kernel, shape.solids[0]!)
            })),
            resultCandidates: topologyCandidatesForSolid(
              kernel,
              output.solids[0]!
            ),
            selected: output.lineage,
            probeSelected:
              demand === undefined ||
              booleanEvolutionProbeNeeded(this.document, feature, demand),
            probeAvailable: true,
            declined: ''
          });
          return;
        }
      }
    } catch {
      // An alternate-view miss must not turn a valid prepared result into a refusal.
    }
    this.abandon();
  }

  boolean(input: {
    feature: FeatureNode;
    operands: readonly ExactShape[];
    candidates: readonly RemusBooleanOperand[];
    resultCandidates: readonly RemusTopologyCandidate[];
    selected: RemusLineageState;
    probeSelected: boolean;
    probeAvailable: boolean;
    declined: string;
  }): void {
    const view = this.view;
    const { feature } = input;
    if (!view || feature.data.featureKind !== 'boolean' || !feature.bodyId)
      return;
    const ids = feature.data.targetBodyIds;
    if (ids.some((id) => !view.lineages.has(id))) return this.abandon();
    const changedOperands = ids.some(
      (id, i) => view.lineages.get(id) !== input.operands[i]?.lineage
    );
    const probe = booleanEvolutionProbeNeeded(this.document, feature, []);
    if (
      !changedOperands &&
      (!input.probeAvailable || probe === input.probeSelected)
    ) {
      view.lineages.set(feature.bodyId, input.selected);
    } else {
      // A required probe may depend on different upstream provenance. No
      // cached scratch evidence is retained to reconstruct that combination.
      if (
        probe ||
        input.operands.some(
          (operand, i) => operand !== this.before.get(ids[i]!)
        )
      )
        return this.abandon();
      const lineage = deriveBooleanLineage({
        evidence: declinedBooleanEvidence(
          input.probeAvailable
            ? BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE
            : input.declined
        ),
        producingFeatureId: feature.featureId,
        operands: input.candidates.map((operand, i) => ({
          ...operand,
          lineage: view.lineages.get(ids[i]!)
        })),
        resultCandidates: input.resultCandidates
      });
      view.lineages.set(feature.bodyId, lineage);
      view.diverged = true;
    }
    this.handled.add(feature.bodyId);
  }

  transform(
    kernel: RemusKernel,
    sourceId: BodyId,
    outputId: BodyId,
    transformed: ExactShape,
    matrix: Float64Array,
    allowUniformScale: boolean
  ): void {
    const view = this.view;
    const source = this.before.get(sourceId);
    if (!view || !source) return;
    if (!view.lineages.has(sourceId)) return this.abandon();
    const lineage = view.lineages.get(sourceId);
    if (lineage === source.lineage) {
      view.lineages.set(outputId, transformed.lineage);
    } else if (!lineage) {
      view.lineages.set(
        outputId,
        remusHashOnlyLineage(
          'rigid-transform',
          'The source body has no verified topology lineage.'
        )
      );
    } else {
      if (source.solids.length !== transformed.solids.length)
        return this.abandon();
      const lineages = source.solids.map((solid, index) => {
        const faces = new Set(kernel.getSolidFaces(solid));
        const edges = new Set(kernel.getSolidEdges(solid));
        return propagateRemusRigidTransformLineage(
          {
            faceReferences: new Map(
              [...lineage.faceReferences].filter(([id]) => faces.has(id))
            ),
            edgeReferences: new Map(
              [...lineage.edgeReferences].filter(([id]) => edges.has(id))
            ),
            diagnostics: index === 0 ? [...lineage.diagnostics] : []
          },
          topologyCandidatesForSolid(kernel, transformed.solids[index]!),
          Array.from(matrix),
          allowUniformScale
        );
      });
      view.lineages.set(outputId, mergeRemusLineageStates(lineages));
    }
    this.handled.add(outputId);
  }

  finish(
    feature: FeatureNode,
    result: ExactBuildResult
  ): IdleLineageView | undefined {
    const view = this.view;
    if (!view) return undefined;
    if (!view.diverged) {
      this.view = currentIdleLineageView(result);
      return this.view;
    }
    // Before the first differing boolean, all builders have the same inputs.
    // Afterwards only these metadata paths have been audited. Other feature
    // kinds can consume lineage, repairs or reference-bound frames.
    if (!supportsIdleLineageView(feature, this.document)) {
      this.abandon();
      return undefined;
    }
    for (const [id, shape] of result.shapes) {
      if (this.handled.has(id) || this.before.get(id) === shape) continue;
      if (
        id === feature.bodyId &&
        independentLineageOutput(feature, this.document)
      ) {
        view.lineages.set(id, shape.lineage);
        continue;
      }
      // Inactive booleans pass an existing operand through unchanged.
      const origin = [...this.before].find(([, source]) => source === shape);
      if (
        feature.data.featureKind === 'boolean' &&
        origin &&
        view.lineages.has(origin[0])
      )
        view.lineages.set(id, view.lineages.get(origin[0]));
      else {
        this.abandon();
        return undefined;
      }
    }
    for (const id of view.lineages.keys())
      if (!result.shapes.has(id)) view.lineages.delete(id);
    if (view.lineages.size !== result.shapes.size) {
      this.abandon();
      return undefined;
    }
    return view;
  }
}
