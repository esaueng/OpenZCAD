/**
 * The cylindrical-face resize as typed data.
 *
 * Remus's plain `resizeCylindricalFace` throws a bare `Error` carrying kernel
 * prose, so a resize the engine will not follow — a wall whose rim meets a
 * sphere, a blind bore whose wall does not end in full circles — was
 * indistinguishable from any other failure, and the small-change detour in
 * `exact-direct-edit-ops` spent four more resizes proving it. The typed twin
 * `resizeCylindricalFaceDetailed` (Remus #1550) answers the same call as a
 * status, a stable code (`unsupported_move_face`) and a category from the
 * shared taxonomy, with the kernel's cause in `details.reason`. This module is
 * the one place that reads it.
 *
 * Nothing here reads the kernel's sentence. `message` relays it verbatim so
 * the warning text is unchanged; the branchable fields are the category, the
 * code and the cause.
 */
import type {
  RemusKernel,
  SolidOperationDetailedResult
} from './remus-runtime';
import { KernelRefusal, kernelDetailString } from './kernel-refusal';

/** The typed twin's signature, for a kernel that may predate it. */
type ResizeTwin = (
  solid: number,
  face: number,
  radius: number,
  allowApproximate?: boolean
) => SolidOperationDetailedResult;

/**
 * A cylindrical-face resize the kernel refused, as a typed error.
 *
 * `kernelReason` is the kernel's `details.reason` — `unsupported_neighbor`,
 * `partial_reversed_wall` or `unclassified` on the pin — and
 * `neighborSurfaceType` is present only for the neighbour case.
 */
export class DirectEditRefusal extends KernelRefusal {
  readonly operation = 'resize-cylindrical-face';
}

/**
 * Resize one cylindrical face, answering a refusal as a
 * {@link DirectEditRefusal}.
 *
 * Falls back to the legacy throw on a kernel without the twin, so an older
 * runtime keeps today's behaviour rather than failing to load.
 *
 * `onApproximate`, when given, permits the kernel's one approximate path and
 * is told when it was taken. A wall whose seam with a sphere carries a
 * freeform (NURBS) fillet is resized by removing the band, resizing the
 * sharp wall and rolling the ball back on; that band has no exact form, so
 * it can only come back at the approximate quality it already had. An exact
 * (torus) band is still rebuilt exactly or refused — the kernel never
 * approximates an exact blend — which is the owner's 2026-11-06 rule
 * (docs/plans/kernel-robustness-plan-2026-11-05.md). Without the callback the
 * call stays exact-only and such a wall refuses with
 * `approximate_reblend_not_permitted`.
 */
export function resizeCylindricalFaceTyped(
  kernel: RemusKernel,
  solid: number,
  face: number,
  radius: number,
  onApproximate?: () => void
): number {
  const twin = (kernel as { resizeCylindricalFaceDetailed?: ResizeTwin })
    .resizeCylindricalFaceDetailed;
  if (typeof twin !== 'function') {
    return kernel.resizeCylindricalFace(solid, face, radius);
  }
  const detailed = onApproximate
    ? twin.call(kernel, solid, face, radius, true)
    : twin.call(kernel, solid, face, radius);
  if (detailed.status === 'ok') {
    if (detailed.details?.quality === 'approximate') onApproximate?.();
    return detailed.value;
  }
  const details = detailed.details ?? {};
  const kernelMessage =
    kernelDetailString(details, 'message') ??
    'the exact modeling engine gave no further detail';
  const kernelReason = kernelDetailString(details, 'reason');
  const neighborSurfaceType = kernelDetailString(
    details,
    'neighborSurfaceType'
  );
  throw new DirectEditRefusal({
    family: 'direct-edit',
    category: detailed.category,
    kernelCode: kernelDetailString(details, 'kernelCode') ?? detailed.code,
    kernelMessage,
    reason: kernelMessage,
    message: kernelMessage,
    ...(kernelReason ? { kernelReason } : {}),
    ...(neighborSurfaceType ? { neighborSurfaceType } : {})
  });
}
