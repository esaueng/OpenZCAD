import { afterEach, describe, expect, it } from 'vitest';
import { releaseFocusOutside } from './viewportFocus';

describe('releaseFocusOutside', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount() {
    document.body.innerHTML = `
      <nav><button type="button" id="arc">Arc</button></nav>
      <div id="viewport"><input id="chip" /></div>
    `;
    return {
      arc: document.getElementById('arc') as HTMLButtonElement,
      chip: document.getElementById('chip') as HTMLInputElement,
      viewport: document.getElementById('viewport') as HTMLDivElement
    };
  }

  it('takes focus off a toolbar tile when the viewport is pressed', () => {
    const { arc, viewport } = mount();
    arc.focus();
    expect(document.activeElement).toBe(arc);

    releaseFocusOutside(viewport);
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves a field the viewport draws itself focused', () => {
    const { chip, viewport } = mount();
    chip.focus();

    releaseFocusOutside(viewport);
    expect(document.activeElement).toBe(chip);
  });

  it('does nothing when nothing is focused', () => {
    const { viewport } = mount();
    releaseFocusOutside(viewport);
    expect(document.activeElement).toBe(document.body);
  });
});
