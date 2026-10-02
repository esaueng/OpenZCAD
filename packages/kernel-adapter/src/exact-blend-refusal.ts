/**
 * The constant-blend contract: fillet, chamfer and distance-angle chamfer as
 * typed data.
 *
 * Remus's plain `fillet` / `chamfer` / `chamferDistanceAngle` throw a bare
 * `Error` carrying kernel prose, so every caller that wanted to tell "the
 * engine will not do this" from "the input was malformed" had to match that
 * English. The typed twins answer the same question as DATA —
 * `filletDetailed`, `chamferDetailed` and `chamferDistanceAngleDetailed`
 * return a status, a stable code from the kernel's `blend_failure_code` set
 * and a category from the shared taxonomy. Every constant blend in the
 * adapter goes through this module so that downstream code branches on
 * {@link BlendRefusal.code} and {@link BlendRefusal.category}, never on the
 * English text of a message.
 *
 * `exact_only` is deliberately left unset. The adapter enforces exactness
 * itself through the acceptance rules in `exact-edge-modifiers` (bounds,
 * volume envelope, blend-band guard); passing `exactOnly: true` would newly
 * refuse disclosed-approximate results the adapter currently accepts, which
 * is a product change, not a seam retirement.
 */
import type {
  RemusKernel,
  SolidOperationDetailedResult
} from './remus-runtime';
import {
  KernelRefusal,
  kernelDetailString,
  kernelRefusalIn,
  type KernelRefusalCategory
} from './kernel-refusal';

/** The constant blends with a typed twin in the pinned kernel. */
export type BlendOperation = 'fillet' | 'chamfer' | 'chamferDistanceAngle';

/**
 * The kernel's own refusal taxonomy, kept in step with the pin.
 *
 * An alias of the shared {@link KernelRefusalCategory} rather than a second
 * extraction: the kernel classifies a refused blend out of the same set it
 * uses for every other family, and the seam has exactly one copy of it.
 */
export type BlendRefusalCategory = KernelRefusalCategory;

/**
 * The stable machine-readable code for the shared-corner case, from the
 * kernel's `blend_failure_code` set.
 *
 * This is DATA, not English: the typed twins carry it in `code`, and the
 * legacy throws carry it as the message prefix. It is matched as a
 * `code:`-prefixed unit (see {@link blendReportIsVertexBlend}), never as a
 * substring of a sentence.
 */
export const VERTEX_BLEND_CODE = 'unsupported-vertex-blend';

export interface BlendRefusalInit {
  operation: BlendOperation;
  category: BlendRefusalCategory;
  kernelCode: string;
  kernelMessage: string;
  cause?: unknown;
}

/**
 * A blend the kernel refused, as a typed error.
 *
 * `message` relays the kernel's own detail sentence verbatim — it is what a
 * caller that still reads a report string sees, and it is never branched
 * on. `category` and `kernelCode` are the branchable fields.
 */
export class BlendRefusal extends KernelRefusal {
  readonly operation: BlendOperation;

  constructor(init: BlendRefusalInit) {
    super({
      family: 'blend',
      category: init.category,
      kernelCode: init.kernelCode,
      kernelMessage: init.kernelMessage,
      reason: init.kernelMessage,
      message: init.kernelMessage,
      ...(init.cause === undefined ? {} : { cause: init.cause })
    });
    this.name = 'BlendRefusal';
    this.operation = init.operation;
  }
}

/**
 * The refusal behind an error, however deeply a caller wrapped it.
 */
export function blendRefusalOf(error: unknown): BlendRefusal | null {
  return kernelRefusalIn(
    error,
    (refusal): refusal is BlendRefusal => refusal instanceof BlendRefusal
  );
}

export type BlendOutcome =
  | { status: 'ok'; solid: number }
  | { status: 'refused'; refusal: BlendRefusal };

function detailedResult(
  kernel: RemusKernel,
  operation: BlendOperation,
  solid: number,
  edges: Uint32Array,
  size: number,
  angleRadians: number | undefined
): SolidOperationDetailedResult {
  switch (operation) {
    case 'fillet':
      return kernel.filletDetailed(solid, edges, size);
    case 'chamfer':
      return kernel.chamferDetailed(solid, edges, size);
    case 'chamferDistanceAngle':
      if (angleRadians === undefined) {
        throw new Error(
          'A distance-angle chamfer needs its bevel angle in radians.'
        );
      }
      return kernel.chamferDistanceAngleDetailed(
        solid,
        edges,
        size,
        angleRadians
      );
  }
}

/**
 * Run one constant blend and return the kernel's verdict as data.
 *
 * A refusal is an answer rather than an exception, and the probe ladder in
 * `exact-edge-modifiers` reads this directly. Note that the typed twins
 * report an invalid handle the same way, so a programming error surfaces as
 * `invalid_input` instead of a throw.
 */
export function blendOutcome(
  kernel: RemusKernel,
  operation: BlendOperation,
  solid: number,
  edges: Uint32Array,
  size: number,
  angleRadians?: number
): BlendOutcome {
  const detailed = detailedResult(
    kernel,
    operation,
    solid,
    edges,
    size,
    angleRadians
  );
  if (detailed.status === 'ok') {
    return { status: 'ok', solid: detailed.value };
  }
  const details = detailed.details ?? {};
  return {
    status: 'refused',
    refusal: new BlendRefusal({
      operation,
      category: detailed.category,
      kernelCode: kernelDetailString(details, 'kernelCode') ?? detailed.code,
      kernelMessage:
        kernelDetailString(details, 'message') ??
        'the exact modeling engine gave no further detail'
    })
  };
}

/**
 * The report string a refused blend travels on inside the adapter.
 *
 * Byte-identical by construction to what the legacy bare calls threw:
 * `` `${code}: ${message}` ``. The matchers the allowance list still
 * records (the refused-edge counts, the `available radius` ceiling) read
 * counts the kernel measured only in that prose, so they keep reading this
 * string until their own typed fields exist — and this shim is what lets
 * them do it without touching an untyped kernel call. What is NOT read out
 * of it is the failure KIND: that comes from {@link BlendRefusal.code}
 * (see {@link blendReportIsVertexBlend}).
 */
export function reportBlendRefusal(refusal: BlendRefusal): string {
  return `${refusal.kernelCode}: ${refusal.kernelMessage}`;
}

/**
 * Whether a blend refusal report names the shared-corner case.
 *
 * Reads the stable `blend_failure_code` prefix this module placed on the
 * report from the typed `code` field — the same prefix-code discipline the
 * variable-blend path already uses. It is deliberately a whole-prefix
 * `startsWith`, not a substring of a sentence: `unsupported-vertex-blend:`
 * carries no English to reword.
 */
export function blendReportIsVertexBlend(reported: string | null): boolean {
  return reported?.startsWith(`${VERTEX_BLEND_CODE}:`) ?? false;
}
