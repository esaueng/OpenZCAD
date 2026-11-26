import {
  LEGACY_SETTINGS_SECTION_IDS,
  SETTINGS_SECTION_IDS,
  type SettingsSectionId
} from './settingsSectionIds';

/**
 * Device-local navigation state for the Settings overlay.
 *
 * This deliberately excludes credentials and sign-in fields. Those values must
 * never enter browser storage just because the surrounding page is restored.
 */
export const SETTINGS_VIEW_STATE_STORAGE_KEY = 'openzcad-settings-view:v1';

export interface SettingsViewState {
  open: boolean;
  activeSection: SettingsSectionId;
  query: string;
  scrollTop: number;
  /**
   * A section was asked for by name (a task flow, a link, a search result,
   * a section opened from the list): compact Settings opens on that section
   * instead of its list of sections. Stored only while true.
   */
  sectionRequested?: true;
}

const DEFAULT_SETTINGS_VIEW_STATE: SettingsViewState = {
  open: false,
  activeSection: 'general',
  query: '',
  scrollTop: 0
};

const KNOWN_SECTION_IDS = new Set<string>(SETTINGS_SECTION_IDS);

function copyDefaults(): SettingsViewState {
  return { ...DEFAULT_SETTINGS_VIEW_STATE };
}

export function normalizeSettingsViewState(value: unknown): SettingsViewState {
  const state = copyDefaults();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return state;
  }
  const root = value as Record<string, unknown>;
  if (typeof root.open === 'boolean') {
    state.open = root.open;
  }
  if (typeof root.activeSection === 'string') {
    if (KNOWN_SECTION_IDS.has(root.activeSection)) {
      state.activeSection = root.activeSection as SettingsSectionId;
    } else if (Object.hasOwn(LEGACY_SETTINGS_SECTION_IDS, root.activeSection)) {
      // Own keys only: a stored "constructor" must not resolve up the
      // prototype chain to a function.
      state.activeSection =
        LEGACY_SETTINGS_SECTION_IDS[root.activeSection] ?? state.activeSection;
    }
  }
  if (typeof root.query === 'string') {
    state.query = root.query;
  }
  if (
    typeof root.scrollTop === 'number' &&
    Number.isFinite(root.scrollTop) &&
    root.scrollTop >= 0
  ) {
    state.scrollTop = root.scrollTop;
  }
  if (root.sectionRequested === true) {
    state.sectionRequested = true;
  }
  return state;
}

export function loadSettingsViewState(): SettingsViewState {
  try {
    const raw = window.localStorage.getItem(SETTINGS_VIEW_STATE_STORAGE_KEY);
    return raw
      ? normalizeSettingsViewState(JSON.parse(raw) as unknown)
      : copyDefaults();
  } catch {
    return copyDefaults();
  }
}

export function saveSettingsViewState(state: SettingsViewState): boolean {
  try {
    window.localStorage.setItem(
      SETTINGS_VIEW_STATE_STORAGE_KEY,
      JSON.stringify(normalizeSettingsViewState(state))
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges a change into the stored view. A patch that names a section asks
 * for it (an invitation, a device approval, Account storage): unless it
 * says otherwise, compact Settings opens on that section, and a search
 * left from an earlier visit is dropped so it cannot hide that section.
 * A patch that brings its own search and scroll (Settings saving where it
 * is) keeps them.
 */
export function updateSettingsViewState(
  patch: Partial<Omit<SettingsViewState, 'sectionRequested'>> & {
    sectionRequested?: boolean;
  }
): SettingsViewState {
  const current = loadSettingsViewState();
  const { sectionRequested, ...rest } = patch;
  const requested =
    rest.activeSection !== undefined && sectionRequested !== false;
  const next = normalizeSettingsViewState({
    ...current,
    ...(requested ? { query: '', scrollTop: 0 } : {}),
    ...rest,
    sectionRequested:
      sectionRequested ??
      (rest.activeSection !== undefined ? true : current.sectionRequested)
  });
  saveSettingsViewState(next);
  return next;
}

export function defaultSettingsViewState(): SettingsViewState {
  return copyDefaults();
}
