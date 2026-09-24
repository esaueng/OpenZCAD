import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDissolveOnUnmount } from './useDissolveOnUnmount';

function Screen() {
  const ref = useRef<HTMLDivElement | null>(null);
  useDissolveOnUnmount(ref, 240);
  return (
    <div ref={ref} className="start-screen">
      <label htmlFor="project-name">Name</label>
      <input id="project-name" />
    </div>
  );
}

describe('useDissolveOnUnmount', () => {
  let finish: () => void = () => undefined;
  const animate = vi.fn(() => ({
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    })
  }));

  beforeEach(() => {
    animate.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      value: animate
    });
    // happy-dom lays nothing out; give the screen the box a browser would.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ width: 1280, height: 800 })
    );
    document.documentElement.dataset.reducedMotion = 'false';
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.restoreAllMocks();
    delete document.documentElement.dataset.reducedMotion;
    document.querySelectorAll('.dissolving').forEach((node) => node.remove());
  });

  it('leaves an inert, id-free copy fading over what replaces it', async () => {
    const { unmount } = render(<Screen />);
    unmount();

    const ghost = document.querySelector<HTMLElement>(
      '.start-screen.dissolving'
    );
    expect(ghost).not.toBeNull();
    expect(ghost?.getAttribute('aria-hidden')).toBe('true');
    expect(ghost?.inert).toBe(true);
    expect(ghost?.querySelector('[id]')).toBeNull();
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 1 }, { opacity: 0 }],
      expect.objectContaining({ duration: 240 })
    );

    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('.dissolving')).toBeNull();
  });

  it('leaves nothing behind for a screen that was never laid out', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(
      DOMRect.fromRect({ width: 0, height: 0 })
    );
    const { unmount } = render(<Screen />);
    unmount();
    expect(document.querySelector('.dissolving')).toBeNull();
  });

  it('cuts straight over when motion is reduced', () => {
    document.documentElement.dataset.reducedMotion = 'true';
    const { unmount } = render(<Screen />);
    unmount();
    expect(document.querySelector('.dissolving')).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
});
