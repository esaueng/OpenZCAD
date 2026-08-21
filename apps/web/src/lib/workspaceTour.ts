/**
 * The first-model guided tour.
 *
 * Four coach-mark steps over the live workspace, shown once per device the
 * first time a project opens EMPTY. Each step names one leg of the modeling
 * loop and, where the app can observe it, completes itself the moment the
 * user actually does the thing — a tour that advances on real actions teaches
 * the workspace; one that only pages through text teaches the tour. Steps the
 * app cannot observe advance manually.
 *
 * Kept pure: the component owns rendering and the index; App owns the
 * signals; this module owns what the steps are and when one is done.
 */

export type WorkspaceTourStepId = 'create' | 'inspect' | 'history' | 'export';

/** What the workspace can observe about the user's progress. */
export interface WorkspaceTourSignals {
  featureCount: number;
  /** A face, edge, or body is currently selected in the viewport. */
  hasSelection: boolean;
  /** The export dialog has been opened at least once this session. */
  exportSeen: boolean;
}

export interface WorkspaceTourStep {
  id: WorkspaceTourStepId;
  title: string;
  body: string;
  /** Chrome region the step points at; highlighted while the step is up. */
  targetSelector: string | null;
  /** True when the signals show the user already did this step's action. */
  isComplete(signals: WorkspaceTourSignals): boolean;
}

export const WORKSPACE_TOUR_STEPS: readonly WorkspaceTourStep[] = [
  {
    id: 'create',
    title: 'Create your first feature',
    body: 'Pick a tool from the Feature tools rail — a Box is one click, or press B. Hover any tool for its name and shortcut.',
    targetSelector: '.tool-palette',
    isComplete: (signals) => signals.featureCount > 0
  },
  {
    id: 'inspect',
    title: 'Select to edit',
    body: 'Click a face or an edge on the model. The tool card that appears offers the exact edits that surface supports — drag the handle, or tap the value to type.',
    targetSelector: null,
    isComplete: (signals) => signals.hasSelection
  },
  {
    id: 'history',
    title: 'The history is the model',
    body: 'Every feature lands in the History panel and replays in order. Drag the grip to reorder, right-click a row for actions, and roll back with the clock.',
    targetSelector: '.sidebar',
    isComplete: () => false
  },
  {
    id: 'export',
    title: 'Take it with you',
    body: 'Export writes STEP for CAD, STL and 3MF for printing, and DXF from any planar face. Autosave keeps the project on this device while you work.',
    targetSelector: null,
    isComplete: (signals) => signals.exportSeen
  }
];

/**
 * The first step at or after `index` the user has NOT already completed —
 * `WORKSPACE_TOUR_STEPS.length` when everything from `index` on is done.
 * Only forward: a selection that is later cleared does not send the tour
 * backwards to re-teach selecting.
 */
export function advanceThroughCompleted(
  index: number,
  signals: WorkspaceTourSignals
): number {
  let next = index;
  while (
    next < WORKSPACE_TOUR_STEPS.length &&
    WORKSPACE_TOUR_STEPS[next]!.isComplete(signals)
  ) {
    next += 1;
  }
  return next;
}
