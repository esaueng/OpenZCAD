import { describe, expect, it } from 'vitest';
import {
  canonicalChord,
  KEYMAP_LIMITS,
  normalizeKeymapOverrides
} from './keymap-settings';

describe('canonicalChord', () => {
  it('spells a chord one way', () => {
    expect(canonicalChord('b')).toBe('B');
    expect(canonicalChord('Shift+Ctrl+z')).toBe('Ctrl+Shift+Z');
    expect(canonicalChord('Alt+Ctrl+Shift+F5')).toBe('Ctrl+Alt+Shift+F5');
    expect(canonicalChord('Space')).toBe('Space');
    expect(canonicalChord('Ctrl+,')).toBe('Ctrl+,');
  });

  it('drops Shift from a symbol, which already carries it', () => {
    expect(canonicalChord('Shift+?')).toBe('?');
    expect(canonicalChord('Ctrl+Shift+1')).toBe('Ctrl+1');
    expect(canonicalChord('Shift+Space')).toBe('Shift+Space');
  });

  it('keeps a key whose upper case would not be one character', () => {
    // ß upper-cases to SS; storing that would drop the binding on reload.
    expect(canonicalChord('ß')).toBe('ß');
    expect(canonicalChord('Ctrl+ß')).toBe('Ctrl+ß');
    expect(canonicalChord('é')).toBe('É');
  });

  it('is stable: a canonical chord parses back to itself', () => {
    for (const value of ['b', 'ß', 'Shift+Ctrl+z', 'Shift+?', 'Ctrl++', 'é']) {
      const once = canonicalChord(value);
      expect(canonicalChord(once), value).toBe(once);
    }
  });

  it('reads the plus key as a key', () => {
    expect(canonicalChord('+')).toBe('+');
    expect(canonicalChord('Ctrl++')).toBe('Ctrl++');
  });

  it('refuses what is not a chord', () => {
    for (const value of [
      '',
      'Ctrl',
      'Ctrl+',
      'Meta+K',
      'Ctrl+Ctrl+K',
      'Banana',
      'Ctrl+Shift+Banana',
      ' ',
      42,
      null,
      'x'.repeat(40)
    ]) {
      expect(canonicalChord(value), String(value)).toBeNull();
    }
  });
});

describe('normalizeKeymapOverrides', () => {
  it('keeps unknown but well-formed command ids for newer clients', () => {
    expect(normalizeKeymapOverrides({ 'tool-future': ['J'] })).toEqual({
      'tool-future': ['J']
    });
  });

  it('caps commands and chords per command', () => {
    const many = Object.fromEntries(
      Array.from({ length: KEYMAP_LIMITS.commands + 5 }, (_, index) => [
        `command-${index}`,
        ['A', 'B', 'C', 'D', 'E', 'F']
      ])
    );
    const normalized = normalizeKeymapOverrides(many);
    expect(Object.keys(normalized)).toHaveLength(KEYMAP_LIMITS.commands);
    expect(normalized['command-0']).toHaveLength(
      KEYMAP_LIMITS.chordsPerCommand
    );
  });

  it('reads anything but an object as no overrides', () => {
    expect(normalizeKeymapOverrides(null)).toEqual({});
    expect(normalizeKeymapOverrides(['G'])).toEqual({});
    expect(normalizeKeymapOverrides('G')).toEqual({});
  });
});
