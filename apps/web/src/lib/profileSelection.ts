import type { RegionPickData } from '@openzcad/viewport';

export interface ProfileSelectionModifiers {
  /** Shift: add without removing anything already selected. */
  additive: boolean;
  /** Ctrl/Cmd: toggle this profile in the compatible selection set. */
  toggle: boolean;
}

/**
 * Applies CAD profile-selection modifiers without mixing cells from different
 * sketches into one feature draft.
 */
export function updateProfileSelection(
  current: readonly RegionPickData[],
  picked: RegionPickData,
  modifiers: ProfileSelectionModifiers
): RegionPickData[] {
  const compatible = current.filter(
    (profile) => profile.sketchId === picked.sketchId
  );
  const alreadySelected = compatible.some(
    (profile) => profile.profileId === picked.profileId
  );
  if (modifiers.toggle) {
    return alreadySelected
      ? compatible.filter((profile) => profile.profileId !== picked.profileId)
      : [...compatible, picked];
  }
  if (modifiers.additive) {
    return alreadySelected ? compatible : [...compatible, picked];
  }
  return [picked];
}
