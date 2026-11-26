import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATIC_RESOLVES_TO_COMPACT,
  COMPACT_SIZE_CLASS_QUERY,
  LAYOUT_PREFERENCE_STORAGE_KEY,
  currentLayoutPreference,
  readLayoutPreference,
  resetLayoutPreferenceForTests,
  resolveWorkspaceShell,
  subscribeLayoutPreference,
  writeLayoutPreference
} from './layoutPreference';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values
  };
}

function throwingStorage() {
  const fail = () => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

afterEach(() => {
  resetLayoutPreferenceForTests();
  localStorage.removeItem(LAYOUT_PREFERENCE_STORAGE_KEY);
});

describe('layout size class and preference', () => {
  it('keeps the plan’s size-class query and storage key', () => {
    expect(COMPACT_SIZE_CLASS_QUERY).toBe(
      '(max-width: 600px), (max-height: 500px) and (orientation: landscape)'
    );
    expect(LAYOUT_PREFERENCE_STORAGE_KEY).toBe('openzcad.layout:v1');
  });

  it('resolves Automatic to the regular workspace until slice 12', () => {
    expect(AUTOMATIC_RESOLVES_TO_COMPACT).toBe(false);
    expect(resolveWorkspaceShell('automatic', true)).toBe('regular');
    expect(resolveWorkspaceShell('automatic', false)).toBe('regular');
  });

  it('follows the size class for Automatic once that flips', () => {
    expect(resolveWorkspaceShell('automatic', true, true)).toBe('compact');
    expect(resolveWorkspaceShell('automatic', false, true)).toBe('regular');
  });

  it('forces Compact and Full whatever the window size', () => {
    for (const compactClass of [true, false]) {
      expect(resolveWorkspaceShell('compact', compactClass)).toBe('compact');
      expect(resolveWorkspaceShell('full', compactClass, true)).toBe('regular');
    }
  });

  it('reads a stored choice and ignores anything else', () => {
    expect(readLayoutPreference(memoryStorage())).toBe('automatic');
    expect(
      readLayoutPreference(
        memoryStorage({ [LAYOUT_PREFERENCE_STORAGE_KEY]: 'compact' })
      )
    ).toBe('compact');
    expect(
      readLayoutPreference(
        memoryStorage({ [LAYOUT_PREFERENCE_STORAGE_KEY]: 'phone' })
      )
    ).toBe('automatic');
    expect(readLayoutPreference(null)).toBe('automatic');
  });

  it('falls back to Automatic when storage throws on read', () => {
    expect(readLayoutPreference(throwingStorage())).toBe('automatic');
  });

  it('stores a choice, and Automatic removes the key', () => {
    const storage = memoryStorage();
    expect(writeLayoutPreference('full', storage)).toBe(true);
    expect(storage.values.get(LAYOUT_PREFERENCE_STORAGE_KEY)).toBe('full');
    expect(writeLayoutPreference('automatic', storage)).toBe(true);
    expect(storage.values.has(LAYOUT_PREFERENCE_STORAGE_KEY)).toBe(false);
  });

  it('keeps a choice for the page when storage refuses the write', () => {
    const storage = throwingStorage();
    expect(writeLayoutPreference('compact', storage)).toBe(false);
    expect(currentLayoutPreference(storage)).toBe('compact');
  });

  it('tells subscribers about this page’s writes and other tabs’', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLayoutPreference(listener);
    writeLayoutPreference('compact');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LAYOUT_PREFERENCE_STORAGE_KEY)).toBe('compact');

    // Another tab chose Full: the stored value wins over this page's.
    localStorage.setItem(LAYOUT_PREFERENCE_STORAGE_KEY, 'full');
    window.dispatchEvent(
      new StorageEvent('storage', { key: LAYOUT_PREFERENCE_STORAGE_KEY })
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(currentLayoutPreference()).toBe('full');

    window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    writeLayoutPreference('automatic');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
