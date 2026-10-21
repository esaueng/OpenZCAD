import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';
import {
  OBSTACLE_REFRESH_MS,
  buildSketchRelationGlyphs
} from './sketchRelations';

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
    const translates = () =>
      setProperty.mock.calls.filter(([property]) => property === 'translate');
    expect(translates()).toHaveLength(1);
    const [property, value] = translates()[0]!;
    expect(property).toBe('translate');
    // Plane +v (the line's upper side) is screen up: the chip rises straight
    // off the line by its standoff plus half its height, and does not slide.
    const [dx, dy] = String(value)
      .split(' ')
      .map((part) => parseFloat(part));
    expect(dx).toBe(0);
    expect(dy).toBeLessThanOrEqual(-(6 + 8));
    const calls = setProperty.mock.calls.length;
    overlay.layout(camera, 400, 400);
    expect(setProperty).toHaveBeenCalledTimes(calls);
    overlay.dispose();
  });

  it.each([1e9, 1e12])(
    'keeps the standoff direction for a sketch at %d under a close, tilted perspective camera',
    (far) => {
      // Plane (far, far) is world (far, 5, -far). The chip stands off along
      // plane -v, world +z: partly toward a camera 20 units away and tilted
      // back over it. Any probe point long enough to survive rounding at this
      // magnitude would cross the eye plane and flip; the clip-space
      // derivative has no probe.
      const chip: SketchRelationGlyphChip = {
        ...bottom,
        anchor: { x: far, y: far },
        normal: { x: 0, y: -1 }
      };
      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
      camera.position.set(far, 30, -far + 20);
      camera.lookAt(far, 5, -far);
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      const overlay = buildSketchRelationGlyphs([chip], basis);
      const element = (overlay.group.children[0] as CSS2DObject).element;
      overlay.layout(camera, 400, 400);
      const [dx, dy] = element.style
        .getPropertyValue('translate')
        .split(' ')
        .map((part) => parseFloat(part));
      // The anchor is at the screen centre and world +z leans toward the
      // camera's bottom edge: the chip drops straight down the screen.
      expect(dx).toBe(0);
      expect(dy).toBeGreaterThan(0);
      overlay.dispose();
    }
  );

  it("measures the viewer area's floating controls and keeps glyphs from under them", () => {
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const layer = document.createElement('div');
    const rail = document.createElement('div');
    rail.className = 'viewer-rail';
    area.append(layer, rail);
    document.body.append(area);
    const rect = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({})
      }) as DOMRect;
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(
      rect(0, 0, 400, 400)
    );
    // The rail sits right over the bottom line's preferred spot: the chip
    // above the line's middle (screen 200, 200).
    vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue(
      rect(150, 150, 100, 46)
    );
    const overlay = buildSketchRelationGlyphs([bottom], basis);
    const element = (overlay.group.children[0] as CSS2DObject).element;
    expect(overlay.refreshObstacles(layer)).toBe(true);
    // Nothing moved: a second measurement reports no change.
    expect(overlay.refreshObstacles(layer)).toBe(false);
    overlay.layout(topCamera(), 400, 400);
    const [dx, dy] = element.style
      .getPropertyValue('translate')
      .split(' ')
      .map((part) => parseFloat(part));
    const left = 200 + dx! - 17;
    const top = 200 + dy! - 8;
    const clear =
      left + 34 <= 150 || left >= 250 || top + 16 <= 150 || top >= 196;
    expect(clear).toBe(true);
    overlay.dispose();
    area.remove();
  });

  it('re-measures the viewport controls on its own timer and draws only on a change', () => {
    vi.useFakeTimers();
    try {
      const area = document.createElement('div');
      area.className = 'viewer-area';
      const layer = document.createElement('div');
      const flyout = document.createElement('div');
      flyout.className = 'sketch-flyouts';
      area.append(layer, flyout);
      document.body.append(area);
      const box = (left: number, width: number) =>
        ({
          left,
          top: 100,
          right: left + width,
          bottom: 200,
          width,
          height: 100,
          x: left,
          y: 100,
          toJSON: () => ({})
        }) as DOMRect;
      vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(box(0, 400));
      const flyoutBox = vi
        .spyOn(flyout, 'getBoundingClientRect')
        .mockReturnValue(box(0, 0));
      const changed = vi.fn();
      const overlay = buildSketchRelationGlyphs([bottom], basis);
      // Closed flyout: nothing to keep out of, so nothing to draw.
      overlay.watchObstacles(layer, changed);
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(OBSTACLE_REFRESH_MS * 3);
      expect(changed).not.toHaveBeenCalled();
      // It opens while the scene is idle: the next tick asks for one frame.
      flyoutBox.mockReturnValue(box(150, 100));
      vi.advanceTimersByTime(OBSTACLE_REFRESH_MS);
      expect(changed).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(OBSTACLE_REFRESH_MS * 3);
      expect(changed).toHaveBeenCalledTimes(1);
      // Disposed overlays stop measuring.
      overlay.dispose();
      flyoutBox.mockReturnValue(box(0, 0));
      vi.advanceTimersByTime(OBSTACLE_REFRESH_MS * 3);
      expect(changed).toHaveBeenCalledTimes(1);
      area.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps glyphs off the dimension labels beside them, every frame', () => {
    // A driving dimension's label centred on the same line middle the
    // horizontal relation's chip would stand above (screen 200, 200).
    const boxes = vi.fn(
      (
        out: Float64Array,
        at: number,
        _camera: THREE.Camera,
        _width: number,
        _height: number
      ) => {
        out.set([160, 170, 240, 200], at);
        return 1;
      }
    );
    const overlay = buildSketchRelationGlyphs([bottom], basis);
    const element = (overlay.group.children[0] as CSS2DObject).element;
    overlay.layout(topCamera(), 400, 400, {
      labelCount: 1,
      writeLabelBoxes: boxes
    });
    expect(boxes).toHaveBeenCalledTimes(1);
    const [dx, dy] = element.style
      .getPropertyValue('translate')
      .split(' ')
      .map((part) => parseFloat(part));
    const left = 200 + dx! - 17;
    const top = 200 + dy! - 8;
    expect(
      left + 34 <= 160 || left >= 240 || top + 16 <= 170 || top >= 200
    ).toBe(true);
    overlay.dispose();
  });

  it('leaves a chip whose anchor is off the viewport where it is', () => {
    const camera = topCamera();
    // Plane (200, 0) is far right of the 100-unit-wide view.
    const overlay = buildSketchRelationGlyphs(
      [{ ...bottom, anchor: { x: 200, y: 0 } }],
      basis
    );
    const element = (overlay.group.children[0] as CSS2DObject).element;
    overlay.layout(camera, 400, 400);
    expect(element.style.getPropertyValue('translate')).toBe('0px 0px');
    overlay.dispose();
  });
});
