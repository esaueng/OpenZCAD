import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TileName } from './TileName';

/**
 * happy-dom does no layout, so these stand one in: a tile 100px wide, 10px
 * per character, 16px lines. The probe's height is its text's wrapped line
 * count; a name of up to 20 characters fits the two-line tile.
 */
const TILE_WIDTH = 100;
const CHAR_WIDTH = 10;
const LINE = 16;

function layoutHeight(element: HTMLElement): number {
  const width = Number.parseFloat(element.style.width) || TILE_WIDTH;
  const chars = Array.from(element.textContent ?? '').length;
  return Math.max(1, Math.ceil((chars * CHAR_WIDTH) / width)) * LINE;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(
    TILE_WIDTH
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const height = layoutHeight(this);
      return DOMRect.fromRect({ width: TILE_WIDTH, height });
    }
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TileName', () => {
  it('shows a name that fits two lines whole', () => {
    const { container } = render(<TileName name="Lucky Quokka" />);
    const name = container.querySelector('.start-tile-name');
    expect(name?.textContent).toBe('Lucky Quokka');
    expect(name?.querySelector('.start-tile-name-short')).toBeNull();
  });

  it('shortens a longer name in the middle, keeping its distinguishing end', () => {
    const full = 'OAWIHDOIAWHDOIHAWawdawd VERSION 2';
    const { container } = render(<TileName name={full} />);
    const name = container.querySelector('.start-tile-name');
    const short = name?.querySelector('.start-tile-name-short')?.textContent;
    expect(short).toBe('OAWIHDOIAWHD…RSION 2');
    expect(Array.from(short ?? '').length).toBeLessThanOrEqual(20);
    // The full name stays on hover and for the list row's focus reveal.
    expect(name?.getAttribute('title')).toBe(full);
    expect(name?.querySelector('.start-tile-name-full')?.textContent).toBe(
      full
    );
  });

  it('refits when the name changes', () => {
    const { container, rerender } = render(
      <TileName name="PiKVM v3.3 Enclosure V6 - Hardware fit" />
    );
    expect(
      container.querySelector('.start-tile-name-short')?.textContent
    ).toContain('…');
    rerender(<TileName name="Tiny Fox" />);
    expect(container.querySelector('.start-tile-name')?.textContent).toBe(
      'Tiny Fox'
    );
  });
});
