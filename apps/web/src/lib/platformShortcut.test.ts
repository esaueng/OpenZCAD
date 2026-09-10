import { describe, expect, it } from 'vitest';
import { commandPaletteShortcut } from './platformShortcut';

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
