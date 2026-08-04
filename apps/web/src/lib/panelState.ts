/**
 * Which workspace panels the user has collapsed, remembered per device.
 *
 * Chrome layout is a per-device habit rather than a document or account
 * preference, so it lives in its own storage key instead of `AppSettings` — that
 * also keeps it off the settings sync path, where every field has to survive the
 * worker's strict parser.
 */
export const PANEL_STATE_STORAGE_KEY = 'openzcad-panel-state:v1';

export type SidebarSectionId =
  | 'parameters'
  | 'bodies'
  | 'history'
  | 'revisions'
  | 'diagnostics';

export const SIDEBAR_SECTION_IDS: readonly SidebarSectionId[] = [
  'parameters',
  'bodies',
  'history',
  'revisions',
  'diagnostics'
];

export interface PanelState {
  /** Section id to open/closed. Absent means open. */
  sidebarSections: Record<SidebarSectionId, boolean>;
  toolPaletteOpen: boolean;
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
}

export const DEFAULT_PANEL_STATE: PanelState = {
  sidebarSections: {
    parameters: true,
    bodies: true,
    history: true,
    revisions: true,
    diagnostics: true
  },
  toolPaletteOpen: true,
  assistantCollapsed: true
};

function copyDefaults(): PanelState {
  return {
    sidebarSections: { ...DEFAULT_PANEL_STATE.sidebarSections },
    toolPaletteOpen: DEFAULT_PANEL_STATE.toolPaletteOpen,
    assistantCollapsed: DEFAULT_PANEL_STATE.assistantCollapsed
  };
}

export function normalizePanelState(value: unknown): PanelState {
  const state = copyDefaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return state;
  }
  const root = value as Record<string, unknown>;
  if (typeof root.toolPaletteOpen === 'boolean') {
    state.toolPaletteOpen = root.toolPaletteOpen;
  }
  if (typeof root.assistantCollapsed === 'boolean') {
    state.assistantCollapsed = root.assistantCollapsed;
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
  return state;
}

export function loadPanelState(): PanelState {
  try {
    const raw = window.localStorage.getItem(PANEL_STATE_STORAGE_KEY);
    return raw ? normalizePanelState(JSON.parse(raw) as unknown) : copyDefaults();
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

export function defaultPanelState(): PanelState {
  return copyDefaults();
}
