import type {
  BodyId,
  FeatureId,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { RemusKernel } from './remus-runtime';
import {
  carryRemusUnchangedLineage,
  decodeRemusBooleanEntityEvolution,
  deriveRemusBooleanCarrierLineage,
  deriveRemusBooleanEvolutionLineage,
  reconcileRemusBooleanLineage,
  type RemusBooleanEntityEvolution,
  type RemusBooleanOperand,
  type RemusLineageState,
  type RemusTopologyCandidate
} from './remus-lineage';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

/**
 * Provenance evidence for a boolean, read WITHOUT sourcing the geometry from
 * it.
 *
 * The kernel's `cutWithEntityEvolution` / `fuseWithEntityEvolution` /
 * `intersectWithEntityEvolution` entry points are a DIFFERENT boolean
 * implementation from the plain ones on this pin, not the same boolean with a
 * provenance payload attached. Measured on `4bbcd5c7`:
 *
 * | case | plain entry point | entity-evolution entry point |
 * | --- | --- | --- |
 * | cylinder r10 h20 minus sphere r8 at z=10 | 5 faces, 4137.839039 mm^3 | throws `assembly failed: closed hole shell is not contained by any growth region` |
 * | sphere r10 intersect 10mm box at z=5 | 4 faces, 163.596637 mm^3 | throws `assembly failed: no outer shell found` |
 * | two offset unit spheres, fuse | throws the exact-only refusal | returns a 4-face body of 5.726777 mm^3 |
 * | cylinder r10 h20 union sphere r8 at z=20 | throws the exact-only refusal | returns the sphere alone, 4188.790205 mm^3 |
 * | box 20mm minus sphere r8 at (10,10,20) | throws the exact-only refusal | throws `copied face Id(49) does not contain exactly one reverse use of edge Id(276)` |
 * | cylinder r20 h5 union cylinder r5 h20 at z=5 | 6 faces | 5 faces |
 * | sphere r10 intersect 10mm box at the origin | 523.545492 mm^3 | 523.528813 mm^3 |
 *
 * So the shipped solid is never taken from these entry points. Geometry keeps
 * coming from the typed detailed calls behind `exactCut` / `exactFuse` /
 * `exactIntersect`, which carry the kernel's exact-only policy (Remus B21)
 * and turn its refusals into named product outcomes. The evolution call runs separately, on
 * COPIES of the same operands, purely to read the payload — and its own result
 * is checked against the shipped body before a single name is believed.
 */
export interface BooleanEvolutionEvidence {
  /** The decoded payload, or null when there is nothing trustworthy to use. */
  readonly evolution: RemusBooleanEntityEvolution | null;
  /**
   * The operands as the evolution call saw them: the copies' own measured
   * candidates, carrying the originals' references across by exact witness.
   * The payload's source handles address these, not the originals'.
   */
  readonly operands: readonly RemusBooleanOperand[];
  /** Measured candidates of the evolution call's own result. */
  readonly candidates: readonly RemusTopologyCandidate[];
  /** Why no payload is being used. Null when one is. */
  readonly declined: string | null;
}

export type BooleanEvolutionOperation = 'cut' | 'fuse' | 'intersect';

function callEntityEvolution(
  kernel: RemusKernel,
  operation: BooleanEvolutionOperation,
  a: number,
  b: number
): string {
  switch (operation) {
    case 'cut':
      return kernel.cutWithEntityEvolution(a, b);
    case 'fuse':
      return kernel.fuseWithEntityEvolution(a, b);
    case 'intersect':
      return kernel.intersectWithEntityEvolution(a, b);
  }
}

/**
 * No payload, and the reason why. Every boolean that does not reach a probe —
 * a multi-operand reduction, the exact coaxial cylinder path, an operand the
 * pairwise entry points do not cover — says so rather than inheriting a
 * silent blank.
 */
export function declinedBooleanEvidence(
  declined: string
): BooleanEvolutionEvidence {
  return { evolution: null, operands: [], candidates: [], declined };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Face types and edge count — the cheap half of the same-body question. */
function solidShape(kernel: RemusKernel, solid: number): string {
  const types = Array.from(kernel.getSolidFaces(solid), (face) =>
    kernel.getSurfaceType(face)
  ).sort();
  return `${types.join(',')}|${kernel.getSolidEdges(solid).length}`;
}

/**
 * Whether two solids are the same body.
 *
 * Face count, face types, edge count and volume. The volume comparison is
 * relative rather than exact: two bodies built by two code paths can differ in
 * the last bits of a measured volume without being different bodies, while
 * every divergence measured on this pin is orders of magnitude larger than
 * that — the closest is the intersect that moved 523.545492 to 523.528813,
 * which is 3e-5 relative, and the rest differ in face or edge count as well.
 */
function solidsAreTheSameBody(
  kernel: RemusKernel,
  left: number,
  right: number
): boolean {
  if (solidShape(kernel, left) !== solidShape(kernel, right)) {
    return false;
  }
  const leftVolume = kernel.volume(left, MEASUREMENT_DEFLECTION);
  const rightVolume = kernel.volume(right, MEASUREMENT_DEFLECTION);
  if (!Number.isFinite(leftVolume) || !Number.isFinite(rightVolume)) {
    return false;
  }
  const scale = Math.max(1, Math.abs(leftVolume), Math.abs(rightVolume));
  return Math.abs(leftVolume - rightVolume) <= scale * 1e-9;
}

/**
 * The operand as the evolution call saw it.
 *
 * The call runs on a copy, so the payload's source handles are the copy's. The
 * original's references are carried onto the copy's handles by exact witness —
 * the same one-to-one, uniqueness-checked carry a direct edit uses — so a face
 * whose witness is ambiguous on its own body carries nothing rather than being
 * matched by handle order or by position in the list.
 */
function operandAsCopied(
  kernel: RemusKernel,
  operand: RemusBooleanOperand,
  copy: number
): RemusBooleanOperand {
  const candidates = topologyCandidatesForSolid(kernel, copy);
  return {
    ...(operand.role ? { role: operand.role } : {}),
    candidates,
    lineage: carryRemusUnchangedLineage(operand.lineage, candidates, 'boolean')
  };
}

/**
 * Read the kernel's entity-evolution payload for a boolean that has ALREADY
 * been performed and shipped by the typed detailed entry points.
 *
 * `shipped` is the body the feature publishes; nothing here may replace it.
 * The probe repeats the boolean on copies of the same operands, applies the
 * caller's own post-processing to its own result, and compares that against
 * `shipped`. A probe that throws, that decodes badly, or that lands on a
 * different body hands back `declined`, and the caller keeps the
 * analytic-carrier lineage it had before this row.
 *
 * COST: this performs the boolean a SECOND time, on every two-operand boolean
 * feature. That is deliberate and it is the price of the guarantee — the
 * geometry the user gets is the exact pipeline's, and the provenance is
 * believed only where a second, independent body says the payload describes
 * the same operation. It is not skipped silently anywhere: a boolean that does
 * not probe records why.
 */
export function probeBooleanEntityEvolution(input: {
  readonly kernel: RemusKernel;
  readonly operation: BooleanEvolutionOperation;
  /** The operand solids the shipped boolean was given, in the same order. */
  readonly a: number;
  readonly b: number;
  /** The body the feature ships. Read only. */
  readonly shipped: number;
  /** The caller's own post-processing, applied to the probe's own result. */
  readonly unify: (solid: number) => number;
  /** Operand lineage, one entry per operand solid, in the same order. */
  readonly operands: readonly RemusBooleanOperand[];
}): BooleanEvolutionEvidence {
  const { kernel, operation, operands } = input;
  if (operands.length !== 2) {
    return declinedBooleanEvidence(
      'The boolean evolution probe needs one lineage operand per solid.'
    );
  }
  let copies: readonly [number, number];
  try {
    copies = [kernel.copySolid(input.a), kernel.copySolid(input.b)];
  } catch (error) {
    return declinedBooleanEvidence(
      `The operands could not be copied for the evolution probe: ${errorText(error)}`
    );
  }
  let evolution: RemusBooleanEntityEvolution;
  try {
    evolution = decodeRemusBooleanEntityEvolution(
      callEntityEvolution(kernel, operation, copies[0], copies[1])
    );
  } catch (error) {
    return declinedBooleanEvidence(
      `The kernel's entity-evolution ${operation} did not produce a usable payload: ${errorText(error)}`
    );
  }
  // Measured BEFORE the caller's post-processing, because the payload
  // addresses the raw result: unification renames handles wherever it merges.
  let candidates: readonly RemusTopologyCandidate[];
  let sameBody: boolean;
  try {
    candidates = topologyCandidatesForSolid(kernel, evolution.solid);
    sameBody = solidsAreTheSameBody(
      kernel,
      input.unify(evolution.solid),
      input.shipped
    );
  } catch (error) {
    return declinedBooleanEvidence(
      `The evolution probe's own result could not be compared with the shipped body: ${errorText(error)}`
    );
  }
  if (!sameBody) {
    return declinedBooleanEvidence(
      `The kernel's entity-evolution ${operation} did not reproduce the body the plain ${operation} shipped, so its provenance describes a different solid.`
    );
  }
  return {
    evolution,
    operands: [
      operandAsCopied(kernel, operands[0]!, copies[0]),
      operandAsCopied(kernel, operands[1]!, copies[1])
    ],
    candidates,
    declined: null
  };
}

/**
 * Both boolean derivations, reconciled onto the SHIPPED body.
 *
 * The analytic-carrier rule runs on every boolean exactly as it did before
 * this row, against the shipped result's own measured candidates. Where the
 * probe also handed back a verified payload, that payload is derived against
 * the probe's own body — the domain it addresses — and then carried onto the
 * shipped body by exact witness, so a name only ever lands on a shipped face
 * whose exact witness is identical to the probe face the name was proved on. A
 * handle the two derivations name differently publishes neither name.
 */
export function deriveBooleanLineage(input: {
  readonly evidence: BooleanEvolutionEvidence;
  readonly producingFeatureId: FeatureId;
  /** Operand lineage for the ORIGINAL operands, for the carrier rule. */
  readonly operands: readonly RemusBooleanOperand[];
  /** The shipped body's measured candidates. */
  readonly resultCandidates: readonly RemusTopologyCandidate[];
}): RemusLineageState {
  const { evidence, resultCandidates } = input;
  const carrier = deriveRemusBooleanCarrierLineage({
    producingFeatureId: input.producingFeatureId,
    operands: input.operands,
    resultCandidates
  });
  if (!evidence.evolution) {
    if (evidence.declined) {
      carrier.diagnostics.push({
        code: 'hash-only',
        operation: 'boolean',
        message: `Boolean kernel evolution was not consumed: ${evidence.declined}`
      });
    }
    return carrier;
  }
  const probed = deriveRemusBooleanEvolutionLineage({
    producingFeatureId: input.producingFeatureId,
    evolution: evidence.evolution,
    resultSolid: evidence.evolution.solid,
    operands: evidence.operands,
    resultCandidates: evidence.candidates
  });
  const carried =
    carryRemusUnchangedLineage(
      probed,
      resultCandidates,
      'boolean',
      // Not a blanket `hash-only`: the boolean itself did publish lineage, and
      // the shipped body's own unification then merged or renamed part of it.
      // Saying "hash-only" at body level would read as the whole feature
      // declining, which is a different and much worse condition.
      'boolean-evidence-carry'
    ) ?? probed;
  return reconcileRemusBooleanLineage(carrier, carried);
}

/**
 * Why a skipped probe was skipped, published through the usual
 * `Boolean kernel evolution was not consumed` diagnostic by
 * {@link deriveBooleanLineage}. A constant so the history-cache digest, the
 * builder and the tests all name the same outcome.
 */
export const BOOLEAN_EVOLUTION_SKIPPED_NO_REFERENCE =
  'The boolean evolution probe was skipped because no later feature references the result faces or edges.';

/** Whether this feature is a boolean whose lineage the probe could enrich. */
export function isBooleanEvolutionProbeEligible(
  feature: FeatureNode
): boolean {
  return feature.data.featureKind === 'boolean';
}

/**
 * Feature kinds whose selections resolve against the target body's lineage.
 * A later feature of one of these kinds, aimed at a body descended from the
 * boolean's result, may read a name the probe would have published — through
 * a v5 reference, through the legacy-hash repair that vouches for one, or
 * through the parameter-replay normalization that upgrades one — so the
 * probe runs. Legacy hash-only picks count: the repair path reads the same
 * lineage the probe enriches.
 */
const EXPLICIT_LINEAGE_CONSUMERS: ReadonlySet<string> = new Set([
  'hole',
  'shell',
  'draft',
  'thicken',
  'fillet',
  'chamfer',
  'direct-edit'
]);

const KNOWN_FEATURE_KINDS: ReadonlySet<string> = new Set([
  'primitive',
  'sketch',
  'extrude',
  'revolve',
  'loft',
  'sweep',
  'helical-sweep',
  'boolean',
  'transform',
  'mirror',
  'shell',
  'solid-offset',
  'draft',
  'thicken',
  'fillet',
  'chamfer',
  'pattern',
  'split',
  'hole',
  'direct-edit',
  'imported-step',
  'imported-mesh'
]);

const KNOWN_NODE_KINDS: ReadonlySet<string> = new Set([
  'project',
  'assembly',
  'part',
  'parameter',
  'sketch',
  'sketch-object',
  'feature',
  'body'
]);

/** Bodies this feature reads: the booleans it reduces and the body it edits. */
function consumedBodyIds(feature: FeatureNode): BodyId[] {
  const data = feature.data;
  if (data.featureKind === 'boolean') {
    return [...data.targetBodyIds];
  }
  if (
    data.featureKind === 'extrude' ||
    data.featureKind === 'hole' ||
    data.featureKind === 'split' ||
    data.featureKind === 'shell' ||
    data.featureKind === 'solid-offset' ||
    data.featureKind === 'draft' ||
    data.featureKind === 'thicken' ||
    data.featureKind === 'fillet' ||
    data.featureKind === 'chamfer' ||
    data.featureKind === 'pattern' ||
    data.featureKind === 'direct-edit' ||
    data.featureKind === 'transform' ||
    data.featureKind === 'mirror'
  ) {
    return data.targetBodyId !== undefined ? [data.targetBodyId] : [];
  }
  return [];
}

/** Bodies this feature (re)publishes under, for the descendant closure. */
function producedBodyIds(feature: FeatureNode): BodyId[] {
  const bodies: BodyId[] = [];
  if (feature.bodyId !== undefined) {
    bodies.push(feature.bodyId);
  }
  if (
    feature.data.featureKind === 'split' &&
    feature.data.secondBodyId !== undefined &&
    feature.data.secondBodyId !== feature.bodyId
  ) {
    bodies.push(feature.data.secondBodyId);
  }
  return bodies;
}

/**
 * Whether any persisted schema-v5 reference anywhere in the document names
 * this boolean as its producer — in a later feature's face/edge selection,
 * in a direct-edit operation, or in a sketch attachment. Such a reference
 * resolves against the lineage the probe enriches, wherever its holder sits,
 * so the probe runs regardless of body bookkeeping.
 */
function persistedReferenceNamesProducer(
  document: ProjectDocument,
  features: readonly FeatureNode[],
  producer: FeatureId
): boolean {
  for (const feature of features) {
    const data = feature.data;
    switch (data.featureKind) {
      case 'hole':
        if (data.faceReference?.producingFeatureId === producer) return true;
        break;
      case 'shell':
        if (
          data.openingFaceReferences?.some(
            (reference) => reference.producingFeatureId === producer
          )
        )
          return true;
        break;
      case 'draft':
        if (
          data.faceReferences?.some(
            (reference) => reference.producingFeatureId === producer
          )
        )
          return true;
        break;
      case 'thicken':
        if (data.faceReference?.producingFeatureId === producer) return true;
        break;
      case 'fillet':
      case 'chamfer':
        if (
          data.edgeReferences?.some(
            (reference) => reference.producingFeatureId === producer
          )
        )
          return true;
        break;
      case 'direct-edit': {
        const operation = data.operation;
        if (operation.faceReference?.producingFeatureId === producer)
          return true;
        if (
          operation.kind === 'set-face-distance' &&
          operation.oppositeFaceReference?.producingFeatureId === producer
        )
          return true;
        break;
      }
      default:
        break;
    }
  }
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'sketch' && node.planeRef.type === 'face') {
      if (node.planeRef.faceReference?.producingFeatureId === producer)
        return true;
    }
  }
  return false;
}

/**
 * Transient, non-persisted lineage demand: body ids whose producing booleans
 * must probe. UI state only — never stored on the document, never part of
 * the canonical content, never synced. Sticky per open document on the
 * caller side; this module only reads the set it is handed.
 */
export type BooleanLineageDemand =
  | ReadonlySet<BodyId>
  | readonly BodyId[]
  | null
  | undefined;

/** Sorted, deduplicated demand as a set; unhashable input yields empty. */
export function normalizeBooleanLineageDemand(
  demand: BooleanLineageDemand
): ReadonlySet<BodyId> {
  if (!demand) {
    return new Set();
  }
  const ids = Array.isArray(demand) ? demand : [...demand];
  const normalized = new Set<BodyId>();
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) {
      normalized.add(id as BodyId);
    }
  }
  return normalized;
}

/** Stable cache/digest key for a demand set: sorted JSON, `[]` when empty. */
export function booleanLineageDemandKey(demand: BooleanLineageDemand): string {
  const normalized = normalizeBooleanLineageDemand(demand);
  if (normalized.size === 0) {
    return '[]';
  }
  return JSON.stringify([...normalized].sort());
}

/**
 * Whether the entity-evolution probe for this boolean feature may be
 * skipped.
 *
 * Runs the probe unless it can PROVE nothing downstream consumes face/edge
 * identity from the boolean's result body: a later hole, shell, draft,
 * thicken, fillet, chamfer or direct edit aimed at the result or at any body
 * derived from it; a face-attached sketch on any of those bodies; or any
 * persisted v5 reference naming the boolean anywhere in the document.
 * Lineage propagation alone — a later boolean, extrude, transform, mirror,
 * pattern, split or solid offset that merely carries the names forward —
 * extends the descendant closure without forcing the probe; the probe runs
 * only where the chain ends in an explicit consumer.
 *
 * A transient lineage demand forces the probe when the boolean's own result
 * body, or any body descended from it through the same descendant chain the
 * gate already tracks, is demanded. Idle rebuilds still skip; a demanded
 * rebuild probes only that boolean and what follows it (via the digest).
 *
 * Fail-closed: an unlisted feature or node kind, a missing body, a feature
 * absent from the order, or a suppressed downstream selection all run the
 * probe. Suppressed features are treated as live because unsuppressing one
 * must not serve a cached carrier-only result to a referencing feature.
 * Extrude add/cut booleans are out of scope — they always probe, which is
 * what the existing evolution lineage tests pin.
 */
export function booleanEvolutionProbeNeeded(
  document: ProjectDocument,
  feature: FeatureNode,
  demand?: BooleanLineageDemand
): boolean {
  if (!isBooleanEvolutionProbeEligible(feature)) {
    return false;
  }
  const resultBodyId = feature.bodyId;
  if (resultBodyId === undefined) {
    return true;
  }
  const features = listFeaturesInOrder(document);
  const index = features.findIndex(
    (candidate) => candidate.featureId === feature.featureId
  );
  if (index < 0) {
    return true;
  }
  if (persistedReferenceNamesProducer(document, features, feature.featureId)) {
    return true;
  }
  const descendants = new Set<BodyId>([resultBodyId]);
  for (let later = index + 1; later < features.length; later += 1) {
    const downstream = features[later]!;
    if (!KNOWN_FEATURE_KINDS.has(downstream.data.featureKind)) {
      return true;
    }
    if (downstream.data.featureKind === 'sketch') {
      continue;
    }
    const touches = consumedBodyIds(downstream).some((bodyId) =>
      descendants.has(bodyId)
    );
    if (!touches) {
      continue;
    }
    for (const bodyId of producedBodyIds(downstream)) {
      descendants.add(bodyId);
    }
    if (EXPLICIT_LINEAGE_CONSUMERS.has(downstream.data.featureKind)) {
      return true;
    }
  }
  for (const node of Object.values(document.nodes)) {
    if (!KNOWN_NODE_KINDS.has(node.kind)) {
      return true;
    }
    if (
      node.kind === 'sketch' &&
      node.planeRef.type === 'face' &&
      descendants.has(node.planeRef.bodyId)
    ) {
      return true;
    }
  }
  const demanded = normalizeBooleanLineageDemand(demand);
  if (demanded.size > 0) {
    for (const bodyId of demanded) {
      if (descendants.has(bodyId)) {
        return true;
      }
    }
  }
  return false;
}
