import { describe, expect, it } from 'vitest';
import {
  MAX_RECENT_COMMANDS,
  RECENT_COMMANDS_STORAGE_KEY,
  browseCommands,
  loadRecentCommands,
  rankedCommands,
  recordRecentCommand,
  tokenScore,
  type SearchableCommand
} from './commandSearch';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value)
  };
}

const cmd = (
  id: string,
  label: string,
  extra: Partial<SearchableCommand> = {}
): SearchableCommand => ({ id, label, group: 'Tool', ...extra });

describe('command search', () => {
  it('scores a name prefix, a word start or initials, a substring, then a group', () => {
    const pattern = cmd('lp', 'Linear pattern');
    expect(tokenScore(pattern, 'lin')).toBe(4);
    expect(tokenScore(pattern, 'pat')).toBe(3);
    expect(tokenScore(pattern, 'lp')).toBe(3);
    expect(tokenScore(pattern, 'ear')).toBe(2);
    expect(tokenScore(pattern, 'to')).toBe(1);
    expect(tokenScore(pattern, 'x')).toBe(0);
    // One letter is never read as initials, nor a one-word name.
    expect(tokenScore(cmd('l', 'Linear pattern'), 'l')).toBe(4);
    expect(tokenScore(cmd('b', 'Box'), 'bo')).toBe(4);
    expect(tokenScore(cmd('b', 'Box'), 'bx')).toBe(0);
  });

  it('breaks score ties by the pick, then recency, then source order', () => {
    const commands = [
      cmd('a', 'Alpha one', { offPick: true }),
      cmd('b', 'Alpha two'),
      cmd('c', 'Alpha three')
    ];
    expect(rankedCommands(commands, 'alpha').map((c) => c.id)).toEqual([
      'b',
      'c',
      'a'
    ]);
    expect(rankedCommands(commands, 'alpha', ['c']).map((c) => c.id)).toEqual([
      'c',
      'b',
      'a'
    ]);
    // Score still wins over recency.
    expect(
      rankedCommands(commands, 'alpha tw', ['c']).map((c) => c.id)
    ).toEqual(['b']);
  });

  it('browses recent, then the commands that can run on the pick', () => {
    const commands = [
      cmd('box', 'Box', { offPick: true }),
      cmd('fillet', 'Fillet'),
      cmd('extrude', 'Extrude', { disabledReason: 'Select a region first' }),
      cmd('front', 'Front view')
    ];
    expect(
      browseCommands(commands, ['front', 'box', 'gone']).map((entry) => [
        entry.command.id,
        entry.recent
      ])
    ).toEqual([
      ['front', true],
      ['fillet', false]
    ]);
  });

  it('keeps the newest few recent ids on the device, without repeats', () => {
    const storage = memoryStorage();
    for (const id of ['a', 'b', 'c', 'a', 'd', 'e', 'f']) {
      recordRecentCommand(id, storage);
    }
    expect(loadRecentCommands(storage)).toEqual(['f', 'e', 'd', 'a', 'c']);
    expect(loadRecentCommands(storage)).toHaveLength(MAX_RECENT_COMMANDS);
  });

  it('reads damaged storage as no recent commands', () => {
    expect(
      loadRecentCommands(
        memoryStorage({ [RECENT_COMMANDS_STORAGE_KEY]: '{not json' })
      )
    ).toEqual([]);
    expect(
      loadRecentCommands(
        memoryStorage({ [RECENT_COMMANDS_STORAGE_KEY]: '[1,"box",""]' })
      )
    ).toEqual(['box']);
    expect(loadRecentCommands(null)).toEqual([]);
  });
});
