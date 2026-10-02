import { afterEach, describe, expect, it } from 'vitest';
import {
  MASS_DENSITY_STORAGE_KEY,
  loadMassDensitySelection,
  saveMassDensitySelection
} from './massDensityPreference';

afterEach(() => {
  window.localStorage.removeItem(MASS_DENSITY_STORAGE_KEY);
});

describe('mass density preference', () => {
  it('opens at unit density and round-trips a preset per project', () => {
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
    expect(
      saveMassDensitySelection('proj-a', { kind: 'preset', presetId: 'steel' })
    ).toBe(true);
    expect(loadMassDensitySelection('proj-a')).toEqual({
      kind: 'preset',
      presetId: 'steel'
    });
    // Keyed by project: a second project still opens at unit density.
    expect(loadMassDensitySelection('proj-b')).toEqual({ kind: 'unit' });
  });

  it('round-trips a custom density and clears back to unit', () => {
    saveMassDensitySelection('proj-a', {
      kind: 'custom',
      densityKgPerM3: 1200
    });
    expect(loadMassDensitySelection('proj-a')).toEqual({
      kind: 'custom',
      densityKgPerM3: 1200
    });
    saveMassDensitySelection('proj-a', { kind: 'unit' });
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
    // Clearing removes the entry rather than storing a unit marker.
    const raw = window.localStorage.getItem(MASS_DENSITY_STORAGE_KEY);
    expect(raw === null || !raw.includes('proj-a')).toBe(true);
  });

  it('normalizes unknown presets and out-of-range customs to unit', () => {
    saveMassDensitySelection('proj-a', {
      kind: 'preset',
      presetId: 'unobtainium'
    });
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
    saveMassDensitySelection('proj-a', {
      kind: 'custom',
      densityKgPerM3: -5
    });
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
  });

  it('survives corrupt storage and version drift', () => {
    window.localStorage.setItem(MASS_DENSITY_STORAGE_KEY, '{not json');
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
    window.localStorage.setItem(
      MASS_DENSITY_STORAGE_KEY,
      JSON.stringify({
        version: 999,
        selections: { 'proj-a': { kind: 'preset', presetId: 'steel' } }
      })
    );
    expect(loadMassDensitySelection('proj-a')).toEqual({ kind: 'unit' });
  });
});
