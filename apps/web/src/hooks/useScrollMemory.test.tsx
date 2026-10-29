import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useScrollMemory } from './useScrollMemory';

const KEY = 'test.scroll';

function Screen({ view, ready }: { view: string; ready: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useScrollMemory(ref, KEY, ['.body'], view, ready);
  return (
    <div ref={ref} data-testid="root">
      <div className="body" data-testid="body" />
    </div>
  );
}

afterEach(() => sessionStorage.clear());

describe('useScrollMemory', () => {
  it('puts back the stored position for the same view', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: 'parts', tops: { '': 0, '.body': 640.5 } })
    );
    const { getByTestId } = render(<Screen view="parts" ready />);
    expect(getByTestId('body').scrollTop).toBe(640.5);
  });

  it('ignores a position stored for another view', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: 'archive', tops: { '.body': 640 } })
    );
    const { getByTestId } = render(<Screen view="parts" ready />);
    expect(getByTestId('body').scrollTop).toBe(0);
  });

  it('stops restoring once someone scrolls, and saves where they go', async () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: 'parts', tops: { '.body': 640 } })
    );
    const { getByTestId, rerender } = render(
      <Screen view="parts" ready={false} />
    );
    const body = getByTestId('body');
    fireEvent.wheel(body);
    body.scrollTop = 120;
    rerender(<Screen view="parts" ready={false} />);
    expect(body.scrollTop).toBe(120);
    fireEvent.scroll(body);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(JSON.parse(sessionStorage.getItem(KEY)!)).toEqual({
      view: 'parts',
      tops: { '': 0, '.body': 120 }
    });
  });
});
