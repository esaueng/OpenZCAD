import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  chooseViewportScale,
  DEFAULT_SCALE_BAR_MAX_WIDTH_PX,
  formatViewportScale,
  scaleBarAnchor
} from './scale';

describe('viewport scale indicator', () => {
  it('chooses conventional 1/2/5 spans within the visual width budget', () => {
    const zoomLevels = [0.00001, 0.01, 0.05, 0.1, 1, 1000];

    for (const worldUnitsPerPixel of zoomLevels) {
      const scale = chooseViewportScale(worldUnitsPerPixel);
      expect(scale).not.toBeNull();
      expect(scale!.widthPx).toBeLessThanOrEqual(
        DEFAULT_SCALE_BAR_MAX_WIDTH_PX + 1e-9
      );
      expect(scale!.widthPx).toBeGreaterThanOrEqual(80 - 1e-9);

      const exponent = Math.floor(Math.log10(scale!.value));
      const normalized = scale!.value / 10 ** exponent;
      expect([1, 2, 5]).toContain(normalized);
    }
  });

  it('updates the represented distance as the viewport zoom changes', () => {
    expect(chooseViewportScale(0.1)?.value).toBeCloseTo(20);
    expect(chooseViewportScale(0.01)?.value).toBeCloseTo(2);
    expect(chooseViewportScale(1)?.value).toBeCloseTo(200);
  });

  it('rejects invalid camera scales instead of displaying stale precision', () => {
    expect(chooseViewportScale(0)).toBeNull();
    expect(chooseViewportScale(Number.NaN)).toBeNull();
    expect(chooseViewportScale(Number.POSITIVE_INFINITY)).toBeNull();
    expect(chooseViewportScale(0.1, 0)).toBeNull();
  });

  it('formats document units compactly', () => {
    expect(formatViewportScale(10, 'mm')).toBe('10 mm');
    expect(formatViewportScale(0.005, 'mm')).toBe('0.005 mm');
    expect(formatViewportScale(2, 'inch')).toBe('2 in');
    expect(formatViewportScale(0.00001, 'mm')).toBe('1e-5 mm');
  });
});

describe('scale bar anchor', () => {
  const camera = new THREE.Vector3(0, -200, 0);
  const forward = new THREE.Vector3(0, 1, 0);
  const modelCenter = new THREE.Vector3(10, 20, 5);
  const heightPx = 700;
  const fov = 45;
  const worldPerPixel = (point: THREE.Vector3) =>
    (2 *
      camera.distanceTo(point) *
      Math.tan(THREE.MathUtils.degToRad(fov / 2))) /
    heightPx;

  it('measures on the view axis at the model centre depth', () => {
    const anchor = scaleBarAnchor(
      camera,
      forward,
      modelCenter,
      new THREE.Vector3(0, 0, 0)
    );
    expect(anchor.toArray()).toEqual([0, 20, 0]);
  });

  it('keeps the bar when a pick moves the orbit pivot', () => {
    // A face pick pivots the orbit on the picked point's depth while the
    // camera stays still; the bar must read the same before and after.
    const before = chooseViewportScale(
      worldPerPixel(
        scaleBarAnchor(camera, forward, modelCenter, new THREE.Vector3())
      )
    );
    const after = chooseViewportScale(
      worldPerPixel(
        scaleBarAnchor(
          camera,
          forward,
          modelCenter,
          new THREE.Vector3(0, -150, 0)
        )
      )
    );
    expect(after).toEqual(before);
    // Measured at the pivot, as before the fix, the same pick changed it.
    expect(
      chooseViewportScale(worldPerPixel(new THREE.Vector3(0, -150, 0)))
    ).not.toEqual(chooseViewportScale(worldPerPixel(new THREE.Vector3())));
  });

  it('falls back to the orbit pivot without a model in front', () => {
    const pivot = new THREE.Vector3(0, 40, 0);
    expect(scaleBarAnchor(camera, forward, null, pivot)).toBe(pivot);
    const behind = new THREE.Vector3(0, -300, 0);
    expect(scaleBarAnchor(camera, forward, behind, pivot)).toBe(pivot);
  });
});
