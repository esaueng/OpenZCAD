import { useEffect, useRef } from 'react';
import { PANEL_PHONE_MAX_WIDTH, type PanelLayout } from '../lib/panelLayout';

/** Reframe after a deliberate layout change, keeping the current view direction.
 * Drafts and active modeling gestures keep their camera untouched. */
export function useResponsiveFraming({
  projectId,
  mode,
  layout,
  panels,
  enabled,
  onFit
}: {
  projectId: string | null;
  mode: string;
  layout: PanelLayout;
  panels: string;
  enabled: boolean;
  onFit(): void;
}) {
  const latest = useRef({ enabled, onFit });
  latest.current = { enabled, onFit };
  const pendingLayout = useRef(false);
  const resume = useRef<(() => void) | null>(null);
  const framedProject = useRef<string | null>(null);
  const layoutChosen = useRef(false);
  const previousLayout = useRef<string | null>(null);
  // Focusing another docked panel changes recency, not the clear stage. Keep
  // a person's chosen zoom unless the visible arrangement actually changes.
  const layoutKey = JSON.stringify({
    left: layout.left,
    right: layout.right,
    floats: [...layout.floats].sort((a, b) => a.id.localeCompare(b.id)),
    weights: layout.weights,
    columnHeights: layout.columnHeights,
    unpinned: layout.unpinned,
    revealed: layout.revealed,
    options: { ...layout.options, locked: undefined },
    recent:
      window.innerWidth <= PANEL_PHONE_MAX_WIDTH ? layout.recent : undefined
  });
  useEffect(() => {
    const identity = JSON.stringify([projectId, mode, layoutKey, panels]);
    const repeatedMount = previousLayout.current === identity;
    previousLayout.current = identity;
    const projectChanged = framedProject.current !== projectId;
    framedProject.current = projectId;
    if (projectChanged) layoutChosen.current = false;
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let nextFrame = 0;
    const schedule = (layoutChange: boolean) => {
      if (layoutChange) pendingLayout.current = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      timer = setTimeout(() => {
        // Rails and phone sheets finish their responsive layout first.
        frame = requestAnimationFrame(() => {
          nextFrame = requestAnimationFrame(() => {
            if (
              latest.current.enabled &&
              (!layoutChange || pendingLayout.current)
            ) {
              pendingLayout.current = false;
              latest.current.onFit();
            }
          });
        });
      }, 120);
    };
    resume.current = () => schedule(true);
    const resize = () => schedule(false);
    const userNavigation = (event: Event) => {
      if (!(event.target instanceof HTMLCanvasElement)) return;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      pendingLayout.current = false;
      layoutChosen.current = false;
    };
    // The viewer owns initial framing and remembered camera restoration.
    // This hook only reacts to subsequent workspace layout choices.
    if (!projectChanged && !repeatedMount) {
      layoutChosen.current = true;
      schedule(true);
    }
    window.addEventListener('resize', resize);
    window.addEventListener('pointerdown', userNavigation, true);
    window.addEventListener('wheel', userNavigation, {
      capture: true,
      passive: true
    });
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointerdown', userNavigation, true);
      window.removeEventListener('wheel', userNavigation, true);
      resume.current = null;
      pendingLayout.current = false;
    };
  }, [projectId, mode, layoutKey, panels]);
  useEffect(() => {
    if (enabled && pendingLayout.current) resume.current?.();
  }, [enabled]);
  // An explicit cross-mode tool launch can frame immediately after the
  // destination renders, then retire its pending automatic layout request.
  return {
    prepare() {
      if (!latest.current.enabled) return;
      pendingLayout.current = false;
      latest.current.onFit();
    },
    request() {
      resume.current?.();
    },
    mounted() {
      // A lazy panel can arrive after a chosen layout was already framed.
      // Merely restoring a project must keep its remembered camera instead.
      if (layoutChosen.current) resume.current?.();
    }
  };
}
