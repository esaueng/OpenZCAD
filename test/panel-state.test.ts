import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_STATE,
  defaultPanelState,
  effectivePanels,
  loadPanelState,
  normalizePanelState,
  PANEL_STATE_STORAGE_KEY,
  savePanelState,
  SIDEBAR_SECTION_IDS,
  toggleToolGroup
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

  it('keeps the v1 drawer fields for rollback and the layout migration', () => {
    // Nothing reads them for the UI any more, but they round-trip as stored
    // so an older build finds the drawer the way it left it.
    expect(defaultPanelState().drawerOpen).toBe(false);
    expect(normalizePanelState({ drawerOpen: true }).drawerOpen).toBe(true);
    expect(normalizePanelState({ drawerOpen: 'yes' }).drawerOpen).toBe(false);
    const stored = normalizePanelState({
      drawerOpen: true,
      sidebarSections: { history: false }
    });
    expect(savePanelState(stored)).toBe(true);
    expect(loadPanelState()).toMatchObject({
      drawerOpen: true,
      sidebarSections: { history: false, parameters: true }
    });
  });

  it('keeps the command card fold closed until it is opened', () => {
    expect(defaultPanelState().commandFoldOpen).toBe(false);
    expect(normalizePanelState({ commandFoldOpen: true }).commandFoldOpen).toBe(
      true
    );
    expect(
      normalizePanelState({ commandFoldOpen: 'open' }).commandFoldOpen
    ).toBe(false);
    savePanelState({ ...defaultPanelState(), commandFoldOpen: true });
    expect(loadPanelState().commandFoldOpen).toBe(true);
  });

  it('remembers the sketch palette flyout across sketch sessions', () => {
    expect(defaultPanelState().sketchPaletteOpen).toBe(false);
    expect(
      normalizePanelState({ sketchPaletteOpen: true }).sketchPaletteOpen
    ).toBe(true);
    expect(
      normalizePanelState({ sketchPaletteOpen: 1 }).sketchPaletteOpen
    ).toBe(false);
  });

  it('opens Tweak’s parameter table to begin with and remembers a close', () => {
    expect(defaultPanelState().tweakPanelOpen).toBe(true);
    expect(normalizePanelState({ tweakPanelOpen: false }).tweakPanelOpen).toBe(
      false
    );
    expect(normalizePanelState({ tweakPanelOpen: 'no' }).tweakPanelOpen).toBe(
      true
    );
  });

  it('shows the section controls to begin with and remembers hiding them', () => {
    expect(defaultPanelState().sectionPanelOpen).toBe(true);
    expect(
      normalizePanelState({ sectionPanelOpen: false }).sectionPanelOpen
    ).toBe(false);
    expect(
      normalizePanelState({ sectionPanelOpen: 'no' }).sectionPanelOpen
    ).toBe(true);
  });

  it('folds one tool group without touching the others', () => {
    // Open to begin with: the names on the tiles are what make the tools
    // learnable, and folding is a choice someone makes for column height.
    const state = defaultPanelState();
    expect(state.toolGroups.bodies).toBe(true);
    const folded = toggleToolGroup(state, 'bodies');
    expect(folded.toolGroups.bodies).toBe(false);
    expect(folded.toolGroups.create).toBe(true);
    expect(savePanelState(folded)).toBe(true);
    expect(loadPanelState().toolGroups.bodies).toBe(false);
    expect(
      normalizePanelState({ toolGroups: { bodies: 'no', pattern: false } })
        .toolGroups
    ).toEqual({ ...state.toolGroups, pattern: false });
  });

  it('round-trips through device storage', () => {
    const state = defaultPanelState();
    state.sidebarSections.diagnostics = false;
    expect(savePanelState(state)).toBe(true);
    const loaded = loadPanelState();
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

  it('remembers Tweak as a workspace mode of its own', () => {
    expect(
      savePanelState({ ...defaultPanelState(), workspaceMode: 'tweak' })
    ).toBe(true);
    expect(loadPanelState().workspaceMode).toBe('tweak');
    expect(normalizePanelState({ workspaceMode: 'tweak' }).workspaceMode).toBe(
      'tweak'
    );
  });

  it('remembers the Drawing workspace (D01)', () => {
    expect(
      savePanelState({ ...defaultPanelState(), workspaceMode: 'drawing' })
    ).toBe(true);
    expect(loadPanelState().workspaceMode).toBe('drawing');
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

  it('remembers the parts rail across reloads', () => {
    // Open to begin with; collapsing it is what leaves a single-body model the
    // bare viewport, and that choice is a habit worth restoring.
    expect(defaultPanelState().viewModeRailOpen).toBe(true);
    expect(
      savePanelState({ ...defaultPanelState(), viewModeRailOpen: false })
    ).toBe(true);
    expect(loadPanelState().viewModeRailOpen).toBe(false);
    expect(
      normalizePanelState({ viewModeRailOpen: 'no' }).viewModeRailOpen
    ).toBe(true);
  });

  it('remembers a dismissed first-model tour across reloads', () => {
    // Not dismissed to begin with — a fresh device gets the tour on its first
    // empty project — and a dismissal is forever on this device.
    expect(defaultPanelState().workspaceTourDismissed).toBe(false);
    expect(
      savePanelState({ ...defaultPanelState(), workspaceTourDismissed: true })
    ).toBe(true);
    expect(loadPanelState().workspaceTourDismissed).toBe(true);
    expect(
      normalizePanelState({ workspaceTourDismissed: 'yes' })
        .workspaceTourDismissed
    ).toBe(false);
  });

  it('ignores unknown sections and wrong types', () => {
    const normalized = normalizePanelState({
      // A field from before the tool palette moved into the column: ignored.
      toolPaletteOpen: 'yes',
      sidebarSections: {
        history: false,
        parameters: 'no',
        somethingElse: false
      }
    });
    expect(normalized.sidebarSections.history).toBe(false);
    expect(normalized.sidebarSections.parameters).toBe(true);
    expect(Object.keys(normalized.sidebarSections).sort()).toEqual(
      [...SIDEBAR_SECTION_IDS].sort()
    );
  });
});

describe('panel suspension while a mode has the stage', () => {
  const idle = { suspended: false, panelsReleased: false, foldReleased: false };
  const suspended = { ...idle, suspended: true };

  it('shows what the user chose while no mode suspends the panels', () => {
    expect(effectivePanels({ commandFoldOpen: true }, idle)).toEqual({
      panelsSuspended: false,
      commandFoldOpen: true
    });
    expect(effectivePanels({ commandFoldOpen: false }, idle)).toEqual({
      panelsSuspended: false,
      commandFoldOpen: false
    });
  });

  it('suspends the panels and hides the fold, preference untouched', () => {
    const state = { ...defaultPanelState(), commandFoldOpen: true };
    expect(effectivePanels(state, suspended)).toEqual({
      panelsSuspended: true,
      commandFoldOpen: false
    });
    // Suspension is not a write: the stored choice is what comes back.
    expect(state.commandFoldOpen).toBe(true);
    savePanelState(state);
    expect(loadPanelState().commandFoldOpen).toBe(true);
  });

  it('never opens a fold the user left closed', () => {
    expect(
      effectivePanels(
        { commandFoldOpen: false },
        { suspended: true, panelsReleased: true, foldReleased: true }
      ).commandFoldOpen
    ).toBe(false);
  });

  it('lets the panels and the fold be released during the mode, each on its own', () => {
    expect(
      effectivePanels(
        { commandFoldOpen: true },
        { ...suspended, panelsReleased: true }
      )
    ).toEqual({ panelsSuspended: false, commandFoldOpen: false });
    expect(
      effectivePanels(
        { commandFoldOpen: true },
        { ...suspended, foldReleased: true }
      )
    ).toEqual({ panelsSuspended: true, commandFoldOpen: true });
  });
});
