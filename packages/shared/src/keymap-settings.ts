/**
 * The stored half of the workspace keymap: a user's replacement bindings, by
 * command id. Only the grammar lives here — which commands exist and what they
 * default to is the browser's registry (`apps/web/src/lib/keymap.ts`) — so the
 * Worker can keep a settings row honest without knowing the command list, and
 * a binding written by a newer client survives a save from an older one.
 *
 * A chord is written the portable way the workspace already labels shortcuts:
 * `Ctrl+Shift+Z`, where Ctrl also answers to ⌘. Modifiers come in the order
 * Ctrl, Alt, Shift; a letter key is upper case; a printable symbol carries no
 * Shift because the symbol already says it (`?`, never `Shift+/`).
 */
export type KeymapOverrides = Readonly<Record<string, readonly string[]>>;

export const KEYMAP_LIMITS = {
  /** Distinct commands with a stored override. */
  commands: 128,
  chordsPerCommand: 4
} as const;

const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift'] as const;
const NAMED_KEYS = new Set([
  'Space',
  'Escape',
  'Enter',
  'Tab',
  'Delete',
  'Backspace',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`)
]);

/**
 * The canonical spelling of a chord, or null when it is not one: an unknown
 * key name, a repeated or unknown modifier, or a bare modifier.
 */
export function canonicalChord(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32) {
    return null;
  }
  // "+" is a key as well as the separator: "Ctrl++" and a bare "+".
  let key: string;
  let modifierText: string;
  if (value === '+') {
    key = '+';
    modifierText = '';
  } else if (value.endsWith('++')) {
    key = '+';
    modifierText = value.slice(0, -2);
  } else {
    const at = value.lastIndexOf('+');
    key = value.slice(at + 1);
    modifierText = at < 0 ? '' : value.slice(0, at);
  }
  const modifiers = modifierText ? modifierText.split('+') : [];
  if (
    modifiers.some(
      (modifier) => !(MODIFIER_ORDER as readonly string[]).includes(modifier)
    ) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return null;
  }
  let base: string;
  if (NAMED_KEYS.has(key)) {
    base = key;
  } else if (Array.from(key).length === 1 && key.trim() === key) {
    // A letter is stored upper case, but only where that stays one
    // character: ß upper-cases to SS, which would not parse back.
    const upper = key.toUpperCase();
    base = Array.from(upper).length === 1 ? upper : key;
  } else {
    return null;
  }
  // A shifted symbol is its own character; only letters and named keys keep
  // Shift as a separate modifier.
  const keepsShift = /^[A-Z]$/.test(base) || NAMED_KEYS.has(base);
  const kept = MODIFIER_ORDER.filter(
    (modifier) =>
      modifiers.includes(modifier) && (modifier !== 'Shift' || keepsShift)
  );
  return [...kept, base].join('+');
}

/**
 * Stored overrides with everything unusable dropped rather than the whole map
 * rejected: one stale binding is not a reason to lose the rest. An empty list
 * is kept — it is how a user clears a command's default.
 */
export function normalizeKeymapOverrides(value: unknown): KeymapOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [id, chords] of Object.entries(value)) {
    if (Object.keys(result).length >= KEYMAP_LIMITS.commands) break;
    if (!COMMAND_ID.test(id) || !Array.isArray(chords)) continue;
    const canonical: string[] = [];
    for (const chord of chords) {
      const parsed = canonicalChord(chord);
      if (parsed && !canonical.includes(parsed)) canonical.push(parsed);
    }
    result[id] = canonical.slice(0, KEYMAP_LIMITS.chordsPerCommand);
  }
  return result;
}
