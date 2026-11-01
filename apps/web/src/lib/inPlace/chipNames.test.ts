import { describe, expect, it, vi } from 'vitest';
import {
  commandChipName,
  nameCommandChip,
  prepareCommandChip,
  spokenValueName
} from './chipNames';

describe('command chip names', () => {
  it('speaks glyph labels as words', () => {
    expect(spokenValueName('⌀')).toBe('Diameter');
    expect(spokenValueName('R')).toBe('Radius');
    expect(spokenValueName('×')).toBe('Scale');
    expect(spokenValueName('Counterbore ⌀')).toBe('Counterbore diameter');
    expect(spokenValueName('Depth')).toBe('Depth');
  });

  it('names the value and its unit', () => {
    expect(commandChipName('⌀', '6', 'length', 'mm')).toBe('Diameter 6 mm');
    expect(commandChipName('Angle', '270', 'angle', 'mm')).toBe(
      'Angle 270 degrees'
    );
    expect(commandChipName('Count', '4', 'count', 'mm')).toBe('Count 4');
    expect(commandChipName('×', '1.5', 'number', 'in')).toBe('Scale 1.5');
    expect(commandChipName('U · along −Y', '0', 'length', 'in')).toBe(
      'U · along −Y 0 in'
    );
  });
});

describe('command chip controls', () => {
  it('opens from the keyboard without the press reaching the workspace', () => {
    const chip = document.createElement('div');
    document.body.appendChild(chip);
    const open = vi.fn();
    const workspace = vi.fn();
    window.addEventListener('keydown', workspace);
    try {
      prepareCommandChip(chip, open);
      expect(chip).toHaveAttribute('role', 'button');
      expect(chip.tabIndex).toBe(0);
      for (const key of ['Enter', ' ']) {
        chip.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        );
      }
      chip.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', bubbles: true })
      );
      chip.click();
      expect(open).toHaveBeenCalledTimes(3);
      // Only the unrelated key reaches the workspace's shortcuts.
      expect(workspace).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', workspace);
      chip.remove();
    }
  });

  it('keeps the accessible name in step with the value', () => {
    const chip = document.createElement('div');
    nameCommandChip(chip, 'Radius 2 mm');
    expect(chip).toHaveAttribute('aria-label', 'Radius 2 mm');
    nameCommandChip(chip, undefined);
    expect(chip).not.toHaveAttribute('aria-label');
  });
});
