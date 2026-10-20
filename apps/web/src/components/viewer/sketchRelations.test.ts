import { describe, expect, it } from 'vitest';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildSketchRelationGlyphs } from './sketchRelations';

describe('sketch relation glyph overlay', () => {
  it('places one decorative, click-through chip per cluster on the sketch plane', () => {
    const overlay = buildSketchRelationGlyphs(
      [
        {
          key: 'object:bottom',
          placement: 'object',
          anchor: { x: 10, y: 0 },
          glyphs: [
            {
              constraintId: 'c1',
              kind: 'horizontal',
              symbol: '—',
              label: 'Horizontal',
              conflicted: false
            },
            {
              constraintId: 'c2',
              kind: 'parallel',
              symbol: '∥',
              label: 'Parallel',
              conflicted: true
            }
          ]
        }
      ],
      // The XZ plane at y = 5: plane (10, 0) is world (10, 5, 0).
      {
        origin: { x: 0, y: 5, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 0, z: -1 },
        normal: { x: 0, y: 1, z: 0 }
      }
    );
    const labels = overlay.group.children.filter(
      (child): child is CSS2DObject => child instanceof CSS2DObject
    );
    expect(labels).toHaveLength(1);
    const label = labels[0]!;
    expect(label.position.toArray()).toEqual([10, 5, 0]);
    expect(label.element.getAttribute('aria-hidden')).toBe('true');
    expect(label.element.dataset.placement).toBe('object');
    const marks = [
      ...label.element.querySelectorAll<HTMLElement>('.sketch-relation-glyph')
    ];
    expect(
      marks.map((mark) => [
        mark.textContent,
        mark.dataset.kind,
        mark.dataset.constraintId,
        mark.dataset.conflicted ?? null
      ])
    ).toEqual([
      ['—', 'horizontal', 'c1', null],
      ['∥', 'parallel', 'c2', 'true']
    ]);
    // Picks pass through to the geometry underneath.
    expect(label.raycast).not.toBe(CSS2DObject.prototype.raycast);
    overlay.dispose();
    expect(overlay.group.children).toHaveLength(0);
  });
});
