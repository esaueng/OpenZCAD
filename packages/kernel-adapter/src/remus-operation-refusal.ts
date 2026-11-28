/**
 * Typed refusals for modeling features whose kernel entry points throw prose.
 *
 * `draft`, `shell`, `split`, `thicken` and the other whole-body modeling calls
 * have no typed twin on the pin: they throw a bare `Error` whose message is
 * the Display text of Remus `OperationsError` (`invalid input: …`,
 * `draft: unsupported configuration: …`, `exact-only policy: …`, …). Before
 * this module those refusals reached the user, and the K10 combination
 * matrix, untyped. The category is read from those Display forms — the one
 * place this adapter reads kernel text for a category, because the kernel
 * gives it nowhere else — and anything unrecognised is `internal`, so the
 * refusal is always typed. The sentence is never changed.
 */
import {
  KernelRefusal,
  SEALED_CAVITY_REASON,
  type KernelRefusalCategory
} from './kernel-refusal';

/**
 * `OperationsError` Display forms and the category each projects to, most
 * specific first. Never `cancelled`: a real cancellation is already typed
 * (`exact-cancellation.ts`), and prose must not read as one.
 */
const OPERATION_ERROR_CATEGORIES: ReadonlyArray<
  readonly [RegExp, KernelRefusalCategory]
> = [
  [/\bexact-only policy\b/, 'quality_refused'],
  [/: unsupported configuration: |\bdoes not support\b/, 'unsupported'],
  [/\b(?:resource limit|budget|exhausted)\b/i, 'resource_limit'],
  [
    /\bnon-manifold result\b|\bempty result: |\bfailed validation\b/,
    'invalid_topology'
  ],
  [
    /\binvalid input: |\brequires a \w+ body\b|\binvalid solid handle\b/,
    'invalid_input'
  ]
];

/** The category an `OperationsError` message projects to. */
export function operationErrorCategory(message: string): KernelRefusalCategory {
  for (const [pattern, category] of OPERATION_ERROR_CATEGORIES) {
    if (pattern.test(message)) {
      return category;
    }
  }
  return 'internal';
}

/**
 * The kernel refusing a body for its cavity shells ({@link
 * SEALED_CAVITY_REASON}).
 *
 * On the pin, Split, Draft, Shell, fillet, chamfer and defeature rebuild
 * only a solid's outer shell, so each refuses every body that has an inner
 * one before it looks at anything else: the plane, the angle and the picked
 * faces play no part. Their Display forms (`split.rs`, `draft.rs`,
 * `defeature.rs`, `blend_cluster/remove.rs` and `refuse_cavity_shells` in
 * the operations crate) all open `solid has N cavity shell(s); …`. The
 * count is the kernel's own read of the target's topology, so the cause is
 * recorded only where the kernel states it.
 */
const CAVITY_SHELL_REFUSAL = /\bsolid has \d+ cavity shell\(s\)/;

/**
 * The typed refusal for a modeling `operation` the kernel refused with
 * `error`, carrying `message` (the sentence the caller has always shown).
 * A direct edit (a face offset) files under `direct-edit`, beside the edits
 * that already have typed twins. A refusal for the target's cavity shells
 * records {@link SEALED_CAVITY_REASON} unless the caller read a cause itself.
 */
export function modelingOperationRefusal(
  operation: string,
  error: unknown,
  message: string,
  family: 'modeling' | 'direct-edit' = 'modeling',
  /**
   * The cause the adapter read for a code that covers several (a refused
   * split's `plane_on_face`; see `exact-split-contact.ts`), recorded as the
   * refusal's `reason`.
   */
  kernelReason?: string
): KernelRefusal {
  const kernelMessage =
    error instanceof Error ? error.message : 'unknown kernel error';
  const cause =
    kernelReason ??
    (CAVITY_SHELL_REFUSAL.test(kernelMessage)
      ? SEALED_CAVITY_REASON
      : undefined);
  return new KernelRefusal({
    family,
    category: operationErrorCategory(kernelMessage),
    kernelCode: `${operation}_refused`,
    kernelMessage,
    message,
    reason: message,
    ...(cause ? { kernelReason: cause } : {}),
    cause: error
  });
}
