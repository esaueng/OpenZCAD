import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { OrthographicCamera, Vector3 } from 'three';
import {
  avoidSketchDimensionOverlays,
  buildSketchDimensions
} from './sketchDimensions';

describe('sketch dimension overlay', () => {
  it('never edits a reference value on click or keyboard activation; moves its tagged identity only', () => {
    const edit = vi.fn();
    const move = vi.fn();
    const overlay = buildSketchDimensions(
      [
        {
          id: 'sref_radius',
          identity: { kind: 'reference', annotationId: 'sref_radius' as never },
          kind: 'radius',
          label: '(R 5 mm)',
          anchor: { x: 2, y: 3 },
          baseAnchor: { x: 2, y: 3 },
          lines: []
        }
      ],
      {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 }
      },
      { width: 1000, height: 700 },
      edit,
      (x, y) => ({ x: x / 10, y: y / 10 }),
      move
    );
    const label = overlay.group.children.find(
      (child) => child instanceof CSS2DObject
    ) as CSS2DObject;
    document.body.append(label.element);
    expect(label.element.getAttribute('aria-label')).toBe(
      'Reference radius, (R 5 mm)'
    );
    expect(label.element.dataset.constraintId).toBeUndefined();
    label.element.click();
    fireEvent.keyDown(label.element, { key: 'Enter' });
    fireEvent.keyDown(label.element, { key: ' ' });
    expect(edit).not.toHaveBeenCalled();
    fireEvent.keyDown(label.element, { key: 'ArrowRight' });
    expect(move).toHaveBeenLastCalledWith(
      { kind: 'reference', annotationId: 'sref_radius' },
      { x: 1, y: 0 }
    );
    fireEvent.pointerDown(label.element, {
      pointerId: 1,
      button: 0,
      clientX: 20,
      clientY: 30
    });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 60, clientY: 90 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(move).toHaveBeenLastCalledWith(
      { kind: 'reference', annotationId: 'sref_radius' },
      { x: 4, y: 6 }
    );
    expect(edit).not.toHaveBeenCalled();
    overlay.dispose();
  });
  it('maps an offset YZ sketch into world space, edits its identity, and disposes labels', () => {
    const edit = vi.fn();
    const overlay = buildSketchDimensions(
      [
        {
          id: 'constraint_distance',
          kind: 'distance',
          label: '5 mm',
          anchor: { x: 2.5, y: 1 },
          span: { start: { x: 0, y: 1 }, end: { x: 5, y: 1 } },
          lines: [
            [
              { x: 0, y: 0 },
              { x: 0, y: 1 }
            ]
          ]
        }
      ],
      {
        origin: { x: 7, y: 0, z: 0 },
        u: { x: 0, y: 1, z: 0 },
        v: { x: 0, y: 0, z: 1 },
        normal: { x: 1, y: 0, z: 0 }
      },
      { width: 1000, height: 700 },
      edit
    );
    const label = overlay.group.children.find(
      (child) => child instanceof CSS2DObject
    ) as CSS2DObject;
    expect(label.position).toEqual(new Vector3(7, 2.5, 1));
    document.body.appendChild(label.element);
    const bubble = vi.fn();
    document.body.addEventListener('click', bubble);
    label.element.click();
    expect(edit).toHaveBeenCalledWith('constraint_distance', { x: 0, y: 0 });
    expect(bubble).not.toHaveBeenCalled();
    const scale = vi.fn(() => 2);
    overlay.update(scale);
    expect(scale).toHaveBeenCalledWith(new Vector3(7, 0, 1));
    overlay.dispose();
    expect(label.element.isConnected).toBe(false);
    expect(overlay.group.children).toHaveLength(0);
    document.body.removeEventListener('click', bubble);
  });

  it('allows a new click after a canceled drag sequence', () => {
    const edit = vi.fn();
    const move = vi.fn();
    const overlay = buildSketchDimensions(
      [
        {
          id: 'constraint_distance',
          kind: 'distance',
          label: '5 mm',
          anchor: { x: 2.5, y: 1 },
          baseAnchor: { x: 2.5, y: 1 },
          span: { start: { x: 0, y: 1 }, end: { x: 5, y: 1 } },
          lines: []
        }
      ],
      {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 }
      },
      { width: 1000, height: 700 },
      edit,
      (x, y) => ({ x: x / 10, y: y / 10 }),
      move
    );
    const label = overlay.group.children.find(
      (child) => child instanceof CSS2DObject
    ) as CSS2DObject;
    document.body.appendChild(label.element);

    fireEvent.pointerDown(label.element, {
      pointerId: 7,
      button: 0,
      clientX: 100,
      clientY: 100
    });
    fireEvent.pointerMove(document, {
      pointerId: 7,
      clientX: 160,
      clientY: 130
    });
    fireEvent.pointerCancel(document, { pointerId: 7 });
    fireEvent.click(label.element);

    expect(move).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith('constraint_distance', { x: 0, y: 0 });
    overlay.dispose();
  });

  it.each([
    'topbar-island',
    'viewer-rail-stack',
    'workspace-column-float',
    'sketch-flyouts',
    // The model panels: a docked column, the unpinned panel, the phone lane.
    'panel-column',
    'panel-unpinned',
    'panel-lane-float'
  ])(
    'moves a persisted label clear of an occupied %s beside the viewport',
    (className) => {
      const root = document.createElement('div');
      root.className = 'app-shell';
      const host = document.createElement('div');
      host.className = 'viewer-area';
      const container = document.createElement('div');
      const rail = document.createElement('div');
      const label = document.createElement('button');
      rail.className = className;
      label.className = 'sketch-dimension-label';
      root.append(host, rail);
      host.append(container);
      container.append(label);
      document.body.appendChild(root);
      Object.defineProperty(container, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 0,
          right: 500,
          top: 0,
          bottom: 400,
          width: 500,
          height: 400
        })
      });
      Object.defineProperty(rail, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          left: 400,
          right: 500,
          top: 100,
          bottom: 200,
          width: 100,
          height: 100
        })
      });
      Object.defineProperty(label, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const marginLeft = parseFloat(label.style.marginLeft) || 0;
          const marginTop = parseFloat(label.style.marginTop) || 0;
          return {
            left: 390 + marginLeft,
            right: 490 + marginLeft,
            top: 120 + marginTop,
            bottom: 145 + marginTop,
            width: 100,
            height: 25
          };
        }
      });

      avoidSketchDimensionOverlays(
        container,
        className === 'topbar-island' ? host : root
      );

      const placed = label.getBoundingClientRect();
      expect(
        placed.right <= 400 ||
          placed.left >= 500 ||
          placed.bottom <= 100 ||
          placed.top >= 200
      ).toBe(true);
      expect(
        label.style.marginLeft !== '' || label.style.marginTop !== ''
      ).toBe(true);
      root.remove();
    }
  );

  it('reports each on-screen label box for the relation glyphs to keep clear of', () => {
    const overlay = buildSketchDimensions(
      [
        {
          id: 'c_distance',
          kind: 'distance',
          label: '40 mm',
          anchor: { x: 10, y: 0 },
          lines: []
        },
        {
          id: 'c_far',
          kind: 'distance',
          label: '20 mm',
          anchor: { x: 10, y: 0 },
          lines: []
        }
      ],
      {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        normal: { x: 0, y: 0, z: 1 }
      },
      { width: 400, height: 400 },
      () => {}
    );
    const [first, second] = overlay.group.children.filter(
      (child): child is CSS2DObject => child instanceof CSS2DObject
    );
    for (const label of [first!, second!]) {
      Object.defineProperty(label.element, 'offsetWidth', { value: 60 });
      Object.defineProperty(label.element, 'offsetHeight', { value: 22 });
    }
    // The second label was shifted clear of a control by the overlay clamp.
    second!.element.style.marginTop = '30px';
    // Looking down -z at the plane: plane (10, 0) is the screen centre.
    const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 100);
    camera.position.set(10, 0, 30);
    camera.lookAt(10, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    expect(overlay.labelCount).toBe(2);
    const out = new Float64Array(12).fill(-1);
    expect(overlay.writeLabelBoxes(out, 4, camera, 400, 400)).toBe(2);
    expect([...out]).toEqual([
      -1, -1, -1, -1, 170, 189, 230, 211, 170, 219, 230, 241
    ]);
    overlay.dispose();
  });

  it('re-measures a label whose size changes, as when its web font arrives', () => {
    // Capture the overlay's ResizeObserver so the test can fire it.
    let fire: ((entries: { target: Element }[]) => void) | null = null;
    const observed: Element[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: { target: Element }[]) => void) {
          fire = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {
          fire = null;
        }
      }
    );
    try {
      const overlay = buildSketchDimensions(
        [
          {
            id: 'c_distance',
            kind: 'distance',
            label: '40 mm',
            anchor: { x: 10, y: 0 },
            lines: []
          }
        ],
        {
          origin: { x: 0, y: 0, z: 0 },
          u: { x: 1, y: 0, z: 0 },
          v: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 }
        },
        { width: 400, height: 400 },
        () => {}
      );
      const label = overlay.group.children.find(
        (child): child is CSS2DObject => child instanceof CSS2DObject
      )!;
      expect(observed).toEqual([label.element]);
      let width = 50;
      Object.defineProperty(label.element, 'offsetWidth', {
        get: () => width
      });
      Object.defineProperty(label.element, 'offsetHeight', { value: 20 });
      const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 100);
      camera.position.set(10, 0, 30);
      camera.lookAt(10, 0, 0);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      const resized = vi.fn();
      overlay.onLabelResize(resized);
      const out = new Float64Array(4);
      overlay.writeLabelBoxes(out, 0, camera, 400, 400);
      expect(out[2]! - out[0]!).toBe(50);
      // The font swaps in: wider, but the cached size holds until observed.
      width = 64;
      overlay.writeLabelBoxes(out, 0, camera, 400, 400);
      expect(out[2]! - out[0]!).toBe(50);
      fire!([{ target: label.element }]);
      expect(resized).toHaveBeenCalledTimes(1);
      overlay.writeLabelBoxes(out, 0, camera, 400, 400);
      expect(out[2]! - out[0]!).toBe(64);
      overlay.dispose();
      expect(fire).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
