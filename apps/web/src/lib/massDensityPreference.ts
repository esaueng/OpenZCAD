import {
  normalizeMassDensitySelection,
  UNIT_MASS_DENSITY_SELECTION,
  type MassDensitySelection
} from '@openzcad/shared';

/**
 * The Inspector's density/material choice, remembered per browser and per
 * project.
 *
 * A material is a viewing preference, not model content — like panel collapse
 * (`panelState.ts`) rather than like a viewport pose (`workspaceSession.ts`)
 * — so it lives in its own storage key instead of `AppSettings`, and never
 * in the document. Persisting it in-document (shared across devices, seen
 * by collaborators) is recorded follow-up work; until then a second browser
 * simply opens at unit density.
 */

export const MASS_DENSITY_STORAGE_KEY = 'openzcad-mass-density:v1';

const STORAGE_VERSION = 1;

interface StoredMassDensity {
  version: typeof STORAGE_VERSION;
  selections: Record<string, MassDensitySelection>;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emptyStored(): StoredMassDensity {
  return { version: STORAGE_VERSION, selections: {} };
}

function readStored(storage: StorageLike | null): StoredMassDensity {
  if (!storage) {
    return emptyStored();
  }
  try {
    const raw = storage.getItem(MASS_DENSITY_STORAGE_KEY);
    if (!raw) {
      return emptyStored();
    }
    const parsed = JSON.parse(raw) as Partial<StoredMassDensity>;
    if (
      parsed.version !== STORAGE_VERSION ||
      !parsed.selections ||
      typeof parsed.selections !== 'object'
    ) {
      return emptyStored();
    }
    const selections: Record<string, MassDensitySelection> = {};
    for (const [projectId, selection] of Object.entries(parsed.selections)) {
      if (projectId) {
        selections[projectId] = normalizeMassDensitySelection(selection);
      }
    }
    return { version: STORAGE_VERSION, selections };
  } catch {
    return emptyStored();
  }
}

function writeStored(
  stored: StoredMassDensity,
  storage: StorageLike | null
): boolean {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(MASS_DENSITY_STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** The remembered density choice for a project, or unit density when none. */
export function loadMassDensitySelection(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): MassDensitySelection {
  return (
    readStored(storage).selections[projectId] ?? UNIT_MASS_DENSITY_SELECTION
  );
}

/** Remembers a density choice for a project. Unit density clears the entry. */
export function saveMassDensitySelection(
  projectId: string,
  selection: MassDensitySelection,
  storage: StorageLike | null = defaultStorage()
): boolean {
  const normalized = normalizeMassDensitySelection(selection);
  const stored = readStored(storage);
  if (normalized.kind === 'unit') {
    if (!(projectId in stored.selections)) {
      return true;
    }
    delete stored.selections[projectId];
  } else {
    stored.selections[projectId] = normalized;
  }
  return writeStored(stored, storage);
}
