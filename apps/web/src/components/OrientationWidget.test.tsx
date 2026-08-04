import type { MutableRefObject } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AxisProjection } from '@openzcad/viewport';
import { OrientationWidget } from './OrientationWidget';

const capturedPointers = new WeakMap<SVGElement, Set<number>>();
const originalCaptureMethods = {
  set: Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    'setPointerCapture'
  ),
  has: Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    'hasPointerCapture'
  ),
  release: Object.getOwnPropertyDescriptor(
    SVGElement.prototype,
    'releasePointerCapture'
  )
};

function restoreProperty(
  name: 'setPointerCapture' | 'hasPointerCapture' | 'releasePointerCapture',
  descriptor: PropertyDescriptor | undefined
) {
  if (descriptor) {
    Object.defineProperty(SVGElement.prototype, name, descriptor);
  } else {
    Reflect.deleteProperty(SVGElement.prototype, name);
  }
}

beforeAll(() => {
  Object.defineProperties(SVGElement.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        const captured = capturedPointers.get(this) ?? new Set<number>();
        captured.add(pointerId);
        capturedPointers.set(this, captured);
      }
    },
    hasPointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        return capturedPointers.get(this)?.has(pointerId) ?? false;
      }
    },
    releasePointerCapture: {
      configurable: true,
      value(this: SVGElement, pointerId: number) {
        capturedPointers.get(this)?.delete(pointerId);
        this.dispatchEvent(
          new PointerEvent('lostpointercapture', {
            bubbles: true,
            pointerId
          })
        );
      }
    }
  });
});

afterAll(() => {
  restoreProperty('setPointerCapture', originalCaptureMethods.set);
  restoreProperty('hasPointerCapture', originalCaptureMethods.has);
  restoreProperty('releasePointerCapture', originalCaptureMethods.release);
});

function renderWidget() {
  const orientationRef = {
    current: null
  } as MutableRefObject<((axes: AxisProjection) => void) | null>;
  const callbacks = {
    onSelectView: vi.fn(),
    onRotateView: vi.fn(),
    onDragStart: vi.fn(),
    onDrag: vi.fn(),
    onDragEnd: vi.fn()
  };
  const result = render(
    <OrientationWidget orientationRef={orientationRef} {...callbacks} />
  );
  const face = result.container.querySelector<SVGPolygonElement>(
    'polygon[aria-label="Right view"]'
  );
  if (!face) {
    throw new Error('Right orientation face was not rendered');
  }
  return { ...result, ...callbacks, face, orientationRef };
}

type PointerKind = 'mouse' | 'touch' | 'pen';

function pointerDown(
  target: SVGElement,
  pointerId: number,
  pointerType: PointerKind,
  x = 10,
  y = 10
) {
  fireEvent.pointerDown(target, {
    pointerId,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y
  });
}

function pointerMove(
  target: SVGElement,
  pointerId: number,
  pointerType: PointerKind,
  x: number,
  y: number
) {
  const event = new PointerEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y
  });
  fireEvent(target, event);
  return event;
}

function pointerUp(
  target: SVGElement,
  pointerId: number,
  pointerType: PointerKind,
  x: number,
  y: number
) {
  fireEvent.pointerUp(target, {
    pointerId,
    pointerType,
    button: 0,
    clientX: x,
    clientY: y
  });
}

function startDrag(
  target: SVGElement,
  pointerId: number,
  pointerType: PointerKind = 'mouse'
) {
  pointerDown(target, pointerId, pointerType);
  return pointerMove(target, pointerId, pointerType, 18, 14);
}

describe('OrientationWidget pointer lifecycle', () => {
  it('snaps exactly once after sub-threshold pointer wobble', () => {
    const { face, onSelectView, onDragStart, onDrag, onDragEnd } =
      renderWidget();

    pointerDown(face, 1, 'mouse');
    pointerMove(face, 1, 'mouse', 12, 13);
    pointerUp(face, 1, 'mouse', 12, 13);
    fireEvent.click(face);

    expect(onSelectView).toHaveBeenCalledOnce();
    expect(onSelectView).toHaveBeenCalledWith('right');
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onDrag).not.toHaveBeenCalled();
    expect(onDragEnd).not.toHaveBeenCalled();
  });

  it.each<PointerKind>(['mouse', 'touch', 'pen'])(
    'orbits %s input above the threshold without snapping or scrolling',
    (pointerType) => {
      const { face, onSelectView, onDragStart, onDrag, onDragEnd } =
        renderWidget();

      pointerDown(face, 2, pointerType);
      const move = pointerMove(face, 2, pointerType, 18, 14);
      pointerUp(face, 2, pointerType, 18, 14);
      fireEvent.click(face);

      expect(move.defaultPrevented).toBe(true);
      expect(onDragStart).toHaveBeenCalledOnce();
      expect(onDrag).toHaveBeenCalledWith(8, 4);
      expect(onDragEnd).toHaveBeenCalledOnce();
      expect(onSelectView).not.toHaveBeenCalled();
    }
  );

  it.each(['pointercancel', 'lostpointercapture', 'window blur'] as const)(
    'finishes once on %s and permits a new drag',
    (ending) => {
      const { face, onSelectView, onDragStart, onDragEnd } = renderWidget();

      startDrag(face, 3);
      expect(() => {
        if (ending === 'pointercancel') {
          fireEvent.pointerCancel(face, { pointerId: 3, pointerType: 'mouse' });
        } else if (ending === 'lostpointercapture') {
          capturedPointers.get(face)?.delete(3);
          fireEvent.lostPointerCapture(face, {
            pointerId: 3,
            pointerType: 'mouse'
          });
        } else {
          window.dispatchEvent(new Event('blur'));
        }
      }).not.toThrow();

      expect(onDragEnd).toHaveBeenCalledOnce();
      fireEvent.click(face);
      expect(onSelectView).not.toHaveBeenCalled();

      startDrag(face, 4);
      pointerUp(face, 4, 'mouse', 18, 14);
      expect(onDragStart).toHaveBeenCalledTimes(2);
      expect(onDragEnd).toHaveBeenCalledTimes(2);
    }
  );

  it('finishes an active drag exactly once when unmounted', () => {
    const { face, onDragEnd, orientationRef, unmount } = renderWidget();
    startDrag(face, 5, 'pen');

    expect(() => unmount()).not.toThrow();

    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(orientationRef.current).toBeNull();
  });

  it('retains keyboard face activation', () => {
    const { face, onSelectView } = renderWidget();

    fireEvent.keyDown(face, { key: 'Enter' });
    fireEvent.keyDown(face, { key: ' ' });

    expect(onSelectView).toHaveBeenCalledTimes(2);
    expect(onSelectView).toHaveBeenNthCalledWith(1, 'right');
    expect(onSelectView).toHaveBeenNthCalledWith(2, 'right');
  });
});
