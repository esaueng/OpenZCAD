import type { MutableRefObject } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AxisProjection } from '@openzcad/viewport';
import { HIT_LAYER_SETTLE_MS, OrientationWidget } from './OrientationWidget';
import type { OrientationLink } from './viewer/orientationCube';

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
  } as MutableRefObject<OrientationLink | null>;
  const callbacks = {
    onSelectView: vi.fn(),
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
          (
            pair
          ): pair is { drawn: SVGPolygonElement; target: SVGPolygonElement } =>
            pair.drawn !== null &&
            pair.target !== null &&
            pair.target.style.display !== 'none'
        );
    }

    it('gives every drawn corner a target that reaches past it', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);

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
      orientationRef.current?.update(ISOMETRIC);

      const corners = visibleCorners(container);
      expect(corners.length).toBe(4);
      for (const { drawn, target } of corners) {
        // The target is the surface the deeper cut takes off the corner, so
        // it holds the facet on glancing corners too — a planar deeper cut,
        // scaled about the apex, did not. Shrunk a hair toward its centroid
        // so a vertex on the target's own edge is tested strictly inside.
        const facet = polygonPoints(drawn);
        const [cx, cy] = facet
          .reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
          .map((sum) => sum / facet.length) as [number, number];
        for (const [x, y] of facet) {
          expect(
            contains(polygonPoints(target), [
              x + (cx - x) * 0.01,
              y + (cy - y) * 0.01
            ])
          ).toBe(true);
        }
        // The click still sits on the group, so the painted seam counts too.
        expect(drawn.parentElement).toBe(target.parentElement);
        expect(drawn.parentElement).toHaveClass('cube-corner-target');
      }
    });

    it('gives every isometric corner a target at least 24 px each way', () => {
      // Measured on the running widget before this target: 10×17 and 20×6 px
      // for the corners on the silhouette, which have a face turned away;
      // then 17×21 and 24×20 px (11 Oct 2026 review, G14) against the 24 px
      // minimum pointer target.
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);

      const corners = visibleCorners(container);
      expect(corners.length).toBe(4);
      for (const { target } of corners) {
        const points = polygonPoints(target);
        const xs = points.map(([x]) => x);
        const ys = points.map(([, y]) => y);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(24);
        expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(24);
      }
    });

    it('leaves every face the middle of itself around its label', () => {
      // The corners' area comes off the faces; each must still own a
      // generous region round its centre, where its label is drawn.
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);
      const targets = visibleCorners(container).map(({ target }) =>
        polygonPoints(target)
      );
      const faces = [
        ...container.querySelectorAll<SVGPolygonElement>('.cube-face')
      ].filter((face) => face.style.display !== 'none');
      expect(faces.length).toBe(3);
      for (const face of faces) {
        const outline = polygonPoints(face);
        const [cx, cy] = outline
          .reduce(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0])
          .map((sum) => sum / outline.length) as [number, number];
        // The centre and a ring 6 px round it: no corner claims any of it.
        for (let step = 0; step < 16; step += 1) {
          const angle = (step / 16) * Math.PI * 2;
          for (const point of [
            [cx, cy] as const,
            [cx + 6 * Math.cos(angle), cy + 6 * Math.sin(angle)] as const
          ]) {
            expect(targets.some((target) => contains(target, point))).toBe(
              false
            );
          }
        }
      }
    });

    it.each([
      ['isometric', ISOMETRIC],
      [
        'front',
        {
          x: { x: 1, y: 0, z: 0 },
          y: { x: 0, y: 0, z: -1 },
          z: { x: 0, y: -1, z: 0 }
        }
      ],
      [
        'oblique',
        {
          x: { x: 0.866, y: 0.25, z: 0.433 },
          y: { x: -0.5, y: 0.433, z: 0.75 },
          z: { x: 0, y: -0.866, z: 0.5 }
        }
      ]
    ] as const)(
      'never lets two corner targets claim one pixel (%s)',
      (_view, axes) => {
        const { container, orientationRef } = renderWidget();
        orientationRef.current?.update(axes);

        const targets = visibleCorners(container).map(({ target }) =>
          polygonPoints(target)
        );
        expect(targets.length).toBeGreaterThan(0);
        for (let x = 0.5; x < 88; x += 1) {
          for (let y = 0.5; y < 88; y += 1) {
            const claims = targets.filter((polygon) =>
              contains(polygon, [x, y])
            );
            expect(claims.length).toBeLessThan(2);
          }
        }
      }
    );

    it('takes the click from the drawn facet as well as the deeper cut', () => {
      const { container, orientationRef, onSelectView } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);

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

    it('takes the target away with the facet when a corner turns away', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);

      const facing = visibleCorners(container).map(
        ({ target }) => target.getAttribute('aria-label') ?? ''
      );
      expect(facing.length).toBeGreaterThan(0);

      // Same screen basis, opposite depth: every corner that was turned toward
      // the camera is now turned away, and vice versa.
      orientationRef.current?.update({
        x: { ...ISOMETRIC.x, z: -ISOMETRIC.x.z },
        y: { ...ISOMETRIC.y, z: -ISOMETRIC.y.z },
        z: { ...ISOMETRIC.z, z: -ISOMETRIC.z.z }
      });

      // An unpainted triangle left behind over a corner that has turned away
      // would swallow clicks meant for whatever face now covers that ground,
      // and being invisible there would be no way to tell why.
      const stillFacing = visibleCorners(container).map(
        ({ target }) => target.getAttribute('aria-label') ?? ''
      );
      for (const label of facing) {
        expect(stillFacing).not.toContain(label);
      }
      expect(stillFacing.length).toBeGreaterThan(0);
    });

    it('leaves the pointer with the target, not the facet it stands for', () => {
      const { container, orientationRef } = renderWidget();
      orientationRef.current?.update(ISOMETRIC);

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
      orientationRef.current?.update(ISOMETRIC);

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

describe('OrientationWidget controls', () => {
  it('keeps cube navigation without separate rotate buttons', () => {
    const { queryByRole, getByRole, orientationRef } = renderWidget();
    orientationRef.current?.update({
      x: { x: 0.70711, y: 0.40825, z: 0.57735 },
      y: { x: -0.70711, y: 0.40825, z: 0.57735 },
      z: { x: 0, y: -0.8165, z: 0.57735 }
    });
    expect(queryByRole('button', { name: /Rotate view/ })).toBeNull();
    expect(
      getByRole('group', { name: 'Drag to rotate the view' })
    ).toBeDefined();
    expect(getByRole('button', { name: 'Right view' })).toBeDefined();
  });
});

describe('OrientationWidget painted by the viewer', () => {
  const ISOMETRIC: AxisProjection = {
    x: { x: 0.70711, y: 0.40825, z: 0.57735 },
    y: { x: -0.70711, y: 0.40825, z: 0.57735 },
    z: { x: 0, y: -0.8165, z: 0.57735 }
  };
  /** The same view turned a little about the screen's vertical. */
  const TURNED: AxisProjection = {
    x: { x: 0.8, y: 0.35, z: 0.48 },
    y: { x: -0.6, y: 0.45, z: 0.66 },
    z: { x: 0, y: -0.8165, z: 0.57735 }
  };

  function attached() {
    const widget = renderWidget();
    const link = widget.orientationRef.current;
    if (!link) throw new Error('the widget published no link');
    const onChange = vi.fn();
    const release = link.attachOverlay(onChange);
    const svg = widget.container.querySelector('svg');
    if (!svg) throw new Error('no cube SVG');
    return { ...widget, link, onChange, release, svg };
  }

  it('stops painting the SVG while the viewer draws the cube', () => {
    const { svg, release } = attached();
    expect(svg.dataset.overlay).toBe('viewer');
    release();
    expect(svg.dataset.overlay).toBeUndefined();
  });

  it('writes nothing to the page while the camera keeps turning', () => {
    vi.useFakeTimers();
    try {
      const { link, face } = attached();
      // The first turn after a rest lands at once.
      link.update(ISOMETRIC);
      const resting = face.getAttribute('points');
      expect(resting).toBeTruthy();

      // Frames that follow it are an orbit: the hit layer holds still, which
      // is the point — Firefox repaints the page for any DOM change.
      link.update(TURNED);
      vi.advanceTimersByTime(HIT_LAYER_SETTLE_MS / 2);
      link.update(ISOMETRIC);
      vi.advanceTimersByTime(HIT_LAYER_SETTLE_MS / 2);
      link.update(TURNED);
      expect(face.getAttribute('points')).toBe(resting);

      // Once the camera rests, the facets are where they are drawn again.
      vi.advanceTimersByTime(HIT_LAYER_SETTLE_MS);
      expect(face.getAttribute('points')).not.toBe(resting);
    } finally {
      vi.useRealTimers();
    }
  });

  it('catches up the moment a pointer moves over the cube', () => {
    vi.useFakeTimers();
    try {
      const { link, face } = attached();
      link.update(ISOMETRIC);
      const resting = face.getAttribute('points');
      link.update(TURNED);
      expect(face.getAttribute('points')).toBe(resting);

      // A hand reaching for a cube still gliding to a view finds the facets
      // where they are drawn, without waiting for the glide to end.
      pointerMove(face, 9, 'mouse', 30, 30);
      expect(face.getAttribute('points')).not.toBe(resting);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the viewer which facet the pointer is over', () => {
    const { link, onChange, face, container } = attached();
    link.update(ISOMETRIC);

    fireEvent.pointerOver(face);
    expect(link.highlight.hovered).toEqual({ kind: 'face', index: 0 });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Either half of a corner's target lights the corner it stands for.
    const target = container.querySelector<SVGPolygonElement>(
      '.cube-corner-target:not([style*="none"]) .cube-corner-hit'
    );
    const visibleTarget = [
      ...container.querySelectorAll<SVGPolygonElement>('.cube-corner-hit')
    ].find((element) => element.style.display !== 'none');
    fireEvent.pointerOver(visibleTarget ?? target ?? face);
    expect(link.highlight.hovered?.kind).toBe('corner');

    fireEvent.pointerLeave(container.querySelector('svg')!);
    expect(link.highlight.hovered).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('paints the SVG again, up to date, once the viewer lets go', () => {
    vi.useFakeTimers();
    try {
      const { link, face, release } = attached();
      link.update(ISOMETRIC);
      const resting = face.getAttribute('points');
      link.update(TURNED);
      release();
      expect(face.getAttribute('points')).not.toBe(resting);
      // Unattached, every turn lands at once, as it always did.
      link.update(ISOMETRIC);
      expect(face.getAttribute('points')).toBe(resting);
    } finally {
      vi.useRealTimers();
    }
  });
});
