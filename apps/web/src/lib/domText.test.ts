import { afterEach, describe, expect, it } from 'vitest';
import { renderChipText, setElementText } from './domText';

/**
 * Child-list mutations under the stage make Chromium re-run the workspace's
 * `:has()` rules (about 10 ms a frame on a dragged chip). These helpers must
 * change existing text nodes instead, so only character data mutates.
 */
function recordMutations(target: Node) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(target, {
    childList: true,
    characterData: true,
    subtree: true
  });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    return records.map((record) => record.type);
  };
}

describe('setElementText', () => {
  afterEach(() => document.body.replaceChildren());

  it('updates a lone text node in place', () => {
    const element = document.createElement('div');
    element.textContent = 'Offset ▾';
    const node = element.firstChild;
    const stop = recordMutations(element);
    setElementText(element, 'Total ▾');
    setElementText(element, 'Total ▾');
    expect(stop()).toEqual(['characterData']);
    expect(element.firstChild).toBe(node);
    expect(element.textContent).toBe('Total ▾');
  });

  it('keeps textContent semantics for other shapes and empty text', () => {
    const element = document.createElement('div');
    element.append(document.createElement('span'), 'tail');
    setElementText(element, 'plain');
    expect(element.childNodes).toHaveLength(1);
    expect(element.textContent).toBe('plain');
    setElementText(element, '');
    expect(element.childNodes).toHaveLength(0);
    const stop = recordMutations(element);
    setElementText(element, '');
    expect(stop()).toEqual([]);
  });
});

describe('renderChipText', () => {
  it('splits prefix, number and units without changing the text', () => {
    const chip = document.createElement('div');
    renderChipText(chip, 'Total 25.59 mm');
    expect(chip.textContent).toBe('Total 25.59 mm');
    expect([...chip.children].map((child) => child.className)).toEqual([
      'chip-prefix',
      'chip-number',
      'chip-units'
    ]);
    renderChipText(chip, 'no number');
    expect(chip.textContent).toBe('no number');
    expect(chip.children).toHaveLength(0);
  });

  it('reuses the spans while a drag only changes the value', () => {
    const chip = document.createElement('div');
    renderChipText(chip, 'Total 25.59 mm');
    const spans = [...chip.children];
    const stop = recordMutations(chip);
    for (const value of ['25.6', '26', '-3.25', '26'])
      renderChipText(chip, `Total ${value} mm`);
    expect(new Set(stop())).toEqual(new Set(['characterData']));
    expect([...chip.children]).toEqual(spans);
    expect(chip.textContent).toBe('Total 26 mm');
  });

  it('rebuilds when the split changes shape', () => {
    const chip = document.createElement('div');
    renderChipText(chip, 'Total 25 mm');
    renderChipText(chip, '12 mm');
    expect([...chip.children].map((child) => child.className)).toEqual([
      'chip-number',
      'chip-units'
    ]);
    expect(chip.textContent).toBe('12 mm');
  });
});
