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
