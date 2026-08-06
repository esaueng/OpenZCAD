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

  describe('isometric corner targets', () => {
    /**
     * A true isometric basis with the +X+Y+Z corner turned toward the camera:
     * screen-right is (1,-1,0)/√2, screen-up is (-1,-1,2)/√6 negated for SVG's
     * downward y, and every axis is equally foreshortened in depth.
     */
    const ISOMETRIC = {
      x: { x: 0.70711, y: 0.40825, z: 0.57735 },
      y: { x: -0.70711, y: 0.40825, z: 0.57735 },
      z: { x: 0, y: -0.8165, z: 0.57735 }
    };

    type Point = readonly [number, number];

    function polygonPoints(element: SVGPolygonElement): Point[] {
      const raw = element.getAttribute('points');
      if (!raw) {
        throw new Error('facet was rendered without any points');
      }
      return raw
        .trim()
        .split(/\s+/)
        .map((pair): Point => {
          const [x, y] = pair.split(',').map(Number);
          return [x ?? Number.NaN, y ?? Number.NaN];
        });
    }

    /** Unsigned shoelace area, so winding direction does not matter. */
    function area(points: Point[]): number {
      let sum = 0;
      for (let i = 0; i < points.length; i += 1) {
        const [x1, y1] = points[i] ?? [0, 0];
        const [x2, y2] = points[(i + 1) % points.length] ?? [0, 0];
        sum += x1 * y2 - x2 * y1;
      }
      return Math.abs(sum) / 2;
    }

    function contains(polygon: Point[], [x, y]: Point): boolean {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i] ?? [0, 0];
        const [xj, yj] = polygon[j] ?? [0, 0];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    }

    function visibleCorners(container: HTMLElement) {
      return [...container.querySelectorAll('.cube-corner-target')]
        .map((group) => ({
          drawn: group.querySelector<SVGPolygonElement>('.cube-corner'),
          target: group.querySelector<SVGPolygonElement>('.cube-corner-hit')
        }))
        .filter(
          (pair): pair is { drawn: SVGPolygonElement; target: SVGPolygonElement } =>
            pair.drawn !== null &&
            pair.target !== null &&
            pair.target.style.display !== 'none'
        );
    }

    it('gives every drawn corner a target that reaches past it', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.(ISOMETRIC);

      const corners = visibleCorners(container);
      expect(corners.length).toBeGreaterThan(0);

      for (const { drawn, target } of corners) {
        // The deeper cut is more than twice the facet it widens, on every
        // corner and not just the one turned toward the camera.
        expect(area(polygonPoints(target))).toBeGreaterThan(
          area(polygonPoints(drawn)) * 2
        );
      }
    });

    it('never lets the target fall short of the facet you can see', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.(ISOMETRIC);

      const corners = visibleCorners(container);
      const glancing = corners.filter(
        ({ drawn, target }) =>
          !polygonPoints(drawn).every((vertex) =>
            contains(polygonPoints(target), vertex)
          )
      );
      // The deeper cut is the drawn facet scaled about the corner's projected
      // apex, and at a glancing angle that apex lies outside it — so on those
      // corners the deeper cut does NOT contain the facet. This is the whole
      // reason the click sits on the group rather than on that cut: the target
      // is the union of both, which cannot be smaller than what is drawn.
      expect(glancing.length).toBeGreaterThan(0);
      for (const { drawn, target } of glancing) {
        expect(drawn.parentElement).toBe(target.parentElement);
        expect(drawn.parentElement).toHaveClass('cube-corner-target');
      }
    });

    it('takes the click from the drawn facet as well as the deeper cut', () => {
      const { container, orientationRef, onSelectView } = renderWidget();
      orientationRef.current?.(ISOMETRIC);

      const [corner] = visibleCorners(container);
      if (!corner) {
        throw new Error('no corner facet was visible in the isometric view');
      }
      // Both halves reach the same handler on the group. If this only worked
      // from the deeper cut, the glancing corners above would have lost part
      // of their visible facet to whatever sits behind the widget.
      fireEvent.click(corner.drawn);
      fireEvent.click(corner.target);

      expect(onSelectView).toHaveBeenCalledTimes(2);
      expect(onSelectView.mock.calls[0]?.[0]).toEqual(
        onSelectView.mock.calls[1]?.[0]
      );
    });

    it('leaves the pointer with the target, not the facet it stands for', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.(ISOMETRIC);

      const [corner] = visibleCorners(container);
      expect(corner).toBeDefined();
      // Only one of the pair may answer to a click, or the two could disagree
      // about which corner the pointer is over.
      expect(corner?.drawn.getAttribute('aria-hidden')).toBe('true');
      expect(corner?.drawn.getAttribute('role')).toBeNull();
      expect(corner?.target.getAttribute('role')).toBe('button');
      expect(corner?.target.getAttribute('aria-label')).toMatch(
        /isometric view$/
      );
    });

    it('selects the isometric view from the target', () => {
      const { container, orientationRef, onSelectView } = renderWidget();
      orientationRef.current?.(ISOMETRIC);

      const [corner] = visibleCorners(container);
      if (!corner) {
        throw new Error('no corner facet was visible in the isometric view');
      }
      fireEvent.click(corner.target);

      expect(onSelectView).toHaveBeenCalledOnce();
      expect(onSelectView.mock.calls[0]?.[0]).toHaveProperty('corner');
    });
  });
});
