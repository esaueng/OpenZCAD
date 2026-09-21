import { describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Vector3 } from 'three';
import {
  avoidSketchDimensionOverlays,
  buildSketchDimensions
} from './sketchDimensions';

describe('sketch dimension overlay', () => {
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

  it('moves a persisted label clear of an occupied viewport rail', () => {
    const root = document.createElement('div');
    const container = document.createElement('div');
    const rail = document.createElement('div');
    const label = document.createElement('button');
    rail.className = 'viewer-rail-stack';
    label.className = 'sketch-dimension-label';
    root.append(container, rail);
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

    avoidSketchDimensionOverlays(container, root);

    const placed = label.getBoundingClientRect();
    expect(
      placed.right <= 400 ||
        placed.left >= 500 ||
        placed.bottom <= 100 ||
        placed.top >= 200
    ).toBe(true);
    expect(label.style.marginLeft !== '' || label.style.marginTop !== '').toBe(
      true
    );
    root.remove();
  });
});
