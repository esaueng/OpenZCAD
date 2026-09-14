import type { FeatureId } from '@openzcad/shared';
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
import { unifyUnionFaces } from './exact-boolean-helpers';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';

/**
 * A boolean run through the kernel's entity-evolution entry point.
 *
 * `solid` is the production body after the caller's own unification step, and
 * is what the feature ships. `evolution` is present only when the payload
 * decoded and the raw pre-unification domain is still addressable; `declined`
 * says why when it is not, so the caller falls back to the analytic-carrier
 * derivation deliberately rather than inheriting a silent blank.
 */
export interface BooleanEvolutionRun {
  readonly solid: number;
  /**
   * Measured candidates for the RAW result, before unification. Lineage is
   * derived against these because the evolution payload addresses them.
   */
  readonly rawCandidates: readonly RemusTopologyCandidate[];
  readonly rawSolid: number;
  readonly evolution: RemusBooleanEntityEvolution | null;
  /**
   * True when unification left every face and edge handle in place, so the
   * raw candidates are also the production result's candidates and no second
   * measurement is needed.
   */
  readonly handlesStable: boolean;
  readonly declined: string | null;
}

type EvolutionOperation = 'cut' | 'fuse' | 'intersect';

function callEntityEvolution(
  kernel: RemusKernel,
  operation: EvolutionOperation,
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
 * The result handle alone, for the case where the evolution record is
 * unusable but the geometry is not. A payload that does not even name a solid
 * is a hard failure: there is no body to ship.
 */
function decodeResultSolid(payload: string): number {
  const decoded: unknown = JSON.parse(payload);
  const solid =
    decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>).solid
      : undefined;
  if (!Number.isSafeInteger(solid) || (solid as number) < 0) {
    throw new Error(
      'The exact kernel returned a boolean evolution payload with no result solid.'
    );
  }
  return solid as number;
}

function handleSetsMatch(
  before: readonly RemusTopologyCandidate[],
  faces: Uint32Array,
  edges: Uint32Array
): boolean {
  const measured = new Set(
    before.map((candidate) => `${candidate.kind}:${candidate.handle}`)
  );
  const after = [
    ...Array.from(faces, (handle) => `face:${handle}`),
    ...Array.from(edges, (handle) => `edge:${handle}`)
  ];
  return (
    after.length === measured.size && after.every((key) => measured.has(key))
  );
}

/**
 * Run a two-operand boolean through the entity-evolution entry point.
 *
 * The call is the production call, not a second one taken for evidence: a
 * boolean is the expensive operation in a rebuild and running it twice to
 * learn where its faces came from would be paid on every feature. Measured on
 * the pin, `cutWithEntityEvolution` and `intersectWithEntityEvolution` return
 * the same raw body as `cut` and `intersect` on every fixture tried (through
 * hole, blind pocket, slot across, flush half, stepped notch, coincident
 * boxes, cylinder through a plate), so routing them changes provenance and
 * nothing else.
 *
 * `unify` is the caller's own post-processing step, applied here so the raw
 * result can be measured first — unification renames handles wherever it
 * merges, and the evolution payload addresses the raw ones.
 */
export function runBooleanWithEntityEvolution(
  kernel: RemusKernel,
  operation: EvolutionOperation,
  a: number,
  b: number,
  unify: (solid: number) => number
): BooleanEvolutionRun {
  const payload = callEntityEvolution(kernel, operation, a, b);
  const rawSolid = decodeResultSolid(payload);
  let evolution: RemusBooleanEntityEvolution | null = null;
  let declined: string | null = null;
  try {
    evolution = decodeRemusBooleanEntityEvolution(payload);
  } catch (error) {
    declined = error instanceof Error ? error.message : 'invalid payload';
  }
  const rawCandidates = evolution
    ? topologyCandidatesForSolid(kernel, rawSolid)
    : [];
  const solid = unify(rawSolid);
  const handlesStable =
    evolution !== null &&
    solid === rawSolid &&
    handleSetsMatch(
      rawCandidates,
      kernel.getSolidFaces(solid),
      kernel.getSolidEdges(solid)
    );
  return { solid, rawSolid, rawCandidates, evolution, handlesStable, declined };
}

/** Face types, edge count and volume — enough to tell two bodies apart. */
function solidCensus(kernel: RemusKernel, solid: number): string {
  const types = Array.from(kernel.getSolidFaces(solid), (face) =>
    kernel.getSurfaceType(face)
  ).sort();
  return [
    types.join(','),
    kernel.getSolidEdges(solid).length,
    kernel.volume(solid, MEASUREMENT_DEFLECTION).toFixed(9)
  ].join('|');
}

/**
 * The union arm, with the geometry guard the measured kernel behaviour needs.
 *
 * `fuseWithEntityEvolution` publishes the RAW fragment layout, because that is
 * what its evolution map addresses; plain `fuse` post-processes its result.
 * Measured on the pin, two stacked 20x20x10 boxes come back from `fuse` as 6
 * faces / 12 edges and from `fuseWithEntityEvolution` as 10 / 20, which
 * `unifyFaces` only brings to 6 / 16 — four redundant seams the plain path
 * never had, and four false edges in the viewport. So where unification had to
 * merge anything, the plain fuse is run on the operands (which survive the
 * first call) and the two results are compared; the evolution body ships only
 * when it is the same body, and the plain body ships otherwise with the
 * boolean falling back to carrier lineage.
 *
 * Where unification merged nothing — a boss grown onto a plate, the case this
 * whole row exists for — no second fuse is run at all.
 */
export function runFuseWithEntityEvolution(
  kernel: RemusKernel,
  a: number,
  b: number,
  onAccepted?: (solid: number) => void
): BooleanEvolutionRun {
  // Whichever body ships is the one whose unification acceptance the caller
  // hears about: reporting the discarded attempt's would leave a handle that
  // names no shipped body behind in the union's own validation.
  let evolutionAccepted: number | undefined;
  const run = runBooleanWithEntityEvolution(kernel, 'fuse', a, b, (solid) =>
    unifyUnionFaces(kernel, solid, (accepted) => {
      evolutionAccepted = accepted;
    })
  );
  const merged =
    run.evolution === null ||
    kernel.getSolidFaces(run.solid).length !==
      run.rawCandidates.filter((candidate) => candidate.kind === 'face').length;
  const accept = (solid: number | undefined) => {
    if (solid !== undefined) {
      onAccepted?.(solid);
    }
  };
  if (!merged) {
    accept(evolutionAccepted);
    return run;
  }
  let plainAccepted: number | undefined;
  const plain = unifyUnionFaces(
    kernel,
    kernel.fuseAll(Uint32Array.from([a, b])),
    (accepted) => {
      plainAccepted = accepted;
    }
  );
  if (solidCensus(kernel, plain) === solidCensus(kernel, run.solid)) {
    accept(evolutionAccepted);
    return run;
  }
  accept(plainAccepted);
  return {
    solid: plain,
    rawSolid: plain,
    rawCandidates: [],
    evolution: null,
    handlesStable: false,
    declined:
      'The entity-evolution fuse needed face unification and did not land on the same body as the plain fuse; the plain result shipped.'
  };
}

/**
 * The same shape for a boolean that never reached the evolution entry point —
 * a coaxial cylinder cut taken by the exact analytic path, an operand set the
 * pairwise entry points do not cover. The reason travels with it so the
 * fallback to carrier lineage is recorded rather than assumed.
 */
export function plainBooleanRun(
  solid: number,
  declined: string
): BooleanEvolutionRun {
  return {
    solid,
    rawSolid: solid,
    rawCandidates: [],
    evolution: null,
    handlesStable: false,
    declined
  };
}

/**
 * Both boolean derivations, reconciled.
 *
 * The analytic-carrier rule runs on every boolean exactly as it did before
 * this row, against the production result. Where the kernel also handed back
 * an entity-evolution record, that record is derived against the RAW result it
 * addresses, carried across unification by exact witness, and reconciled with
 * the carrier rule — which keeps the carrier rule as the independent witness
 * rather than retiring it.
 */
export function deriveBooleanLineageForRun(
  kernel: RemusKernel,
  run: BooleanEvolutionRun,
  producingFeatureId: FeatureId,
  operands: readonly RemusBooleanOperand[]
): RemusLineageState {
  const resultCandidates = run.handlesStable
    ? run.rawCandidates
    : topologyCandidatesForSolid(kernel, run.solid);
  const carrier = deriveRemusBooleanCarrierLineage({
    producingFeatureId,
    operands,
    resultCandidates
  });
  if (!run.evolution) {
    if (run.declined) {
      carrier.diagnostics.push({
        code: 'hash-only',
        operation: 'boolean',
        message: `Boolean kernel evolution was not consumed: ${run.declined}`
      });
    }
    return carrier;
  }
  const raw = deriveRemusBooleanEvolutionLineage({
    producingFeatureId,
    evolution: run.evolution,
    resultSolid: run.rawSolid,
    operands,
    resultCandidates: run.rawCandidates
  });
  const evolution = run.handlesStable
    ? raw
    : (carryRemusUnchangedLineage(
        raw,
        resultCandidates,
        'boolean',
        // Not a blanket `hash-only`: the boolean itself did publish lineage,
        // and unification then merged or renamed part of it. Saying
        // "hash-only" at body level would read as the whole feature
        // declining, which is a different and much worse condition.
        'boolean-unification-merge'
      ) ?? raw);
  return reconcileRemusBooleanLineage(carrier, evolution);
}
