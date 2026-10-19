export interface PlatformShortcutCopy {
  accessible: string;
  glyph: string;
}

/**
 * Platform-correct copy for the command-palette shortcut, whichever chord the
 * user's keymap gives it; null when they left it unbound (pass null, not
 * undefined, which reads as the default).
 */
export function commandPaletteShortcut(
  platform = globalThis.navigator?.platform ?? '',
  chord: string | null = 'Ctrl+K'
): PlatformShortcutCopy | null {
  if (!chord) return null;
  return {
    accessible: /Mac|iPhone|iPad|iPod/i.test(platform)
      ? chord.replace(/^Ctrl\+/, 'Cmd+')
      : chord,
    glyph: platformShortcutLabel(chord, platform)
  };
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
  // A trailing empty part means the key itself is "+" ("Ctrl++" splits to
  // Ctrl, '', ''): the last two parts are the key, not a modifier.
  const plusKey = parts.length > 1 && parts.at(-1) === '';
  const key = plusKey ? '+' : parts.at(-1)!;
  const modifiers = new Set(parts.slice(0, plusKey ? -2 : -1));
  if (![...modifiers].every((part) => part in MAC_MODIFIER_GLYPHS)) {
    return shortcut;
  }
  const glyphs = MAC_MODIFIER_ORDER.filter((modifier) =>
    modifiers.has(modifier)
  ).map((modifier) => MAC_MODIFIER_GLYPHS[modifier]);
  return [...new Set(glyphs)].join('') + key;
}

/**
 * The lane's line when nothing is selected or armed. It named "Ctrl+K" on a
 * Mac while the command box beside it showed ⌘K. The keys are the live
 * keymap's; a half the user unbound is left out rather than named wrongly.
 */
export function idleWorkspaceHint(
  platform = globalThis.navigator?.platform ?? '',
  palette: string | null = 'Ctrl+K',
  reference: string | null = '?'
): string {
  return [
    palette && `${platformShortcutLabel(palette, platform)} commands`,
    reference && `${platformShortcutLabel(reference, platform)} shortcuts`
  ]
    .filter(Boolean)
    .join(' · ');
}
