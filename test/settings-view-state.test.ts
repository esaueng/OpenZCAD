import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SETTINGS_VIEW_STATE_STORAGE_KEY,
  defaultSettingsViewState,
  loadSettingsViewState,
  normalizeSettingsViewState,
  saveSettingsViewState,
  updateSettingsViewState
} from '../apps/web/src/lib/settingsViewState';

function installLocalStorage(): void {
  const entries = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear()
    }
  };
}

beforeEach(installLocalStorage);
afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe('settings view state', () => {
  it('round-trips the reload-visible state', () => {
    expect(
      saveSettingsViewState({
        open: true,
        activeSection: 'appearance',
        query: 'density',
        scrollTop: 184
      })
    ).toBe(true);
    expect(loadSettingsViewState()).toEqual({
      open: true,
      activeSection: 'appearance',
      query: 'density',
      scrollTop: 184
    });
  });

  it('updates one field without losing the rest of the view', () => {
    saveSettingsViewState({
      open: true,
      activeSection: 'shortcuts',
      query: 'mouse',
      scrollTop: 420
    });
    expect(updateSettingsViewState({ open: false })).toEqual({
      open: false,
      activeSection: 'shortcuts',
      query: 'mouse',
      scrollTop: 420
    });
  });

  it('fails open to a safe non-sensitive default', () => {
    window.localStorage.setItem(SETTINGS_VIEW_STATE_STORAGE_KEY, 'not json');
    expect(loadSettingsViewState()).toEqual(defaultSettingsViewState());
    expect(
      normalizeSettingsViewState({
        open: 'yes',
        activeSection: 'credential',
        query: 12,
        scrollTop: -1,
        token: 'must-not-be-restored'
      })
    ).toEqual(defaultSettingsViewState());
  });
});
