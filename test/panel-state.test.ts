import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commandFoldsTools,
  DEFAULT_PANEL_STATE,
  defaultPanelState,
  effectiveCommandFold,
  loadPanelState,
  normalizePanelState,
  PANEL_STATE_STORAGE_KEY,
  savePanelState,
  SIDEBAR_SECTION_IDS,
  toggleToolGroup,
  TOOL_DRAWER_QUERY_MAX_LENGTH
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

  it('pins the rail’s original tools to begin with and remembers a rearrangement', () => {
    expect(defaultPanelState().pinnedTools).toEqual([
      'sketch',
      'extrude',
      'box',
      'cylinder',
      'fillet',
      'hole',
      'transform',
      'union'
    ]);
    // Unknown and repeated ids drop out; an emptied rail stays empty.
    expect(
      normalizePanelState({ pinnedTools: ['gear', 'warp', 'gear', 'box'] })
        .pinnedTools
    ).toEqual(['gear', 'box']);
    expect(normalizePanelState({ pinnedTools: [] }).pinnedTools).toEqual([]);
    expect(normalizePanelState({ pinnedTools: 'gear' }).pinnedTools).toEqual(
      defaultPanelState().pinnedTools
    );
    savePanelState({
      ...defaultPanelState(),
      pinnedTools: ['hole', 'sketch'],
      recentTools: ['chamfer']
    });
    expect(loadPanelState()).toMatchObject({
      pinnedTools: ['hole', 'sketch'],
      recentTools: ['chamfer']
    });
  });

  it('remembers guide minimization independently of dismissal', () => {
    const state = { ...defaultPanelState(), workspaceTourMinimized: true };
    expect(savePanelState(state)).toBe(true);
    expect(loadPanelState().workspaceTourMinimized).toBe(true);
    expect(loadPanelState().workspaceTourDismissed).toBe(false);
    expect(
      normalizePanelState({ workspaceTourMinimized: 'yes' })
        .workspaceTourMinimized
    ).toBe(false);
  });

  it('exposes every tool by default while preserving a chosen filter', () => {
    expect(defaultPanelState().toolDrawerFilter).toBe('all');
    expect(
      normalizePanelState({ toolDrawerFilter: 'all' }).toolDrawerFilter
    ).toBe('all');
    expect(
      normalizePanelState({ toolDrawerFilter: 'some' }).toolDrawerFilter
    ).toBe('all');
  });

  it('opens the searchable catalog by default while preserving a chosen view', () => {
    expect(defaultPanelState().toolDrawerView).toBe('advanced');
    expect(
      normalizePanelState({ toolDrawerView: 'advanced' }).toolDrawerView
    ).toBe('advanced');
    expect(normalizePanelState({ toolDrawerView: 'pro' }).toolDrawerView).toBe(
      'advanced'
    );
  });

  it('opens the drawer at its head until a section is remembered', () => {
    expect(defaultPanelState().toolDrawerSection).toBeNull();
    expect(
      normalizePanelState({ toolDrawerSection: 'pattern' }).toolDrawerSection
    ).toBe('pattern');
    expect(
      normalizePanelState({ toolDrawerSection: 'Pattern' }).toolDrawerSection
    ).toBeNull();
    expect(
      normalizePanelState({ toolDrawerSection: 3 }).toolDrawerSection
    ).toBeNull();
  });

  it('opens the drawer on the search it was left with', () => {
    expect(defaultPanelState().toolDrawerQuery).toBe('');
    expect(
      normalizePanelState({ toolDrawerQuery: 'fil' }).toolDrawerQuery
    ).toBe('fil');
    expect(normalizePanelState({ toolDrawerQuery: 3 }).toolDrawerQuery).toBe(
      ''
    );
    expect(
      normalizePanelState({ toolDrawerQuery: 'x'.repeat(500) }).toolDrawerQuery
    ).toHaveLength(TOOL_DRAWER_QUERY_MAX_LENGTH);
  });

  it('returns independent pin lists', () => {
    defaultPanelState().pinnedTools.push('gear');
    expect(defaultPanelState().pinnedTools).not.toContain('gear');
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

describe('which commands fold More tools', () => {
  const none = {
    inPlace: { active: false, editing: false },
    extrude: { active: false, editing: false },
    tool: { name: null, editing: false },
    moving: false
  };

  it('folds More tools while a feature is being created', () => {
    expect(commandFoldsTools(none)).toBe(false);
    expect(
      commandFoldsTools({
        ...none,
        inPlace: { active: true, editing: false }
      })
    ).toBe(true);
    expect(
      commandFoldsTools({
        ...none,
        extrude: { active: true, editing: false }
      })
    ).toBe(true);
    expect(
      commandFoldsTools({ ...none, tool: { name: 'box', editing: false } })
    ).toBe(true);
  });

  it('leaves More tools open while an existing feature is edited', () => {
    // Existing-feature edits keep the current tool-drawer state.
    expect(
      commandFoldsTools({
        ...none,
        inPlace: { active: true, editing: true }
      })
    ).toBe(false);
    expect(
      commandFoldsTools({
        ...none,
        extrude: { active: true, editing: true }
      })
    ).toBe(false);
    expect(
      commandFoldsTools({
        ...none,
        tool: { name: 'datum-plane', editing: true }
      })
    ).toBe(false);
  });

  it('leaves More tools open for Move and a drag', () => {
    expect(
      commandFoldsTools({
        ...none,
        tool: { name: 'transform', editing: false }
      })
    ).toBe(false);
    expect(
      commandFoldsTools({
        ...none,
        inPlace: { active: true, editing: false },
        moving: true
      })
    ).toBe(false);
  });
});

describe('temporary folding of More tools', () => {
  const idle = { suspended: false, released: false };
  const suspended = { ...idle, suspended: true };

  it('shows the saved choice outside a creation session', () => {
    expect(effectiveCommandFold({ commandFoldOpen: true }, idle)).toBe(true);
    expect(effectiveCommandFold({ commandFoldOpen: false }, idle)).toBe(false);
  });

  it('folds temporarily without overwriting the saved preference', () => {
    const state = { ...defaultPanelState(), commandFoldOpen: true };
    expect(effectiveCommandFold(state, suspended)).toBe(false);
    expect(state.commandFoldOpen).toBe(true);
    savePanelState(state);
    expect(loadPanelState().commandFoldOpen).toBe(true);
  });

  it('lets an explicit request reveal the fold during the session', () => {
    expect(
      effectiveCommandFold(
        { commandFoldOpen: true },
        { ...suspended, released: true }
      )
    ).toBe(true);
  });

  it('never opens a fold the user left closed', () => {
    expect(
      effectiveCommandFold(
        { commandFoldOpen: false },
        { ...suspended, released: true }
      )
    ).toBe(false);
  });
});
