import { describe, expect, it, vi } from 'vitest';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Vector3 } from 'three';
import { buildSketchDimensions } from './sketchDimensions';

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
});
