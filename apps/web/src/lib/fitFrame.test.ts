import { afterEach, describe, expect, it } from 'vitest';
import { measureFitFrame } from './fitFrame';

function placed(
  element: HTMLElement,
  left: number,
  top: number,
  right: number,
  bottom: number
) {
  element.getBoundingClientRect = () => ({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({})
  });
  return element;
}

function stage(drawerOpen: boolean) {
  const area = document.createElement('div');
  area.className = 'viewer-area';
  const canvas = placed(document.createElement('canvas'), 0, 0, 1024, 768);
  area.append(canvas);
  const lane = document.createElement('div');
  lane.className = 'stage-right';
  // The lane itself spans the stage's right side even when empty; only what
  // is in it covers the canvas.
  placed(lane, 664, 60, 960, 660);
  if (drawerOpen) {
    const drawer = document.createElement('div');
    drawer.className = 'model-drawer-float';
    lane.append(placed(drawer, 664, 60, 960, 660));
  }
  area.append(lane);
  const rail = document.createElement('div');
  rail.className = 'instrument-rail';
  area.append(placed(rail, 972, 200, 1012, 560));
  document.body.append(area);
  return canvas;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('measureFitFrame', () => {
  it('stops the fit short of the open drawer', () => {
    const frame = measureFitFrame(stage(true));
    expect(frame?.minX).toBe(-1);
    expect(frame?.maxX).toBeCloseTo(((664 - 12) / 1024) * 2 - 1, 12);
  });

  it('frames to the rail alone when the lane is empty', () => {
    const frame = measureFitFrame(stage(false));
    expect(frame?.maxX).toBeCloseTo(((972 - 12) / 1024) * 2 - 1, 12);
  });

  it('frames the whole canvas outside the workspace', () => {
    const canvas = placed(document.createElement('canvas'), 0, 0, 800, 600);
    document.body.append(canvas);
    expect(measureFitFrame(canvas)).toBeUndefined();
  });
});
