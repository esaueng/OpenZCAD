/**
 * The status line after a command lands. Command labels are imperative
 * because they name what Undo will undo ("Undo Add box"); shown alone as the
 * outcome they read as a menu item — "Add box", "Drill hole", "Transform
 * body" — next to sentences like "Created Cozy Gecko." This turns the label
 * into the sentence the user would expect, leaving the label itself alone.
 */

const PAST_TENSE: Record<string, string> = {
  add: 'Added',
  chamfer: 'Chamfered',
  delete: 'Deleted',
  draft: 'Drafted',
  drill: 'Drilled',
  edit: 'Edited',
  extrude: 'Extruded',
  fillet: 'Filleted',
  import: 'Imported',
  loft: 'Lofted',
  mirror: 'Mirrored',
  move: 'Moved',
  offset: 'Offset',
  remove: 'Removed',
  rename: 'Renamed',
  revolve: 'Revolved',
  scale: 'Scaled',
  shell: 'Shelled',
  split: 'Split',
  sweep: 'Swept',
  thicken: 'Thickened',
  transform: 'Moved',
  update: 'Updated'
};

export function commandOutcomeMessage(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0) return trimmed;
  if (/[.!?]$/.test(trimmed)) return trimmed;
  const [verb, ...rest] = trimmed.split(/\s+/);
  const past = PAST_TENSE[verb!.toLowerCase()];
  if (past && rest.length > 0) {
    return `${past} ${rest.join(' ')}.`;
  }
  if (past) {
    return `${past}.`;
  }
  // "Union", "Linear pattern": a feature named by what it is, not a verb.
  return `${trimmed} added.`;
}
