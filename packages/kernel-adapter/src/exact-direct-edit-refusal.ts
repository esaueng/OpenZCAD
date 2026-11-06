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
  radius: number
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
 */
export function resizeCylindricalFaceTyped(
  kernel: RemusKernel,
  solid: number,
  face: number,
  radius: number
): number {
  const twin = (kernel as { resizeCylindricalFaceDetailed?: ResizeTwin })
    .resizeCylindricalFaceDetailed;
  if (typeof twin !== 'function') {
    return kernel.resizeCylindricalFace(solid, face, radius);
  }
  const detailed = twin.call(kernel, solid, face, radius);
  if (detailed.status === 'ok') {
    return detailed.value;
  }
  const details = detailed.details ?? {};
  const kernelMessage =
    kernelDetailString(details, 'message') ??
    'the exact modeling engine gave no further detail';
  const kernelCode = kernelDetailString(details, 'kernelCode') ?? detailed.code;
  const kernelReason = kernelDetailString(details, 'reason');
  const message =
    kernelCode === 'cylinder-diameter-unbuildable'
      ? 'That diameter does not fit the existing supports and fillets. Try a smaller diameter.'
      : kernelMessage;
  const neighborSurfaceType = kernelDetailString(
    details,
    'neighborSurfaceType'
  );
  throw new DirectEditRefusal({
    family: 'direct-edit',
    category: detailed.category,
    kernelCode,
    kernelMessage,
    reason: message,
    message:
      message === kernelMessage ? message : `${message}\n${kernelMessage}`,
    ...(kernelReason ? { kernelReason } : {}),
    ...(neighborSurfaceType ? { neighborSurfaceType } : {})
  });
}
