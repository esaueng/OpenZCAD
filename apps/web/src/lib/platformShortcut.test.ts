import { describe, expect, it } from 'vitest';
import {
  commandPaletteShortcut,
  platformShortcutLabel
} from './platformShortcut';

describe('commandPaletteShortcut', () => {
  it('uses Command copy on Apple platforms', () => {
    expect(commandPaletteShortcut('MacIntel')).toEqual({
      accessible: 'Cmd+K',
      glyph: '⌘K'
    });
  });

  it('uses Ctrl copy on other platforms', () => {
    expect(commandPaletteShortcut('Linux x86_64')).toEqual({
      accessible: 'Ctrl+K',
      glyph: 'Ctrl+K'
    });
  });
});

describe('platformShortcutLabel', () => {
  it('names the Command key in Apple modifier order', () => {
    expect(platformShortcutLabel('Ctrl+Shift+Z', 'MacIntel')).toBe('⇧⌘Z');
    expect(platformShortcutLabel('Ctrl+,', 'MacIntel')).toBe('⌘,');
    expect(platformShortcutLabel('Ctrl+Shift+M', 'iPad')).toBe('⇧⌘M');
  });

  it('leaves single keys and other platforms alone', () => {
    expect(platformShortcutLabel('G', 'MacIntel')).toBe('G');
    expect(platformShortcutLabel('Space', 'MacIntel')).toBe('Space');
    expect(platformShortcutLabel('Ctrl+Shift+Z', 'Win32')).toBe('Ctrl+Shift+Z');
  });

  it('passes through chords it does not recognise', () => {
    expect(platformShortcutLabel('Esc+Hold', 'MacIntel')).toBe('Esc+Hold');
  });
});
