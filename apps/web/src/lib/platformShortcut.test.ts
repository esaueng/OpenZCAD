import { describe, expect, it } from 'vitest';
import {
  commandPaletteShortcut,
  idleWorkspaceHint,
  platformShortcutLabel
} from './platformShortcut';

describe('idleWorkspaceHint', () => {
  it('names the key the command box shows', () => {
    expect(idleWorkspaceHint('MacIntel')).toBe('⌘K commands · ? shortcuts');
    expect(idleWorkspaceHint('Win32')).toBe('Ctrl+K commands · ? shortcuts');
  });

  it('names the keys the user remapped, and leaves out an unbound one', () => {
    expect(idleWorkspaceHint('MacIntel', 'Ctrl+Shift+P', 'H')).toBe(
      '⇧⌘P commands · H shortcuts'
    );
    expect(idleWorkspaceHint('Win32', null, '?')).toBe('? shortcuts');
  });
});

describe('commandPaletteShortcut', () => {
  it('uses Command copy on Apple platforms', () => {
    expect(commandPaletteShortcut('MacIntel')).toEqual({
      accessible: 'Cmd+K',
      glyph: '⌘K'
    });
  });

  it('follows a remap, and is absent when unbound', () => {
    expect(commandPaletteShortcut('MacIntel', 'Ctrl+Shift+P')).toEqual({
      accessible: 'Cmd+Shift+P',
      glyph: '⇧⌘P'
    });
    expect(commandPaletteShortcut('Win32', null)).toBeNull();
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
