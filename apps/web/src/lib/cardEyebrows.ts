/**
 * The eyebrow vocabulary every command card shares: creating a feature,
 * editing one from history, or editing the shape directly. Cards used to say
 * "New feature", "Primitive", "Hole" or "Direct edit" for the same two
 * situations depending on which panel drew them.
 *
 * A module of its own so the entry chunk, which draws the modeling card,
 * takes these three words and not the inspector's heading logic with them.
 */
export const CARD_EYEBROWS = {
  create: 'New feature',
  edit: 'Edit feature',
  direct: 'Direct edit'
} as const;
