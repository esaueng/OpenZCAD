export interface PlatformShortcutCopy {
  accessible: string;
  glyph: string;
}

/** Platform-correct copy for the command-palette shortcut. */
export function commandPaletteShortcut(
  platform = globalThis.navigator?.platform ?? ''
): PlatformShortcutCopy {
  return /Mac|iPhone|iPad|iPod/i.test(platform)
    ? { accessible: 'Cmd+K', glyph: '⌘K' }
    : { accessible: 'Ctrl+K', glyph: 'Ctrl+K' };
}

// Apple's order is ⌃⌥⇧⌘; Ctrl is written for ⌘ here, so it sorts last.
const MAC_MODIFIER_ORDER = ['Alt', 'Shift', 'Ctrl', 'Cmd'] as const;
const MAC_MODIFIER_GLYPHS: Record<(typeof MAC_MODIFIER_ORDER)[number], string> =
  { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };

/**
 * A shortcut written the portable way ("Ctrl+Shift+Z") as the platform shows
 * it. Every Ctrl chord in the workspace also answers to ⌘ (the handlers test
 * `ctrlKey || metaKey`), so on Apple platforms the label names ⌘ in the
 * system's modifier order — "⇧⌘Z" — rather than a key the user never presses.
 */
export function platformShortcutLabel(
  shortcut: string,
  platform = globalThis.navigator?.platform ?? ''
): string {
  if (!/Mac|iPhone|iPad|iPod/i.test(platform)) {
    return shortcut;
  }
  const parts = shortcut.split('+');
  // "Ctrl++" style chords never occur; a trailing empty part means the key
  // itself was "+", so keep it rather than dropping it.
  const key = parts.length > 1 && parts.at(-1) === '' ? '+' : parts.at(-1)!;
  const modifiers = new Set(parts.slice(0, -1));
  if (![...modifiers].every((part) => part in MAC_MODIFIER_GLYPHS)) {
    return shortcut;
  }
  const glyphs = MAC_MODIFIER_ORDER.filter((modifier) =>
    modifiers.has(modifier)
  ).map((modifier) => MAC_MODIFIER_GLYPHS[modifier]);
  return [...new Set(glyphs)].join('') + key;
}
