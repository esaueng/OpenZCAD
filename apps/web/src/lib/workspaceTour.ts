/**
 * The first-model guided tour.
 *
 * Four coach-mark steps over the live workspace, shown once per device the
 * first time a project opens EMPTY. The step reached is kept per device, so
 * a second empty project picks up where the first left off rather than at
 * 1/4 again (13 November review I16). Each step names one leg of the modeling
 * loop and, where the app can observe it, completes itself the moment the
 * user actually does the thing — a tour that advances on real actions teaches
 * the workspace; one that only pages through text teaches the tour. Next
 * moves on from any step by hand.
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
  /** The History panel is on screen, docked or floating. */
  historyOpen: boolean;
  /** The export dialog has been opened at least once this session. */
  exportSeen: boolean;
}

/** A command's live key as shown, or undefined when it is unbound. */
export type TourKeyLabel = (commandId: string) => string | undefined;

/**
 * A step's words: the touch wording on a device that only takes touch
 * (`touch`), where there is no key to press or button to right-click.
 */
export function tourStepBody(
  step: WorkspaceTourStep,
  keyLabel: TourKeyLabel,
  touch = false
): string {
  if (touch) return step.touchBody;
  return typeof step.body === 'function' ? step.body(keyLabel) : step.body;
}

export interface WorkspaceTourStep {
  id: WorkspaceTourStepId;
  title: string;
  /**
   * A body that names a key takes the live label (`useKeymap`), so a remap
   * is what the tour teaches; read it through `tourStepBody`.
   */
  body: string | ((keyLabel: TourKeyLabel) => string);
  /**
   * The same lesson for a finger: tap rather than click, the card's Done
   * rather than Enter, a held row rather than a right-click (I12).
   */
  touchBody: string;
  /**
   * Chrome the step points at, outlined while the step is up. A selector
   * list outlines every part it names: the rail and the button at its foot.
   */
  targetSelector: string | null;
  /**
   * For a step whose action reveals what it talks about: once the signals
   * show that action done (`done`), the step stays up with its tips and
   * points at what was revealed (`targetSelector`) instead, until Next.
   * Advancing the moment History opened took its tips away with it, as the
   * panel was still arriving (13 November review I16).
   */
  holdAfter?: {
    done(signals: WorkspaceTourSignals): boolean;
    targetSelector: string;
  };
  /** True when the signals show the user already did this step's action. */
  isComplete(signals: WorkspaceTourSignals): boolean;
  /**
   * True when the change from `before` to `after` is this step's action,
   * done while the step is the one showing. For a step whose lesson is not
   * its action alone: a state that merely holds when the step comes up
   * (History left open earlier) does not skip what the step has to say.
   */
  completesOn?(
    before: WorkspaceTourSignals,
    after: WorkspaceTourSignals
  ): boolean;
}

export const WORKSPACE_TOUR_STEPS: readonly WorkspaceTourStep[] = [
  {
    id: 'create',
    title: 'Create your first feature',
    body: (keyLabel) => {
      const boxKey = keyLabel('tool-box');
      return `Pick a tool from the rail on the left — click Box (the cube)${boxKey ? `, or press ${boxKey},` : ''} then press Enter to create it. Select a face, edge or body and the rail shows that pick's tools instead, under its name; More tools (⋯) at its foot opens the rest.`;
    },
    touchBody:
      'Tap Box (the cube) in the rail on the left, then Done on its card to create it. Tap a face, edge or body and the rail shows that pick’s tools instead; More tools (⋯) at its foot opens the rest.',
    // The foot's button is an unlabelled ⋯, so the step names it as its
    // tooltip does and outlines it too (I16).
    targetSelector: '.tool-palette, .command-more-toggle',
    isComplete: (signals) => signals.featureCount > 0
  },
  {
    id: 'inspect',
    title: 'Select to edit',
    body: 'Click a face or an edge on the model. The tool card that appears offers the exact edits that surface supports — drag the handle, or tap the value to type.',
    touchBody:
      'Tap a face or an edge on the model. The tool card that appears offers the exact edits that surface supports — drag the handle, or tap the value to type it.',
    targetSelector: null,
    isComplete: (signals) => signals.hasSelection
  },
  {
    id: 'history',
    title: 'The history is the model',
    body: 'Open History from the rail on the right. Every feature lands there and replays in order. Drag the grip to reorder, right-click a row for actions, and roll back with the clock on a row.',
    touchBody:
      'Tap History in the rail on the right. Every feature lands there and replays in order. Drag the grip to reorder, touch and hold a row for its actions, and roll back with the clock on a row.',
    targetSelector: '.rail-panels [aria-label="History panel"]',
    // Never done ahead of time: the step is how the user learns the history
    // is the model, so it is always shown. Opening History is the action it
    // asks for, but its tips are about the panel that opens: the step holds
    // over the open panel until Next, rather than vanishing as it arrives.
    isComplete: () => false,
    holdAfter: {
      done: (signals) => signals.historyOpen,
      targetSelector: '.model-panel-history'
    }
  },
  {
    id: 'export',
    title: 'Take it with you',
    body: 'File › Export writes STEP for CAD, STL and 3MF for printing, and DXF from any planar face. Autosave keeps the project on this device while you work.',
    touchBody:
      'File › Export writes STEP for CAD, STL and 3MF for printing, and DXF from any planar face. Autosave keeps the project on this device while you work.',
    // File, at the top bar's start: the step named Export but showed where
    // to find it nowhere (I16).
    targetSelector: '.file-menu > summary',
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

/**
 * Where the tour stands after the signals change from `before` to `after`:
 * past the step at `index` when the change is the action that step asks for
 * (`completesOn`), then past every step the user has already done.
 */
export function advanceOnSignals(
  index: number,
  before: WorkspaceTourSignals,
  after: WorkspaceTourSignals
): number {
  const acted = WORKSPACE_TOUR_STEPS[index]?.completesOn?.(before, after);
  return advanceThroughCompleted(acted ? index + 1 : index, after);
}

/**
 * What the step at `index` points at under these signals: what its action
 * revealed once that is done, otherwise its own target.
 */
export function tourStepTarget(
  index: number,
  signals: WorkspaceTourSignals
): string | null {
  const step = WORKSPACE_TOUR_STEPS[index];
  if (!step) return null;
  return step.holdAfter?.done(signals)
    ? step.holdAfter.targetSelector
    : step.targetSelector;
}
