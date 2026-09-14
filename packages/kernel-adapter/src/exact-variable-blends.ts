/**
 * The two blends Remus ships behind its experimental blend surface: the
 * variable-radius fillet (`filletVariable`) and the asymmetric chamfer
 * (`chamferV2`).
 *
 * This module is the maturity gate. Remus qualifies variable-radius blending
 * only for standard radius laws whose extrema over the whole edge are the two
 * endpoints the user typed, and it does not qualify N-way vertex blends at
 * all. The kernel does not enforce the first of those at its own boundary —
 * see {@link assertQualifiedVariableFillet} — so the check lives here, on the
 * ZCAD side of the call, and fails closed.
 *
 * Kernel-mutating but stateless, like `exact-edge-modifiers`, whose acceptance
 * rules still decide whether a result produced here is shipped.
 */
import {
  VARIABLE_FILLET_LAWS,
  isVariableFilletLaw,
  type VariableFilletLaw
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { GEOMETRY_EPSILON } from './exact-math';

/**
 * The radius laws this adapter will send to `filletVariable` — the document's
 * own closed set, which exists for exactly this reason.
 *
 * Both are monotone from the start radius to the end radius, so the whole
 * blend is bounded by the two radii the form collected. A law with an
 * interior extremum, a per-position sampled law, or a setback corner is
 * outside the kernel's qualified domain and is never constructed here.
 */
export const QUALIFIED_VARIABLE_FILLET_LAWS = VARIABLE_FILLET_LAWS;

/** A qualified variable-radius request for one selection of edges. */
export interface VariableFilletSpec {
  /** Radius at the start of each selected edge, in the edge's own direction. */
  readonly startRadius: number;
  /** Radius at the far end of the same edge. */
  readonly endRadius: number;
  readonly law: VariableFilletLaw;
}

export function isQualifiedVariableFilletLaw(
  law: unknown
): law is VariableFilletLaw {
  return isVariableFilletLaw(law);
}

/**
 * Refuse a variable-radius request the kernel does not qualify, BEFORE it
 * reaches the kernel.
 *
 * This order is not defensive tidiness. Measured against the pinned kernel on
 * a 20×20×10 box, `filletVariable` given `{"law":"cubic","start":1,"end":3}`
 * returns a valid solid — the constant r=1 blend, silently, with no refusal
 * and nothing in the result that says the law was dropped. A law this adapter
 * has not qualified therefore cannot be sent and checked afterwards: it would
 * come back looking like a success and store geometry nobody asked for. The
 * only sound place to say no is here.
 *
 * The message names the laws that do work, because "unsupported" without the
 * supported set is a dead end for whoever hand-wrote or generated the
 * document that carried the unqualified law here.
 */
export function assertQualifiedVariableFillet(
  law: string,
  startRadius: number,
  endRadius: number
): asserts law is VariableFilletLaw {
  if (!isQualifiedVariableFilletLaw(law)) {
    throw new Error(
      `Variable-radius fillet law "${law}" is not one of the radius laws this kernel qualifies ` +
        `(${QUALIFIED_VARIABLE_FILLET_LAWS.join(', ')}). ` +
        'An unqualified law is refused rather than approximated: the kernel would quietly ' +
        'round the edge at the start radius instead.'
    );
  }
  for (const [label, radius] of [
    ['start', startRadius],
    ['end', endRadius]
  ] as const) {
    if (!Number.isFinite(radius) || radius <= GEOMETRY_EPSILON) {
      throw new Error(
        `Variable-radius fillet ${label} radius must be a finite value greater than zero.`
      );
    }
  }
}

/**
 * The `filletVariable` request for one selection.
 *
 * Every selected edge carries the same law and the same two radii. Per-edge
 * radii are expressible in the kernel's JSON and deliberately not offered:
 * the feature stores one law for the selection, so a per-edge payload here
 * would be a shape the document cannot round-trip.
 *
 * `startSetback`/`endSetback` are never written. They are the N-way vertex
 * blend, which the kernel refuses unless EVERY stripe meeting at a 3-or-more
 * way corner declares a positive setback — and which its own documentation
 * places outside the qualified set even then.
 */
export function variableFilletRequest(
  edges: readonly number[],
  spec: VariableFilletSpec
): string {
  return JSON.stringify(
    edges.map((edge) => ({
      edge,
      law: spec.law,
      start: spec.startRadius,
      end: spec.endRadius
    }))
  );
}

/**
 * Run a qualified variable-radius fillet. Throws the kernel's own refusal
 * when the blend fails; the caller applies the adapter's acceptance rules to
 * a result that comes back.
 */
export function applyVariableRadiusFillet(
  kernel: RemusKernel,
  solid: number,
  edges: readonly number[],
  spec: VariableFilletSpec
): number {
  assertQualifiedVariableFillet(spec.law, spec.startRadius, spec.endRadius);
  return kernel.filletVariable(solid, variableFilletRequest(edges, spec));
}

/**
 * Remus's stable machine-readable refusal prefixes, from `blend_failure_code`.
 *
 * The variable and v2 blend entry points are transactional: they leave the
 * topology untouched and put the reason in the message behind one of these.
 * The reasons are specific to a configuration the user chose — a corner where
 * the stripes cannot meet, a radius the wire cannot carry — and nothing that
 * inspects the inputs afterwards recovers them, so they are relayed rather
 * than re-derived.
 */
const BLEND_FAILURE_CODES: readonly string[] = [
  'blend-failed',
  'edges-not-blended',
  'fillet-failed',
  'invalid-input',
  'partial-result',
  'radius-too-large',
  'resize-blend-failed',
  'setback-mismatch',
  'unsupported-face-face-blend',
  'unsupported-setback-corner',
  'unsupported-support-pair',
  'unsupported-surface',
  'unsupported-vertex-blend'
];

/**
 * The kernel's own sentence for a refused variable or asymmetric blend, or
 * `null` when it did not report one this adapter recognizes.
 *
 * Deliberately not reworded. The constant-blend path answers "could a smaller
 * size work?" by probing a ladder, because the kernel cannot answer it; these
 * refusals are the opposite case — the kernel already named the configuration
 * it will not build, and a friendlier paraphrase would drop the part the user
 * needs.
 */
export function variableBlendRefusalMessage(
  reported: string | null
): string | null {
  if (!reported) {
    return null;
  }
  const trimmed = reported.trim();
  return BLEND_FAILURE_CODES.some((code) => trimmed.startsWith(`${code}:`))
    ? trimmed
    : null;
}

/**
 * Failure message for a variable-radius fillet or asymmetric chamfer.
 *
 * Deliberately NOT the constant blend's cause-aware message. That one answers
 * "would a smaller size work?" by re-running the same selection down a ladder
 * of smaller sizes — a sound question there, and the wrong one here: the
 * ladder runs the constant engine, so on a variable request it would report
 * that a blend the user did not ask for succeeds. Rather than teach the
 * ladder a second engine, this path relays the kernel's own named reason and,
 * when there is none, says plainly which surface refused.
 */
export function variableBlendFailureMessage(
  featureKind: 'fillet' | 'chamfer',
  edgeCount: number,
  reported: string | null
): string {
  const label =
    featureKind === 'fillet'
      ? 'Variable-radius fillet'
      : 'Asymmetric chamfer';
  const prefix = `${label} could not be created on ${edgeCount} selected edge${edgeCount === 1 ? '' : 's'}.`;
  const kernelReason = variableBlendRefusalMessage(reported);
  if (kernelReason) {
    return `${prefix} ${kernelReason}`;
  }
  const remedy =
    featureKind === 'fillet'
      ? 'Try radii closer together, or a constant radius — the constant blend covers topology the variable one does not yet.'
      : 'Try setbacks closer together, or a symmetric chamfer — the symmetric blend covers topology the asymmetric one does not yet.';
  return `${prefix} ${remedy}`;
}
