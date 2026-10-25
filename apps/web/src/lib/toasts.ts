/**
 * Transient notices: the answer to "did that work?" for actions whose only
 * other trace is a line in the status log. One is visible at a time; a new one
 * replaces the current one rather than queueing behind it, because the newest
 * action is the one the user is looking at.
 */

export const TOAST_LIFETIME_MS = 8000;
/** Long enough for the closing fade; the stylesheet keeps it at --dur-fast. */
export const TOAST_EXIT_MS = 120;

export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastModel {
  id: number;
  message: string;
  action?: ToastAction;
  /**
   * The status entry (its `at` stamp) this toast restates, captured when that
   * outcome status was set (a delete, a duplicate). Only that status steps
   * aside for it, for good; any other status, set before or after, is left
   * alone, and so is every status under a toast that restates none (a reload
   * offer, a failure).
   */
  repeatsStatusAt?: number;
}

/** Which status entry the status readout should treat the toast as repeating. */
export function statusRepeatedByToast(
  toast: ToastModel | null
): { toastId: number; statusAt: number } | null {
  return toast?.repeatsStatusAt === undefined
    ? null
    : { toastId: toast.id, statusAt: toast.repeatsStatusAt };
}

export function countLabel(
  count: number,
  singular: string,
  plural: string
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Deleting a feature is instant and unguarded; the toast is what makes it
 * reversible without knowing the shortcut, and it says how much was resting
 * on the feature so a wide blast radius is visible before the model is.
 */
export function deleteFeatureToastMessage(
  name: string,
  dependentCount: number
): string {
  return dependentCount === 0
    ? `Deleted ${name}`
    : `Deleted ${name} · ${countLabel(dependentCount, 'feature', 'features')} depended on it`;
}

/**
 * Suppressing a feature rebuilds everything after it, and a later feature
 * that referenced its faces or body quietly drops to "needs repair". The
 * toast says how many did — only those the toggle broke, not ones already
 * broken — so the cascade is read here rather than discovered in the tree.
 */
export function suppressFeatureToastMessage(
  name: string,
  resumed: boolean,
  newlyNeedingRepair: number
): string {
  const verb = resumed ? 'Resumed' : 'Suppressed';
  return newlyNeedingRepair === 0
    ? `${verb} ${name}`
    : `${verb} ${name} · ${countLabel(newlyNeedingRepair, 'later feature', 'later features')} now ${newlyNeedingRepair === 1 ? 'needs' : 'need'} repair`;
}

/**
 * Why Undo is spent when older steps were dropped to keep the history within
 * its limits. "Nothing to undo" would be untrue: there was more, it was just
 * not kept. The Undo button's help and the palette's disabled reason share it.
 */
export const UNDO_FLOOR_TRIMMED_REASON = 'No older undo steps kept';

/**
 * Raised by the undo that reaches that floor — the one moment a dropped step
 * matters — with Revisions as the action, since save points are how to go
 * back further.
 */
export const UNDO_FLOOR_TRIMMED_NOTICE =
  'Oldest undo step kept · save points go further back';
