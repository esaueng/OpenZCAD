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
import { KernelRefusal, type KernelRefusalCategory } from './kernel-refusal';

/**
 * `OperationsError` Display forms and the category each projects to, most
 * specific first.
 */
const OPERATION_ERROR_CATEGORIES: ReadonlyArray<
  readonly [RegExp, KernelRefusalCategory]
> = [
  [/\bexact-only policy\b/, 'quality_refused'],
  [/: unsupported configuration: |\bdoes not support\b/, 'unsupported'],
  [/\bcancelled\b/i, 'cancelled'],
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
 * The typed refusal for a modeling `operation` the kernel refused with
 * `error`, carrying `message` (the sentence the caller has always shown).
 */
export function modelingOperationRefusal(
  operation: string,
  error: unknown,
  message: string
): KernelRefusal {
  const kernelMessage =
    error instanceof Error ? error.message : 'unknown kernel error';
  return new KernelRefusal({
    family: 'modeling',
    category: operationErrorCategory(kernelMessage),
    kernelCode: `${operation}_refused`,
    kernelMessage,
    message,
    reason: message,
    cause: error
  });
}
