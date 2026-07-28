import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type UnitSystem
} from '@openzcad/shared';

export const APP_SETTINGS_STORAGE_KEY = 'openzcad-app-settings:v1';

const UNITS: UnitSystem[] = ['mm', 'cm', 'm', 'inch'];
const THEMES: AppSettings['appearance']['theme'][] = ['system', 'dark'];
const DENSITIES: AppSettings['appearance']['density'][] = [
  'compact',
  'comfortable'
];
const PROJECTIONS: AppSettings['viewport']['defaultProjection'][] = [
  'perspective',
  'orthographic'
];
const DISPLAY_MODES: AppSettings['viewport']['displayMode'][] = [
  'shaded-edges',
  'shaded',
  'wireframe'
];
const PROVIDERS: AppSettings['assistant']['provider'][] = [
  'openrouter',
  'openai',
  'responses-compatible'
];
const CREDENTIAL_SOURCES: AppSettings['assistant']['credentialSource'][] = [
  'deployment',
  'personal'
];
const REASONING_EFFORTS: AppSettings['assistant']['reasoningEffort'][] = [
  'provider-default',
  'off',
  'low',
  'medium',
  'high',
  'xhigh'
];

function copyDefaults(): AppSettings {
  return structuredClone(DEFAULT_APP_SETTINGS);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function member<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return typeof value === 'string' && allowed.includes(value as T)
    ? (value as T)
    : fallback;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const defaults = copyDefaults();
  const root = record(value);
  const general = record(root.general);
  const appearance = record(root.appearance);
  const viewport = record(root.viewport);
  const sketching = record(root.sketching);
  const assistant = record(root.assistant);
  const experiments = record(root.experiments);
  return {
    schemaVersion: 1,
    general: {
      reopenLastProject: boolean(
        general.reopenLastProject,
        defaults.general.reopenLastProject
      ),
      defaultUnits: member(
        general.defaultUnits,
        UNITS,
        defaults.general.defaultUnits
      ),
      confirmDestructiveActions: boolean(
        general.confirmDestructiveActions,
        defaults.general.confirmDestructiveActions
      )
    },
    appearance: {
      theme: member(appearance.theme, THEMES, defaults.appearance.theme),
      density: member(
        appearance.density,
        DENSITIES,
        defaults.appearance.density
      ),
      reducedMotion: boolean(
        appearance.reducedMotion,
        defaults.appearance.reducedMotion
      )
    },
    viewport: {
      defaultProjection: member(
        viewport.defaultProjection,
        PROJECTIONS,
        defaults.viewport.defaultProjection
      ),
      showGrid: boolean(viewport.showGrid, defaults.viewport.showGrid),
      displayMode: member(
        viewport.displayMode,
        DISPLAY_MODES,
        defaults.viewport.displayMode
      )
    },
    sketching: {
      snapEnabled: boolean(
        sketching.snapEnabled,
        defaults.sketching.snapEnabled
      ),
      linearSnap: boundedNumber(
        sketching.linearSnap,
        defaults.sketching.linearSnap,
        0.001,
        10_000
      ),
      angleSnap: boundedNumber(
        sketching.angleSnap,
        defaults.sketching.angleSnap,
        1,
        90
      )
    },
    assistant: {
      enabled: boolean(assistant.enabled, defaults.assistant.enabled),
      credentialSource: member(
        assistant.credentialSource,
        CREDENTIAL_SOURCES,
        defaults.assistant.credentialSource
      ),
      provider: member(
        assistant.provider,
        PROVIDERS,
        defaults.assistant.provider
      ),
      baseUrl:
        typeof assistant.baseUrl === 'string'
          ? assistant.baseUrl.slice(0, 2_048)
          : defaults.assistant.baseUrl,
      model:
        typeof assistant.model === 'string' && assistant.model.trim()
          ? assistant.model.trim().slice(0, 200)
          : defaults.assistant.model,
      reasoningEffort: member(
        assistant.reasoningEffort,
        REASONING_EFFORTS,
        defaults.assistant.reasoningEffort
      ),
      maxOutputTokens: Math.round(
        boundedNumber(
          assistant.maxOutputTokens,
          defaults.assistant.maxOutputTokens,
          1_024,
          128_000
        )
      ),
      timeoutMs: Math.round(
        boundedNumber(
          assistant.timeoutMs,
          defaults.assistant.timeoutMs,
          5_000,
          300_000
        )
      ),
      customInstructions:
        typeof assistant.customInstructions === 'string'
          ? assistant.customInstructions.slice(0, 4_000)
          : defaults.assistant.customInstructions
    },
    experiments: {
      directManipulation: boolean(
        experiments.directManipulation,
        defaults.experiments.directManipulation
      )
    }
  };
}

/**
 * What is on this device: the settings themselves plus the account revision they
 * were last in step with. `syncedRevision: null` means "edited here and not yet
 * saved to the account" — the dirty flag that stops a boot-time account fetch
 * from silently reverting the change.
 */
export interface LocalAppSettingsRecord {
  settings: AppSettings;
  syncedRevision: number | null;
}

function readStoredRecord(): LocalAppSettingsRecord | null {
  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  const root = record(parsed);
  // Settings written before this field existed are bare AppSettings objects.
  // Treating them as clean keeps the previous behaviour for anyone upgrading:
  // the account copy wins, which is what already happened to them.
  const nested = root.settings === undefined ? parsed : root.settings;
  const syncedRevision =
    typeof root.syncedRevision === 'number' &&
    Number.isInteger(root.syncedRevision) &&
    root.syncedRevision >= 0
      ? root.syncedRevision
      : root.settings === undefined
        ? 0
        : null;
  return { settings: normalizeAppSettings(nested), syncedRevision };
}

export function loadLocalAppSettingsRecord(): LocalAppSettingsRecord | null {
  try {
    return readStoredRecord();
  } catch {
    return null;
  }
}

export function loadLocalAppSettings(): AppSettings {
  return loadLocalAppSettingsRecord()?.settings ?? copyDefaults();
}

export function saveLocalAppSettings(
  settings: AppSettings,
  syncedRevision: number | null = null
): boolean {
  try {
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        settings: normalizeAppSettings(settings),
        syncedRevision
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a boot-time account fetch may replace what is on this device.
 *
 * The account copy is authoritative — it can be newer, from another device —
 * but only when this device has nothing unsaved. Adopting it unconditionally
 * means any setting changed and not explicitly saved reverts on the next
 * reload, which for the assistant kill switch reads as the switch not working.
 */
export function shouldAdoptAccountSettings(
  stored: LocalAppSettingsRecord | null
): boolean {
  return stored === null || stored.syncedRevision !== null;
}

export function defaultAppSettings(): AppSettings {
  return copyDefaults();
}
