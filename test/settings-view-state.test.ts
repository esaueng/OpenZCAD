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
      activeSection: 'controls',
      query: 'mouse',
      scrollTop: 420
    });
    expect(updateSettingsViewState({ open: false })).toEqual({
      open: false,
      activeSection: 'controls',
      query: 'mouse',
      scrollTop: 420
    });
  });

  it('records a section asked for by name, for compact Settings to open', () => {
    saveSettingsViewState({
      open: false,
      activeSection: 'general',
      query: '',
      scrollTop: 0
    });
    // Naming a section asks for it (Account storage, an invitation link).
    expect(
      updateSettingsViewState({ open: true, activeSection: 'account' })
    ).toMatchObject({ activeSection: 'account', sectionRequested: true });
    // A change that names none leaves the request as it was.
    expect(updateSettingsViewState({ query: 'x' }).sectionRequested).toBe(true);
    // A return visit opens on the list, and stores nothing for it.
    const returned = updateSettingsViewState({
      open: true,
      sectionRequested: false
    });
    expect(returned).not.toHaveProperty('sectionRequested');
    expect(returned.activeSection).toBe('account');
    // A caller may name a section without asking for it.
    expect(
      updateSettingsViewState({
        activeSection: 'viewport',
        sectionRequested: false
      })
    ).not.toHaveProperty('sectionRequested');
    expect(
      normalizeSettingsViewState({ sectionRequested: 'yes' })
    ).not.toHaveProperty('sectionRequested');
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

  it('reopens a renamed section where its settings now live', () => {
    window.localStorage.setItem(
      SETTINGS_VIEW_STATE_STORAGE_KEY,
      JSON.stringify({ open: true, activeSection: 'files', scrollTop: 0 })
    );
    expect(loadSettingsViewState().activeSection).toBe('saving');
    expect(
      normalizeSettingsViewState({ activeSection: 'shortcuts' }).activeSection
    ).toBe('controls');
  });

  it('never resolves a stored id up the prototype chain', () => {
    for (const activeSection of ['constructor', 'toString', '__proto__']) {
      expect(normalizeSettingsViewState({ activeSection }).activeSection).toBe(
        'general'
      );
    }
  });
});
