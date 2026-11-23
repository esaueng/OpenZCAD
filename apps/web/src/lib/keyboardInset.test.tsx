import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { keyboardInset, useKeyboardInset } from './keyboardInset';

const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport');

function fakeVisualViewport(height: number, offsetTop = 0) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop });
  Object.defineProperty(window, 'visualViewport', {
    value: viewport,
    configurable: true
  });
  return viewport;
}

afterEach(() => {
  if (previous) Object.defineProperty(window, 'visualViewport', previous);
  else Reflect.deleteProperty(window, 'visualViewport');
});

function Probe() {
  const ref = useRef<HTMLDivElement | null>(null);
  useKeyboardInset(ref);
  return <div ref={ref} data-testid="probe" />;
}

describe('the keyboard inset', () => {
  it('is what the visual viewport leaves below itself', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    fakeVisualViewport(480);
    expect(keyboardInset()).toBe(364);
    fakeVisualViewport(480, 100);
    expect(keyboardInset()).toBe(264);
    fakeVisualViewport(900);
    expect(keyboardInset()).toBe(0);
    vi.restoreAllMocks();
  });

  it('follows the keyboard while mounted and is removed on unmount', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    const viewport = fakeVisualViewport(844);
    const { getByTestId, unmount } = render(<Probe />);
    const probe = getByTestId('probe');
    expect(probe.style.getPropertyValue('--keyboard-inset')).toBe('0px');

    viewport.height = 480;
    viewport.dispatchEvent(new Event('resize'));
    expect(probe.style.getPropertyValue('--keyboard-inset')).toBe('364px');

    // Panning the visual viewport moves its bottom too.
    viewport.offsetTop = 64;
    viewport.dispatchEvent(new Event('scroll'));
    expect(probe.style.getPropertyValue('--keyboard-inset')).toBe('300px');

    unmount();
    expect(probe.style.getPropertyValue('--keyboard-inset')).toBe('');
    vi.restoreAllMocks();
  });
});
