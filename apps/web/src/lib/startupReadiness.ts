import { mark } from './perf';

/**
 * The workspace's readiness signals, as User Timing marks.
 *
 * Largest Contentful Paint cannot see a CAD model: the model is drawn into a
 * WebGL canvas, and canvas paints are not LCP candidates, so LCP settles on
 * whichever text happens to be largest (on a reload, a one-line hint that
 * appears seconds later). These two marks say when the opened project is
 * actually on screen and usable, and are the numbers to monitor instead
 * (docs/performance-baseline.md, "Readiness marks"):
 *
 * - `oz:model-visible` — the first rendered frame that shows the opened
 *   project's exact geometry for its current version (meshes may still be
 *   waiting for their topology analysis).
 * - `oz:input-ready` — the first rendered frame after that analysis is
 *   complete, when picking, selection and every modeling tool work on what
 *   is drawn.
 *
 * Each is marked once per opened project, so a page load records the startup
 * project's pair first and a later project switch adds its own. Read the
 * first entry for startup: its `startTime` is milliseconds since navigation.
 * Stored meshes drawn before the kernel rebuilds the document do not count;
 * neither does a project with no bodies, which has no model to show.
 */
export const MODEL_VISIBLE_MARK = 'oz:model-visible';
export const INPUT_READY_MARK = 'oz:input-ready';

export interface PresentedGeometry {
  projectId: string;
  analysis: 'pending' | 'ready';
}

export function createReadinessReporter() {
  let visibleProject: string | null = null;
  let readyProject: string | null = null;
  return function report(frame: PresentedGeometry, bodies: number): void {
    if (bodies === 0) return;
    if (visibleProject !== frame.projectId) {
      visibleProject = frame.projectId;
      // A new opening owes its own input-ready, even for a project that was
      // ready before the user left it (A ready, B pending, back to A).
      readyProject = null;
      mark('model-visible', { bodies, analysis: frame.analysis });
    }
    if (frame.analysis === 'ready' && readyProject !== frame.projectId) {
      readyProject = frame.projectId;
      mark('input-ready', { bodies });
    }
  };
}

/** One per page: a viewer remount for the same project is not a new open. */
export const reportPresentedGeometry = createReadinessReporter();
