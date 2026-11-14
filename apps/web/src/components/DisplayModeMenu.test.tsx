import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DisplayMode } from '@openzcad/viewport';
import { DisplayModeMenu, isWorkspaceShortcutKey } from './DisplayModeMenu';

function renderMenu(displayMode: DisplayMode = 'shaded-edges', xray = false) {
  const onDisplayMode = vi.fn();
  const onToggleXray = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DisplayModeMenu
      variant="rail"
      settings={{ displayMode, xray }}
      onDisplayMode={onDisplayMode}
      onToggleXray={onToggleXray}
      onOpenChange={onOpenChange}
    />
  );
  const trigger = screen.getByRole('button', { name: /^Display mode/ });
  const menu = () => within(screen.getByRole('group', { name: 'Display' }));
  return { trigger, menu, onDisplayMode, onToggleXray, onOpenChange };
}

describe('the Display menu (I52)', () => {
  it('lists the three modes and X-ray, marking what is on', () => {
    const { trigger, menu, onOpenChange } = renderMenu('shaded', true);
    expect(trigger).toHaveAccessibleName(
      'Display mode (W) — now: Shaded · X-ray'
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    const items = menu().getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      'Shaded + edges',
      'Shaded',
      'Wireframe',
      expect.stringMatching(/^X-ray/)
    ]);
    expect(items.map((item) => item.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'true'
    ]);
    expect(menu().getByRole('button', { name: 'X-ray (Shift+X)' })).toBe(
      items[3]
    );
  });

  it('shows the model in the mode picked, closes, and hands the keyboard back', () => {
    const { trigger, menu, onDisplayMode } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(menu().getByRole('button', { name: 'Wireframe' }));
    expect(onDisplayMode).toHaveBeenCalledWith('wireframe');
    expect(screen.queryByRole('group', { name: 'Display' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('switches X-ray and stays open, so a mode can be picked under it', () => {
    const { trigger, menu, onToggleXray } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(menu().getByRole('button', { name: /^X-ray/ }));
    expect(onToggleXray).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('group', { name: 'Display' })).toBeDefined();
  });

  it('closes on Escape, on a press outside, and on a shortcut', () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Display' })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('group', { name: 'Display' })).toBeNull();

    fireEvent.click(trigger);
    // S arms Sketch: the menu steps aside rather than stand over it.
    fireEvent.keyDown(trigger, { key: 's' });
    expect(screen.queryByRole('group', { name: 'Display' })).toBeNull();
  });
});

describe('isWorkspaceShortcutKey', () => {
  const press = (init: KeyboardEventInit, target?: EventTarget) => {
    const event = new KeyboardEvent('keydown', init);
    if (target) Object.defineProperty(event, 'target', { value: target });
    return isWorkspaceShortcutKey(event);
  };

  it('takes a bare printable key and nothing typed into a field', () => {
    expect(press({ key: 's' })).toBe(true);
    expect(press({ key: '1' })).toBe(true);
    expect(press({ key: 's', ctrlKey: true })).toBe(false);
    expect(press({ key: 'Tab' })).toBe(false);
    expect(press({ key: ' ' })).toBe(false);
    expect(press({ key: 's' }, document.createElement('input'))).toBe(false);
  });
});
