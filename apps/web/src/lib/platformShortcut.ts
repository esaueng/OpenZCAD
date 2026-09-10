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
