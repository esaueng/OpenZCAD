import { afterEach, describe, expect, it, vi } from 'vitest';
import { DARK_STAGE_PALETTE } from '@openzcad/viewport';
import { readStagePalette, watchStageTheme } from './stagePalette';

describe('readStagePalette', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('reads the stage from the resolved theme tokens', () => {
    const root = document.documentElement;
    root.style.setProperty('--color-stage-top', '#f5f5f5');
    root.style.setProperty('--color-viewport-bg', '#eeeeee');
    root.style.setProperty('--color-stage-bottom', '#e6e6e6');
    root.style.setProperty('--color-stage-grid-minor', '#c4c4c4');
    root.style.setProperty('--color-stage-grid-major', '#b0b0b0');
    root.style.setProperty('--stage-shadow-opacity', '0.18');

    expect(readStagePalette(root)).toEqual({
      backdropTop: '#f5f5f5',
      backdropMiddle: '#eeeeee',
      backdropBottom: '#e6e6e6',
      gridMinor: '#c4c4c4',
      gridMajor: '#b0b0b0',
      shadowOpacity: 0.18
    });
  });

  it('falls back to the graphite stage when a token is missing or unreadable', () => {
    const root = document.documentElement;
    root.style.setProperty('--color-viewport-bg', 'not a colour');

    expect(readStagePalette(root)).toEqual(DARK_STAGE_PALETTE);
  });
});

describe('watchStageTheme', () => {
  it('fires when the Appearance setting rewrites data-theme, and stops when told', async () => {
    const onChange = vi.fn();
    const stop = watchStageTheme(onChange);
    document.documentElement.dataset.theme = 'light';
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);

    stop();
    document.documentElement.dataset.theme = 'dark';
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    delete document.documentElement.dataset.theme;
  });
});
