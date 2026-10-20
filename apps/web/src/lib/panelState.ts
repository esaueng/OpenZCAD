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
  /**
   * The v1 drawer's folded sections. Nothing reads it for the UI since the
   * model panels became independent (`panelLayout.ts`, U08): it is kept, and
   * written back as loaded, so rolling back restores the old drawer, and the
   * first load of the panel layout migrates from it.
   */
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
   * The v1 model drawer. Like `sidebarSections`, kept for rollback and for
   * the panel layout's first-load migration, and never read for the UI.
   */
  drawerOpen: boolean;
  /**
   * The command card's "More tools" fold: every tool the selection did not
   * give a named row. Closed to begin with, so the card is the pick and its
   * verbs and nothing else; someone who works from the grid opens it once
   * and keeps it.
   */
  commandFoldOpen: boolean;
  /**
   * The sketch palette flyout (overview, snapping, grid, constraints)
   * beside the sketch rail. Closed to begin with, and remembered across
   * sketch sessions: leaving a sketch and editing it again should not fold
   * the settings someone was working from.
   */
  sketchPaletteOpen: boolean;
  /**
   * Tweak's parameter table, the flyout beside its rail. Open to begin
   * with — the knobs are what Tweak is for — and remembered per device.
   */
  tweakPanelOpen: boolean;
}

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
  commandFoldOpen: false,
  sketchPaletteOpen: false,
  tweakPanelOpen: true
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
    commandFoldOpen: DEFAULT_PANEL_STATE.commandFoldOpen,
    sketchPaletteOpen: DEFAULT_PANEL_STATE.sketchPaletteOpen,
    tweakPanelOpen: DEFAULT_PANEL_STATE.tweakPanelOpen
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
  if (typeof root.sketchPaletteOpen === 'boolean') {
    state.sketchPaletteOpen = root.sketchPaletteOpen;
  }
  if (typeof root.tweakPanelOpen === 'boolean') {
    state.tweakPanelOpen = root.tweakPanelOpen;
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

export function toggleToolGroup(state: PanelState, id: ToolGroup): PanelState {
  return {
    ...state,
    toolGroups: { ...state.toolGroups, [id]: !state.toolGroups[id] }
  };
}

export function defaultPanelState(): PanelState {
  return copyDefaults();
}

/**
 * A mode that wants the stage to itself — a sketch, or a direct-manipulation
 * drag — suspends every open model panel (docked, unpinned or in the phone
 * lane) and the command card's "More tools" fold, and gives them back when
 * it ends. Suspension is not a preference: the stored panel layout and
 * `commandFoldOpen` keep what the user chose. A rail press, or a search that
 * asks for a panel, while suspended releases the panels for the rest of that
 * mode, and toggling the fold releases the fold: their intent wins.
 */
export interface PanelSuspension {
  suspended: boolean;
  panelsReleased: boolean;
  foldReleased: boolean;
}

export type SuspendablePanel = 'panels' | 'fold';

/** What shows, given what the user chose and the mode. */
export function effectivePanels(
  state: Pick<PanelState, 'commandFoldOpen'>,
  suspension: PanelSuspension
): { panelsSuspended: boolean; commandFoldOpen: boolean } {
  return {
    panelsSuspended: suspension.suspended && !suspension.panelsReleased,
    commandFoldOpen:
      state.commandFoldOpen &&
      (!suspension.suspended || suspension.foldReleased)
  };
}

/**
 * Whether a drag still holds the stage. It takes it when a gesture engages
 * and keeps it while the pointer stays down — a value the kernel refuses
 * mid-gesture is not the end of the drag — and while that gesture's release
 * is validated, so the panels do not flash back between letting go and
 * the result landing. A commit, a cancel, a refusal at release or a cleared
 * selection ends it. Validation no drag started (a typed value, the Extrude
 * form's Create) never takes it.
 */
export function nextDragSuspension(
  held: boolean,
  phase: string | null,
  pointerDown = false
): boolean {
  if (pointerDown || phase === 'dragging') {
    return true;
  }
  return held && phase === 'validating';
}
