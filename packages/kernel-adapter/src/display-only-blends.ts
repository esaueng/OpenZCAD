import type { FeatureNode } from '@openzcad/shared';

/**
 * Display-only blends for drag previews.
 *
 * On a body with curved faces nearly all of a kernel fillet's time goes to
 * two postconditions — a fine whole-solid volume measurement and a sampled
 * material check — not to the blend: a six-edge boss-seam fillet measured
 * 455 ms checked against 8 ms without them. A geometry-only preview frame
 * asks the kernel to skip both (`setDisplayOnlyBlends`); the structural
 * checks still run. Complete syncs never do, so a rest check or a commit
 * always rebuilds the blend fully checked.
 *
 * The adapter's own volume envelope on a blend result is skipped the same
 * way (`displayOnlyBlendsActive`).
 *
 * A display-only result must never be served to a checked build. The
 * history cache keys every checkpoint by its features' digests, so a
 * feature that may run a kernel blend gets a salted digest in display-only
 * builds: a checked build cannot restore what a preview stored, while a
 * preview can still restore the checked prefix before its first blend.
 */

/** Feature kinds whose builders call kernel blends (fillet, chamfer, and
 * the direct edits that resize or remove blends). */
const BLENDING_FEATURE_KINDS = new Set<string>([
  'fillet',
  'chamfer',
  'direct-edit'
]);

/** The digest suffix for `feature` in a build with display-only blends. */
export function displayOnlyBlendSalt(
  feature: FeatureNode,
  displayOnlyBlends: boolean
): string {
  return displayOnlyBlends &&
    BLENDING_FEATURE_KINDS.has(feature.data.featureKind)
    ? '|display-only-blends'
    : '';
}

let displayOnly = false;

/**
 * Whether the synchronous build running now is a display-only one. The
 * adapter's own measuring postconditions on a blend (the volume envelope in
 * `exact-edge-modifiers`) follow the kernel's switch: a checked build runs
 * them all.
 */
export function displayOnlyBlendsActive(): boolean {
  return displayOnly;
}

interface DisplayOnlyBlendSwitch {
  setDisplayOnlyBlends?: (enabled: boolean) => void;
}

/**
 * Whether kernels of this class can build blends display-only. On one that
 * cannot, a preview builds checked and its cache keys stay unsalted, exactly
 * as before the switch existed.
 */
export function displayOnlyBlendsSupported(kernelClass: {
  prototype: object;
}): boolean {
  return (
    typeof (kernelClass.prototype as DisplayOnlyBlendSwitch)
      .setDisplayOnlyBlends === 'function'
  );
}

/**
 * Runs synchronous kernel `work` with display-only blends when `enabled`.
 *
 * The kernel's switch is per thread, so it is set for this synchronous
 * chunk alone and always reset, never held across an `await` where another
 * job could run. A kernel without the switch builds checked, as before.
 */
export function withDisplayOnlyBlends<T>(
  kernel: object,
  enabled: boolean,
  work: () => T
): T {
  const toggle = (kernel as DisplayOnlyBlendSwitch).setDisplayOnlyBlends;
  if (!enabled || typeof toggle !== 'function') return work();
  toggle.call(kernel, true);
  displayOnly = true;
  try {
    return work();
  } finally {
    displayOnly = false;
    toggle.call(kernel, false);
  }
}
