import {
  PANEL_WIDTH_LIMITS,
  type AppSettings,
  type PanelWidthLimits
} from '@openzcad/shared';

/**
 * How much of the window a resized panel may take, as a fraction. These mirror
 * the `min(var(--sidebar-w), 30vw)` style caps in `shell.css`: the stylesheet
 * keeps the viewport from being crowded out at any window size, and these keep
 * the drag from running past the point where the panel stops growing.
 *
 * Their sum leaves the viewport the larger share at every width.
 */
export const SIDEBAR_VIEWPORT_SHARE = 0.3;
export const ASSISTANT_VIEWPORT_SHARE = 0.35;

export const SIDEBAR_WIDTH_LIMITS = PANEL_WIDTH_LIMITS.sidebar;
export const ASSISTANT_WIDTH_LIMITS = PANEL_WIDTH_LIMITS.assistant;

/**
 * The widest this panel may be drawn in a window of `viewportWidth`. Falls back
 * to the absolute maximum when the width is unknown (zero, or a non-browser
 * host) so a missing measurement never collapses the panel to its minimum.
 */
export function maxPanelWidth(
  limits: PanelWidthLimits,
  share: number,
  viewportWidth: number
): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return limits.max;
  }
  return Math.max(
    limits.min,
    Math.min(limits.max, Math.round(viewportWidth * share))
  );
}

function clampPanelWidth(
  width: number,
  limits: PanelWidthLimits,
  share: number,
  viewportWidth: number
): number {
  const maximum = maxPanelWidth(limits, share, viewportWidth);
  if (!Number.isFinite(width)) {
    return Math.min(maximum, limits.default);
  }
  return Math.round(Math.min(maximum, Math.max(limits.min, width)));
}

/**
 * The sidebar width to draw. The stored preference is left alone: a width set
 * on a wide monitor is only narrowed for the current window, so it comes back
 * intact the next time there is room for it.
 */
export function clampSidebarWidth(
  width: number,
  viewportWidth: number
): number {
  return clampPanelWidth(
    width,
    SIDEBAR_WIDTH_LIMITS,
    SIDEBAR_VIEWPORT_SHARE,
    viewportWidth
  );
}

export function clampAssistantWidth(
  width: number,
  viewportWidth: number
): number {
  return clampPanelWidth(
    width,
    ASSISTANT_WIDTH_LIMITS,
    ASSISTANT_VIEWPORT_SHARE,
    viewportWidth
  );
}

export interface SavedPanelWidths {
  sidebar: number;
  assistant: number;
}

/**
 * The saved widths, tolerating an account payload that predates the preference.
 * Settings arriving from the API are not run through the device normalizer, so
 * a Worker still on the older schema would otherwise hand the layout an
 * undefined width — a missing panel size must never be what breaks the editor.
 */
export function savedPanelWidths(settings: AppSettings): SavedPanelWidths {
  const layout = settings.layout as AppSettings['layout'] | undefined;
  return {
    sidebar: layout?.sidebarWidth ?? SIDEBAR_WIDTH_LIMITS.default,
    assistant: layout?.assistantWidth ?? ASSISTANT_WIDTH_LIMITS.default
  };
}

export function maxSidebarWidth(viewportWidth: number): number {
  return maxPanelWidth(
    SIDEBAR_WIDTH_LIMITS,
    SIDEBAR_VIEWPORT_SHARE,
    viewportWidth
  );
}

export function maxAssistantWidth(viewportWidth: number): number {
  return maxPanelWidth(
    ASSISTANT_WIDTH_LIMITS,
    ASSISTANT_VIEWPORT_SHARE,
    viewportWidth
  );
}
