import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_STATE,
  defaultPanelState,
  loadPanelState,
  normalizePanelState,
  PANEL_STATE_STORAGE_KEY,
  savePanelState,
  SIDEBAR_SECTION_IDS,
  toggleSidebarSection
} from '../apps/web/src/lib/panelState';

function installLocalStorage(): void {
  const entries = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear()
    }
  };
}

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('workspace panel state', () => {
  it('starts with every panel open', () => {
    const state = defaultPanelState();
    expect(state.toolPaletteOpen).toBe(true);
    for (const id of SIDEBAR_SECTION_IDS) {
      expect(state.sidebarSections[id]).toBe(true);
    }
  });

  it('returns independent defaults', () => {
    const first = defaultPanelState();
    first.sidebarSections.history = false;
    expect(defaultPanelState().sidebarSections.history).toBe(true);
    expect(DEFAULT_PANEL_STATE.sidebarSections.history).toBe(true);
  });

  it('toggles one section without touching the others', () => {
    const collapsed = toggleSidebarSection(defaultPanelState(), 'history');
    expect(collapsed.sidebarSections.history).toBe(false);
    expect(collapsed.sidebarSections.parameters).toBe(true);
    expect(collapsed.toolPaletteOpen).toBe(true);
    expect(
      toggleSidebarSection(collapsed, 'history').sidebarSections.history
    ).toBe(true);
  });

  it('round-trips through device storage', () => {
    const state = toggleSidebarSection(
      { ...defaultPanelState(), toolPaletteOpen: false },
      'diagnostics'
    );
    expect(savePanelState(state)).toBe(true);
    const loaded = loadPanelState();
    expect(loaded.toolPaletteOpen).toBe(false);
    expect(loaded.sidebarSections.diagnostics).toBe(false);
    expect(loaded.sidebarSections.history).toBe(true);
  });

  it('falls back to open panels on missing or corrupt storage', () => {
    // Chrome layout must never be what stops the workspace from rendering.
    expect(loadPanelState()).toEqual(defaultPanelState());
    window.localStorage.setItem(PANEL_STATE_STORAGE_KEY, 'not json');
    expect(loadPanelState()).toEqual(defaultPanelState());
    expect(normalizePanelState(null)).toEqual(defaultPanelState());
    expect(normalizePanelState([1, 2])).toEqual(defaultPanelState());
  });

  it('remembers the assistant dock across reloads', () => {
    // Collapsed to begin with — a new workspace opens on the model — but the
    // choice is a layout habit, so opening it has to survive a reload.
    expect(defaultPanelState().assistantCollapsed).toBe(true);
    expect(
      savePanelState({ ...defaultPanelState(), assistantCollapsed: false })
    ).toBe(true);
    expect(loadPanelState().assistantCollapsed).toBe(false);
    expect(
      normalizePanelState({ assistantCollapsed: 'yes' }).assistantCollapsed
    ).toBe(true);
  });

  it('remembers the workspace mode across reloads', () => {
    // Build to begin with: View has to be chosen, never arrived at by default.
    expect(defaultPanelState().workspaceMode).toBe('build');
    expect(
      savePanelState({ ...defaultPanelState(), workspaceMode: 'view' })
    ).toBe(true);
    expect(loadPanelState().workspaceMode).toBe('view');
  });

  it('falls back to Build on an unrecognised workspace mode', () => {
    // A stored value from a future build must not strip the modeling UI.
    expect(normalizePanelState({ workspaceMode: 'review' }).workspaceMode).toBe(
      'build'
    );
    expect(normalizePanelState({ workspaceMode: 7 }).workspaceMode).toBe(
      'build'
    );
  });

  it('ignores unknown sections and wrong types', () => {
    const normalized = normalizePanelState({
      toolPaletteOpen: 'yes',
      sidebarSections: {
        history: false,
        parameters: 'no',
        somethingElse: false
      }
    });
    expect(normalized.toolPaletteOpen).toBe(true);
    expect(normalized.sidebarSections.history).toBe(false);
    expect(normalized.sidebarSections.parameters).toBe(true);
    expect(Object.keys(normalized.sidebarSections).sort()).toEqual(
      [...SIDEBAR_SECTION_IDS].sort()
    );
  });
});
