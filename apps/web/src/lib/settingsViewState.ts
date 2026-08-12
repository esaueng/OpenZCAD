import { SETTINGS_SECTIONS, type SettingsSectionId } from './settingsSections';

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
}

const DEFAULT_SETTINGS_VIEW_STATE: SettingsViewState = {
  open: false,
  activeSection: 'general',
  query: '',
  scrollTop: 0
};

const SETTINGS_SECTION_IDS = new Set<SettingsSectionId>(
  SETTINGS_SECTIONS.map((section) => section.id)
);

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
  if (
    typeof root.activeSection === 'string' &&
    SETTINGS_SECTION_IDS.has(root.activeSection as SettingsSectionId)
  ) {
    state.activeSection = root.activeSection as SettingsSectionId;
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

export function updateSettingsViewState(
  patch: Partial<SettingsViewState>
): SettingsViewState {
  const next = normalizeSettingsViewState({
    ...loadSettingsViewState(),
    ...patch
  });
  saveSettingsViewState(next);
  return next;
}

export function defaultSettingsViewState(): SettingsViewState {
  return copyDefaults();
}
