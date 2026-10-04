import type { RegionPickData } from '@openzcad/viewport';

export interface ProfileSelectionModifiers {
  /** Shift: toggle this profile in the compatible selection set. */
  additive: boolean;
  /** Ctrl/Cmd: the same toggle, kept for hands used to it. */
  toggle: boolean;
}

/**
 * Applies CAD profile-selection modifiers without mixing cells from different
 * sketches into one feature draft.
 *
 * Shift and Ctrl/Cmd both toggle: a pick that is already selected comes back
 * out, anything else is added — the rule faces and edges follow, and the one
 * the interaction machine applies to its region targets. `group` is every
 * profile the pick stands for (a text glyph stands for its whole word, which
 * is built as one); a group comes out only when all of it is selected.
 */
export function updateProfileSelection(
  current: readonly RegionPickData[],
  picked: RegionPickData,
  modifiers: ProfileSelectionModifiers,
  group: readonly RegionPickData[] = [picked]
): RegionPickData[] {
  const members = group.some((member) => member.profileId === picked.profileId)
    ? group.filter((member) => member.sketchId === picked.sketchId)
    : [
        ...group.filter((member) => member.sketchId === picked.sketchId),
        picked
      ];
  if (!modifiers.additive && !modifiers.toggle) {
    return [...members];
  }
  const compatible = current.filter(
    (profile) => profile.sketchId === picked.sketchId
  );
  const selected = (candidate: RegionPickData) =>
    compatible.some((profile) => profile.profileId === candidate.profileId);
  if (compatible.length > 0 && members.every(selected)) {
    return compatible.filter(
      (profile) =>
        !members.some((member) => member.profileId === profile.profileId)
    );
  }
  return [...compatible, ...members.filter((member) => !selected(member))];
}
