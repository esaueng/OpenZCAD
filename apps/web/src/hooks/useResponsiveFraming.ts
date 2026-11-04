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
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let nextFrame = 0;
    const schedule = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      timer = setTimeout(() => {
        // Rails and phone sheets finish their responsive layout first.
        frame = requestAnimationFrame(() => {
          nextFrame = requestAnimationFrame(() => {
            if (latest.current.enabled) latest.current.onFit();
          });
        });
      }, 120);
    };
    schedule();
    window.addEventListener('resize', schedule);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(nextFrame);
      window.removeEventListener('resize', schedule);
    };
  }, [projectId, mode, layoutKey, panels]);
}
