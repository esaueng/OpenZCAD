import { describe, expect, it } from 'vitest';
import { tapWording } from './touchWording';

describe('tapWording (U12)', () => {
  it('says tap where a prompt says click, keeping its case and ending', () => {
    expect(tapWording('Diameter: click where the dimension goes.')).toBe(
      'Diameter: tap where the dimension goes.'
    );
    expect(
      tapWording('Click on a side of the line to place the section.')
    ).toBe('Tap on a side of the line to place the section.');
    expect(tapWording('Clicking the first point closes it.')).toBe(
      'Tapping the first point closes it.'
    );
    expect(tapWording('Two clicks; it was clicked; double-click it.')).toBe(
      'Two taps; it was tapped; double-tap it.'
    );
  });

  it('leaves words that only contain "click" alone', () => {
    expect(tapWording('A clicker and clickable rows.')).toBe(
      'A clicker and clickable rows.'
    );
    expect(tapWording('Drag across a view.')).toBe('Drag across a view.');
  });
});
