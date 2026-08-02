import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  deepClone,
  PANEL_WIDTH_LIMITS,
  type AppSettings
} from '@openzcad/shared';
import {
  ASSISTANT_VIEWPORT_SHARE,
  clampAssistantWidth,
  clampSidebarWidth,
  maxAssistantWidth,
  maxSidebarWidth,
  savedPanelWidths,
  SIDEBAR_VIEWPORT_SHARE
} from '../apps/web/src/lib/panelWidths';

/** A window wide enough that only the absolute limits can bind. */
const WIDE = 3_000;

describe('resizable panel widths', () => {
  it('keeps a width the user chose', () => {
    expect(clampSidebarWidth(400, WIDE)).toBe(400);
    expect(clampAssistantWidth(520, WIDE)).toBe(520);
  });

  it('holds a panel between its usable minimum and maximum', () => {
    expect(clampSidebarWidth(20, WIDE)).toBe(PANEL_WIDTH_LIMITS.sidebar.min);
    expect(clampSidebarWidth(9_000, WIDE)).toBe(PANEL_WIDTH_LIMITS.sidebar.max);
    expect(clampAssistantWidth(10, WIDE)).toBe(
      PANEL_WIDTH_LIMITS.assistant.min
    );
    expect(clampAssistantWidth(9_000, WIDE)).toBe(
      PANEL_WIDTH_LIMITS.assistant.max
    );
  });

  it('leaves the viewport the larger share of a narrow window', () => {
    // 1200px: both panels at their absolute maximum would leave 1280 - 560 -
    // 720 = nothing for the model, which is the whole point of the app.
    const window = 1_200;
    const sidebar = clampSidebarWidth(560, window);
    const assistant = clampAssistantWidth(720, window);
    expect(sidebar).toBe(Math.round(window * SIDEBAR_VIEWPORT_SHARE));
    expect(assistant).toBe(Math.round(window * ASSISTANT_VIEWPORT_SHARE));
    expect(window - sidebar - assistant).toBeGreaterThan(320);
  });

  it('never narrows a panel past its minimum, however small the window', () => {
    expect(clampSidebarWidth(300, 400)).toBe(PANEL_WIDTH_LIMITS.sidebar.min);
    expect(clampAssistantWidth(400, 400)).toBe(
      PANEL_WIDTH_LIMITS.assistant.min
    );
  });

  it('falls back to the full range when the window is not measurable', () => {
    // Server rendering, or a first paint before layout: an unknown window must
    // not be read as a tiny one and shrink the panels to their minimum.
    expect(maxSidebarWidth(0)).toBe(PANEL_WIDTH_LIMITS.sidebar.max);
    expect(maxAssistantWidth(Number.NaN)).toBe(
      PANEL_WIDTH_LIMITS.assistant.max
    );
    expect(clampSidebarWidth(500, 0)).toBe(500);
  });

  it('rounds to whole pixels and rejects nonsense', () => {
    expect(clampSidebarWidth(300.4, WIDE)).toBe(300);
    expect(clampSidebarWidth(Number.NaN, WIDE)).toBe(
      PANEL_WIDTH_LIMITS.sidebar.default
    );
    expect(clampAssistantWidth(Number.POSITIVE_INFINITY, WIDE)).toBe(
      PANEL_WIDTH_LIMITS.assistant.default
    );
  });

  it('reads the saved widths, and survives an account copy without them', () => {
    const settings = deepClone(DEFAULT_APP_SETTINGS);
    settings.layout = { sidebarWidth: 320, assistantWidth: 440 };
    expect(savedPanelWidths(settings)).toEqual({
      sidebar: 320,
      assistant: 440
    });

    // What a Worker still on the previous settings schema would return.
    const { layout: _layout, ...legacy } = deepClone(DEFAULT_APP_SETTINGS);
    expect(savedPanelWidths(legacy as AppSettings)).toEqual({
      sidebar: PANEL_WIDTH_LIMITS.sidebar.default,
      assistant: PANEL_WIDTH_LIMITS.assistant.default
    });
  });
});
