import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';
import { buildSketchRelationGlyphs, probeLength } from './sketchRelations';

// The XZ plane at y = 5: plane (10, 0) is world (10, 5, 0).
const basis = {
  origin: { x: 0, y: 5, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 0, z: -1 },
  normal: { x: 0, y: 1, z: 0 }
};

const bottom: SketchRelationGlyphChip = {
  key: 'object:bottom',
  placement: 'object',
  anchor: { x: 10, y: 0 },
  normal: { x: 0, y: 1 },
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
      conflicted: true,
      selected: true
    }
  ]
};

/** Looking straight down the plane normal: plane +u is screen right, +v up. */
function topCamera() {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 100);
  camera.position.set(10, 30, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(10, 5, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

describe('sketch relation glyph overlay', () => {
  it('places one chip per cluster on the sketch plane, a button per relation', () => {
    const overlay = buildSketchRelationGlyphs([bottom], basis);
    const labels = overlay.group.children.filter(
      (child): child is CSS2DObject => child instanceof CSS2DObject
    );
    expect(labels).toHaveLength(1);
    const label = labels[0]!;
    expect(label.position.toArray()).toEqual([10, 5, 0]);
    expect(label.element.dataset.placement).toBe('object');
    const marks = [
      ...label.element.querySelectorAll<HTMLButtonElement>(
        'button.sketch-relation-glyph'
      )
    ];
    expect(
      marks.map((mark) => [
        mark.textContent,
        mark.dataset.kind,
        mark.dataset.constraintId,
        mark.dataset.conflicted ?? null,
        mark.getAttribute('aria-pressed'),
        mark.getAttribute('aria-label'),
        mark.tabIndex
      ])
    ).toEqual([
      ['—', 'horizontal', 'c1', null, 'false', 'Horizontal relation', -1],
      [
        '∥',
        'parallel',
        'c2',
        'true',
        'true',
        'Parallel relation · solver residual',
        -1
      ]
    ]);
    expect(marks[1]!.dataset.selected).toBe('true');
    // The 3D pick never lands on a chip; its own buttons take the click.
    expect(label.raycast).not.toBe(CSS2DObject.prototype.raycast);
    overlay.dispose();
    expect(overlay.group.children).toHaveLength(0);
  });

  it('selects the clicked relation without the press reaching the host', () => {
    const select = vi.fn();
    const overlay = buildSketchRelationGlyphs([bottom], basis, select);
    const host = document.createElement('div');
    const label = overlay.group.children[0] as CSS2DObject;
    host.append(label.element);
    const hostPress = vi.fn();
    host.addEventListener('pointerdown', hostPress);
    host.addEventListener('click', hostPress);
    const mark = label.element.querySelector<HTMLButtonElement>(
      '[data-constraint-id="c1"]'
    )!;
    mark.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    mark.click();
    expect(select).toHaveBeenCalledWith('c1');
    expect(hostPress).not.toHaveBeenCalled();
    overlay.dispose();
  });

  it('stands a chip off its curve on the projected normal and rewrites nothing on a still frame', () => {
    const overlay = buildSketchRelationGlyphs([bottom], basis);
    const element = (overlay.group.children[0] as CSS2DObject).element;
    const setProperty = vi.spyOn(element.style, 'setProperty');
    const camera = topCamera();
    overlay.layout(camera, 400, 400);
    expect(setProperty).toHaveBeenCalledTimes(1);
    const [property, value] = setProperty.mock.calls[0]!;
    expect(property).toBe('translate');
    // Plane +v (the line's upper side) is screen up: the chip rises straight
    // off the line by its standoff plus half its height, and does not slide.
    const [dx, dy] = String(value)
      .split(' ')
      .map((part) => parseFloat(part));
    expect(dx).toBe(0);
    expect(dy).toBeLessThanOrEqual(-(6 + 8));
    overlay.layout(camera, 400, 400);
    expect(setProperty).toHaveBeenCalledTimes(1);
    overlay.dispose();
  });

  it('sizes the direction probe from the chips, not their distance from the origin', () => {
    const far = (x: number, y: number): SketchRelationGlyphChip => ({
      ...bottom,
      key: `object:${x}`,
      anchor: { x, y }
    });
    // A 10-unit sketch a billion units out: a span-sized probe, not a
    // million-unit one.
    const length = probeLength([far(1e9, 1e9), far(1e9 + 10, 1e9)], basis);
    expect(length).toBeGreaterThan(1e-3);
    expect(length).toBeLessThan(10);
    // A lone chip still gets a nonzero probe.
    expect(probeLength([far(0, 0)], basis)).toBeGreaterThan(0);
  });

  it('keeps the standoff direction for a far-off sketch under an orbited perspective camera', () => {
    // Plane (1e9, 1e9) is world (1e9, 5, -1e9). The chip stands off along
    // plane -v, world +z: toward a camera tilted back over it, so a probe a
    // million units long would land behind the camera and flip.
    const chip: SketchRelationGlyphChip = {
      ...bottom,
      anchor: { x: 1e9, y: 1e9 },
      normal: { x: 0, y: -1 }
    };
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(1e9, 30, -1e9 + 20);
    camera.lookAt(1e9, 5, -1e9);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const overlay = buildSketchRelationGlyphs([chip], basis);
    const element = (overlay.group.children[0] as CSS2DObject).element;
    overlay.layout(camera, 400, 400);
    const [dx, dy] = element.style
      .getPropertyValue('translate')
      .split(' ')
      .map((part) => parseFloat(part));
    // Ground truth: the screen direction of a tiny step along the normal.
    const screen = (z: number) => {
      const point = new THREE.Vector3(1e9, 5, z).project(camera);
      return { x: point.x * 200 + 200, y: -point.y * 200 + 200 };
    };
    const from = screen(-1e9);
    const to = screen(-1e9 + 1e-3);
    expect(dx! * (to.x - from.x) + dy! * (to.y - from.y)).toBeGreaterThan(0);
    overlay.dispose();
  });
});
