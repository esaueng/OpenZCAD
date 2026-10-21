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

function stage(
  panels: 'none' | 'docked' | 'unpinned' | 'phone' = 'none'
) {
  const area = document.createElement('div');
  area.className = 'viewer-area';
  const canvas = placed(document.createElement('canvas'), 0, 0, 1024, 768);
  area.append(canvas);
  const lane = document.createElement('div');
  lane.className = 'stage-right';
  // The lane itself spans the stage's right side even when empty; only what
  // is in it covers the canvas.
  placed(lane, 664, 60, 960, 660);
  if (panels === 'phone') {
    const phone = document.createElement('div');
    phone.className = 'panel-lane-float';
    lane.append(placed(phone, 664, 60, 960, 660));
  }
  area.append(lane);
  // The dock's layer spans the stage; only its columns cover anything.
  const layer = document.createElement('div');
  layer.className = 'panel-dock-layer';
  placed(layer, 0, 60, 1024, 660);
  if (panels === 'docked') {
    const column = document.createElement('div');
    column.className = 'panel-column';
    layer.append(placed(column, 718, 60, 1014, 660));
  }
  if (panels === 'unpinned') {
    const unpinned = document.createElement('div');
    unpinned.className = 'panel-unpinned';
    layer.append(placed(unpinned, 666, 60, 962, 660));
  }
  area.append(layer);
  const rail = document.createElement('div');
  rail.className = 'instrument-rail';
  area.append(
    panels === 'docked'
      ? placed(rail, 668, 200, 708, 560)
      : placed(rail, 972, 200, 1012, 560)
  );
  document.body.append(area);
  return canvas;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('measureFitFrame', () => {
  it('stops the fit short of the docked column and the rail inside it', () => {
    const frame = measureFitFrame(stage('docked'));
    expect(frame?.minX).toBe(-1);
    expect(frame?.maxX).toBeCloseTo(((668 - 12) / 1024) * 2 - 1, 12);
  });

  it('stops the fit short of an open unpinned panel', () => {
    const frame = measureFitFrame(stage('unpinned'));
    expect(frame?.maxX).toBeCloseTo(((666 - 12) / 1024) * 2 - 1, 12);
  });

  it('stops the fit short of the phone lane panel', () => {
    const frame = measureFitFrame(stage('phone'));
    expect(frame?.maxX).toBeCloseTo(((664 - 12) / 1024) * 2 - 1, 12);
  });

  it('frames to the rail alone when no panel is drawn', () => {
    // A closed, hidden or suspended panel is not rendered, so the empty
    // dock layer and the empty lane leave no stale obstacle.
    const frame = measureFitFrame(stage('none'));
    expect(frame?.maxX).toBeCloseTo(((972 - 12) / 1024) * 2 - 1, 12);
  });

  it('frames the whole canvas outside the workspace', () => {
    const canvas = placed(document.createElement('canvas'), 0, 0, 800, 600);
    document.body.append(canvas);
    expect(measureFitFrame(canvas)).toBeUndefined();
  });
});
