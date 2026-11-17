/**
 * Typed refusals for the kernel's blend resize and removal.
 *
 * `resizeBlend` and `resizeBlendWithEvolution` throw a bare `Error` whose
 * message starts with a stable code (`ResizeBlendError::code` in Remus):
 * `` `${code}: ${message}` ``. Until this module, the build loop saw only that
 * prose, so a fillet the kernel cannot remove or resize reached the user — and
 * the K10 combination matrix — as an untyped refusal. The code is data, read by
 * prefix exactly as the other blend families read theirs, and the category is
 * this adapter's projection of it onto the kernel taxonomy.
 */
import { KernelRefusal, type KernelRefusalCategory } from './kernel-refusal';

/**
 * Every code `ResizeBlendError::code` returns on the pin, with the category
 * the adapter files it under: a configuration the kernel cannot rebuild yet
 * is `unsupported`; a radius or band the request does not fit is
 * `invalid_input`.
 */
export const RESIZE_BLEND_REFUSAL_CATEGORIES: Readonly<
  Record<string, KernelRefusalCategory>
> = {
  'invalid-input': 'invalid_input',
  'blend-band-not-analytic': 'unsupported',
  'blend-radius-mismatch': 'invalid_input',
  'band-touches-freeform': 'unsupported',
  'unsupported-support-pair': 'unsupported',
  'radius-too-large': 'invalid_input',
  'resize-blend-failed': 'unsupported'
};

/**
 * The typed refusal behind an error a blend resize threw, or `null` when the
 * error does not start with one of the resize codes (anything else — a stale
 * handle, a validation failure raised by the caller — keeps its own path).
 */
export function resizeBlendRefusalOf(error: unknown): KernelRefusal | null {
  if (!(error instanceof Error) || error instanceof KernelRefusal) {
    return null;
  }
  const message = error.message.trim();
  const separator = message.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const code = message.slice(0, separator);
  const category = RESIZE_BLEND_REFUSAL_CATEGORIES[code];
  if (!category) {
    return null;
  }
  const detail = message.slice(separator + 1).trim();
  return new KernelRefusal({
    family: 'blend',
    category,
    kernelCode: code,
    kernelMessage: detail,
    // The sentence the build loop has always shown, unchanged: the prose
    // table still reads `radius-too-large:` from it.
    message,
    reason: message,
    cause: error
  });
}

/** Run a blend resize, rethrowing a coded refusal as a {@link KernelRefusal}. */
export function withResizeBlendRefusal<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    throw resizeBlendRefusalOf(error) ?? error;
  }
}
