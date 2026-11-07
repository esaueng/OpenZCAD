import type { RemusKernel } from './remus-runtime';

interface Bindings {
  prepareResizeBlend(solid: number, face: number, radius: number): number;
  prepareResizeCylindricalFace(solid: number, face: number): number;
  previewPreparedGroupEdit(handle: number, radius: number): number;
  commitPreparedGroupEditJournaled(handle: number, radius: number): string;
  releasePreparedGroupEdit(handle: number): boolean;
}
type Kind = 'blend' | 'cylinder';
interface Target {
  solid: number;
  face: number;
  kind: Kind;
  handle: number | null;
}
const targets = new WeakMap<RemusKernel, Target>();
function bindings(kernel: RemusKernel): Bindings | null {
  const b = kernel as unknown as Partial<Bindings>;
  return typeof b.prepareResizeBlend === 'function' &&
    typeof b.prepareResizeCylindricalFace === 'function' &&
    typeof b.previewPreparedGroupEdit === 'function' &&
    typeof b.commitPreparedGroupEditJournaled === 'function' &&
    typeof b.releasePreparedGroupEdit === 'function'
    ? (b as Bindings)
    : null;
}
/** Source checkpoint is restored by the history owner before EVERY call.
 * One live preparation per kernel; preparation refusal retains legacy routes.
 */
export function preparedGroupEdit(
  kernel: RemusKernel,
  solid: number,
  face: number,
  kind: Kind,
  oldRadius: number,
  preview: boolean
) {
  const api = bindings(kernel);
  if (!api) return null;
  let target = targets.get(kernel);
  if (
    target &&
    (target.solid !== solid || target.face !== face || target.kind !== kind)
  ) {
    releasePreparedGroupEdit(kernel);
    target = undefined;
  }
  if (!target) {
    // A release with no live preparation uses the ordinary journaled entry.
    if (!preview) return null;
    target = { solid, face, kind, handle: null };
    targets.set(kernel, target);
    try {
      target.handle =
        kind === 'blend'
          ? api.prepareResizeBlend(solid, face, oldRadius)
          : api.prepareResizeCylindricalFace(solid, face);
    } catch {
      return null;
    }
  }
  if (target.handle === null) return null;
  const handle = target.handle;
  return {
    preview: (radius: number) => api.previewPreparedGroupEdit(handle, radius),
    commit: (radius: number) =>
      api.commitPreparedGroupEditJournaled(handle, radius)
  };
}
export function hasPreparedGroupEdit(kernel: RemusKernel): boolean {
  return targets.get(kernel)?.handle != null;
}
/** The prepared journal can take the ordinary local construction route.
 * Its V1 publisher is still needed for the adapter's support-derived roles.
 * Inferred group history must never be promoted to construction history.
 */
export function preparedCommitNeedsEvolution(
  kernel: RemusKernel,
  op: number
): boolean {
  try {
    const entries: unknown = JSON.parse(kernel.journalSummary());
    if (!Array.isArray(entries)) return true;
    const entry: unknown = entries.find(
      (e: unknown) =>
        e !== null && typeof e === 'object' && 'op' in e && e.op === op
    );
    if (!entry || typeof entry !== 'object' || !('detail' in entry))
      return true;
    const detail: unknown = entry.detail;
    return (
      !detail ||
      typeof detail !== 'object' ||
      !('origin' in detail) ||
      detail.origin !== 'geometry'
    );
  } catch {
    return true;
  }
}
export function releasePreparedGroupEdit(kernel: RemusKernel): void {
  const target = targets.get(kernel);
  targets.delete(kernel);
  if (target?.handle != null) {
    try {
      bindings(kernel)?.releasePreparedGroupEdit(target.handle);
    } catch {
      /* Freed arena. */
    }
  }
}
