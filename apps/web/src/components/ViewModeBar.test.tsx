import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerSettings } from '@openzcad/viewport';
import { setActiveKeymapOverrides } from '../lib/keymap';
import { ViewModeBar } from './ViewModeBar';

function renderBar(
  orbitMode: ViewerSettings['orbitMode'],
  onToggleOrbitMode?: () => void,
  extra: Partial<ComponentProps<typeof ViewModeBar>> = {}
) {
  const noop = () => undefined;
  render(
    <ViewModeBar
      settings={{
        showGrid: true,
        displayMode: 'shaded-edges',
        ...(orbitMode ? { orbitMode } : {})
      }}
      projection="perspective"
      measuring={false}
      onMeasure={noop}
      onFit={noop}
      onToggleGrid={noop}
      onView={noop}
      onDisplayMode={noop}
      onToggleXray={noop}
      onToggleProjection={noop}
      {...(onToggleOrbitMode ? { onToggleOrbitMode } : {})}
      {...extra}
    />
  );
}

afterEach(() => setActiveKeymapOverrides({}));

describe('Orbit mode on the View mode bar', () => {
  it('reads pressed in turntable mode, names the mode and its key, and toggles', () => {
    const onToggleOrbitMode = vi.fn();
    renderBar('turntable', onToggleOrbitMode);
    const button = screen.getByRole('button', { name: /^Turntable orbit/ });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe(
      'Turntable orbit (Shift+O) — now: Turntable'
    );
    fireEvent.click(button);
    expect(onToggleOrbitMode).toHaveBeenCalledTimes(1);
  });

  it('reads free when the view carries no orbit mode', () => {
    renderBar(undefined, vi.fn());
    const button = screen.getByRole('button', { name: /^Turntable orbit/ });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toMatch(/now: Free$/);
  });

  it('names a remapped key', () => {
    act(() => setActiveKeymapOverrides({ 'view-orbit-mode': ['Shift+T'] }));
    renderBar('free', vi.fn());
    expect(
      screen.getByRole('button', { name: /^Turntable orbit/ })
    ).toHaveAccessibleName('Turntable orbit (Shift+T) — now: Free');
  });

  it('draws no orbit button without a handler', () => {
    renderBar('free');
    expect(
      screen.queryByRole('button', { name: /^Turntable orbit/ })
    ).toBeNull();
  });
});

describe('the View mode bar’s order (I52)', () => {
  it('keeps Build’s instrument order, Section and the Display menu included', () => {
    const onToggleSection = vi.fn();
    renderBar('free', vi.fn(), { onToggleSection });
    const names = screen
      .getByRole('toolbar', { name: 'View tools' })
      .querySelectorAll('button');
    expect(
      [...names].map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'Measure',
      'Fit view (F)',
      'Toggle grid (G)',
      'Orthographic projection (P) — now: Perspective',
      'Turntable orbit (Shift+O) — now: Free',
      'Section view — now: Off',
      'Display mode (W) — now: Shaded + edges',
      'Standard views'
    ]);
    fireEvent.click(screen.getByRole('button', { name: /^Section view/ }));
    expect(onToggleSection).toHaveBeenCalledTimes(1);
  });

  it('greys Section with nothing to cut', () => {
    const onToggleSection = vi.fn();
    renderBar('free', undefined, { onToggleSection, nothingToSection: true });
    const section = screen.getByRole('button', { name: /^Section view/ });
    expect(section).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(section);
    expect(onToggleSection).not.toHaveBeenCalled();
  });

  it('reaches X-ray from the Display menu', () => {
    const onToggleXray = vi.fn();
    renderBar('free', undefined, { onToggleXray });
    fireEvent.click(screen.getByRole('button', { name: /^Display mode/ }));
    fireEvent.click(screen.getByRole('button', { name: /^X-ray/ }));
    expect(onToggleXray).toHaveBeenCalledTimes(1);
  });
});
