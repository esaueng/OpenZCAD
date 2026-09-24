/**
 * Which workspace panels the user has collapsed, remembered per device.
 *
 * Chrome layout is a per-device habit rather than a document or account
 * preference, so it lives in its own storage key instead of `AppSettings` — that
 * also keeps it off the settings sync path, where every field has to survive the
 * worker's strict parser.
 */
import type { ToolGroup } from './tools';

export const PANEL_STATE_STORAGE_KEY = 'openzcad-panel-state:v1';

export type SidebarSectionId =
  'parameters' | 'bodies' | 'history' | 'revisions' | 'diagnostics';

export const SIDEBAR_SECTION_IDS: readonly SidebarSectionId[] = [
  'parameters',
  'bodies',
  'history',
  'revisions',
  'diagnostics'
];

/**
 * Which workspace the top bar is showing.
 *
 * `build` is the modeling workspace — every panel, tool and gizmo. `view` is
 * the reading workspace: the viewport, the orientation cube and a small bar of
 * view controls, with the document locked against edits. `tweak` sits between
 * them: the reading workspace plus the parameter table, so the model's driving
 * dimensions can be adjusted and the result exported while the design itself —
 * sketches, features, history — stays locked.
 *
 * Named `workspaceMode` rather than "viewer" because that word already means
 * both the 3D viewport (`ViewerShell`) and the collaboration role in this
 * codebase, and a third meaning would make either impossible to grep for.
 */
export type WorkspaceMode = 'view' | 'tweak' | 'build';

export interface PanelState {
  /** Section id to open/closed. Absent means open. */
  sidebarSections: Record<SidebarSectionId, boolean>;
  /**
   * Remembered per device for the same reason panel collapse is: someone who
   * opens the app to read drawings should not have to strip the modeling UI
   * again on every reload. Build to begin with — the mode has to be chosen.
   */
  workspaceMode: WorkspaceMode;
  /**
   * View mode's parts rail. Open to begin with — a model worth viewing usually
   * has more than one body — and collapsible to nothing for someone who just
   * wants the model on screen.
   */
  viewModeRailOpen: boolean;
  /**
   * The assistant dock, collapsed to its launcher. Remembered because it is a
   * working habit — someone who models without it should not have to close it
   * again on every reload — and because collapsing gives its column back to the
   * viewport, which is a layout decision worth restoring.
   *
   * Collapsed to begin with: a new workspace opens on the model, not on a
   * conversation nobody has started yet.
   */
  assistantCollapsed: boolean;
  /**
   * The first-model guided tour has been finished or skipped on this device.
   * Per-device like every other chrome habit here: a tour someone dismissed
   * must never come back, and one they have not seen yet should still appear
   * on their next fresh project.
   */
  workspaceTourDismissed: boolean;
  /**
   * Which feature-tool groups are unfolded to named tiles; a folded group
   * shows its tools as one row of icons. Open to begin with — the names are
   * what make the tools learnable — and remembered because folding is how
   * someone gives the model browser more of the column.
   */
  toolGroups: Record<ToolGroup, boolean>;
  /**
   * The model drawer on the right (parameters, bodies, history, revisions,
   * diagnostics). Closed to begin with: the quiet stage opens on the model,
   * and the instrument rail's Items, History and Parameters buttons open it
   * on the section they name. Remembered like every other chrome habit.
   */
  drawerOpen: boolean;
  /**
   * The command card's "More tools" fold: every tool the selection did not
   * give a named row. Closed to begin with, so the card is the pick and its
   * verbs and nothing else; someone who works from the grid opens it once
   * and keeps it.
   */
  commandFoldOpen: boolean;
}

/** The drawer sections the instrument rail can open directly. */
export type DrawerSectionId = 'parameters' | 'bodies' | 'history';

export const DEFAULT_PANEL_STATE: PanelState = {
  sidebarSections: {
    parameters: true,
    bodies: true,
    history: true,
    revisions: true,
    diagnostics: true
  },
  workspaceMode: 'build',
  viewModeRailOpen: true,
  assistantCollapsed: true,
  workspaceTourDismissed: false,
  toolGroups: {
    create: true,
    'from-sketch': true,
    'edges-faces': true,
    bodies: true,
    pattern: true
  },
  drawerOpen: false,
  commandFoldOpen: false
};

export const TOOL_GROUP_KEYS = Object.keys(
  DEFAULT_PANEL_STATE.toolGroups
) as readonly ToolGroup[];

function copyDefaults(): PanelState {
  return {
    sidebarSections: { ...DEFAULT_PANEL_STATE.sidebarSections },
    workspaceMode: DEFAULT_PANEL_STATE.workspaceMode,
    viewModeRailOpen: DEFAULT_PANEL_STATE.viewModeRailOpen,
    assistantCollapsed: DEFAULT_PANEL_STATE.assistantCollapsed,
    workspaceTourDismissed: DEFAULT_PANEL_STATE.workspaceTourDismissed,
    toolGroups: { ...DEFAULT_PANEL_STATE.toolGroups },
    drawerOpen: DEFAULT_PANEL_STATE.drawerOpen,
    commandFoldOpen: DEFAULT_PANEL_STATE.commandFoldOpen
  };
}

export function normalizePanelState(value: unknown): PanelState {
  const state = copyDefaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return state;
  }
  const root = value as Record<string, unknown>;
  if (typeof root.assistantCollapsed === 'boolean') {
    state.assistantCollapsed = root.assistantCollapsed;
  }
  if (typeof root.workspaceTourDismissed === 'boolean') {
    state.workspaceTourDismissed = root.workspaceTourDismissed;
  }
  if (
    root.workspaceMode === 'view' ||
    root.workspaceMode === 'tweak' ||
    root.workspaceMode === 'build'
  ) {
    state.workspaceMode = root.workspaceMode;
  }
  if (typeof root.viewModeRailOpen === 'boolean') {
    state.viewModeRailOpen = root.viewModeRailOpen;
  }
  if (typeof root.drawerOpen === 'boolean') {
    state.drawerOpen = root.drawerOpen;
  }
  if (typeof root.commandFoldOpen === 'boolean') {
    state.commandFoldOpen = root.commandFoldOpen;
  }
  const sections = root.sidebarSections;
  if (sections && typeof sections === 'object' && !Array.isArray(sections)) {
    for (const id of SIDEBAR_SECTION_IDS) {
      const open = (sections as Record<string, unknown>)[id];
      if (typeof open === 'boolean') {
        state.sidebarSections[id] = open;
      }
    }
  }
  const groups = root.toolGroups;
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const id of TOOL_GROUP_KEYS) {
      const open = (groups as Record<string, unknown>)[id];
      if (typeof open === 'boolean') {
        state.toolGroups[id] = open;
      }
    }
  }
  return state;
}

export function loadPanelState(): PanelState {
  try {
    const raw = window.localStorage.getItem(PANEL_STATE_STORAGE_KEY);
    return raw
      ? normalizePanelState(JSON.parse(raw) as unknown)
      : copyDefaults();
  } catch {
    return copyDefaults();
  }
}

export function savePanelState(state: PanelState): boolean {
  try {
    window.localStorage.setItem(
      PANEL_STATE_STORAGE_KEY,
      JSON.stringify(normalizePanelState(state))
    );
    return true;
  } catch {
    return false;
  }
}

export function toggleSidebarSection(
  state: PanelState,
  id: SidebarSectionId
): PanelState {
  return {
    ...state,
    sidebarSections: {
      ...state.sidebarSections,
      [id]: !state.sidebarSections[id]
    }
  };
}

/**
 * What a rail button does: open the drawer on its section, or close the
 * drawer when that section is already showing in it. Opening folds the other
 * two primary sections so the named one gets the drawer's height, the way
 * opening History always folded the tree above it; Revisions and Diagnostics
 * keep whatever the user left them at.
 */
export function toggleDrawerSection(
  state: PanelState,
  id: DrawerSectionId
): PanelState {
  if (state.drawerOpen && state.sidebarSections[id]) {
    return { ...state, drawerOpen: false };
  }
  return {
    ...state,
    drawerOpen: true,
    sidebarSections: {
      ...state.sidebarSections,
      parameters: id === 'parameters',
      bodies: id === 'bodies',
      history: id === 'history'
    }
  };
}

export function toggleToolGroup(state: PanelState, id: ToolGroup): PanelState {
  return {
    ...state,
    toolGroups: { ...state.toolGroups, [id]: !state.toolGroups[id] }
  };
}

export function defaultPanelState(): PanelState {
  return copyDefaults();
}
