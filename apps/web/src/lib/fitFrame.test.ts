import { afterEach, describe, expect, it } from 'vitest';
import { measureFitFrame, measurePickFrame, shiftIntoFrame } from './fitFrame';

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

function stage(panels: 'none' | 'docked' | 'unpinned' | 'phone' = 'none') {
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

describe('measurePickFrame', () => {
  it('keeps a pick clear of the open tool fold as well as the card', () => {
    const canvas = stage('docked');
    const column = placed(document.createElement('div'), 10, 260, 50, 590);
    column.className = 'workspace-column-float';
    // The fold hangs outside the column's own box.
    const fold = placed(document.createElement('div'), 60, 260, 304, 740);
    fold.className = 'command-flyout';
    column.append(fold);
    canvas.closest('.viewer-area')!.append(column);
    const frame = measurePickFrame(canvas)!;
    expect(frame.minX).toBeCloseTo(((304 + 12) / 1024) * 2 - 1, 12);
    expect(frame.maxX).toBeCloseTo(((668 - 12) / 1024) * 2 - 1, 12);
    // Narrower than Fit would frame into, but a profile fits in it.
    expect(measureFitFrame(canvas)?.minX).toBeCloseTo(
      ((50 + 12) / 1024) * 2 - 1,
      12
    );
  });
});

describe('shiftIntoFrame', () => {
  const canvas = { left: 0, top: 0, right: 1000, bottom: 800 };
  // Clear from 100px to 600px: a card over the right of the stage.
  const frame = { minX: -0.8, maxX: 0.2, minY: -1, maxY: 1 };
  const at = (left: number, right: number) => ({
    left,
    top: 200,
    right,
    bottom: 300
  });

  it('leaves a target that is already clear where it is', () => {
    expect(shiftIntoFrame(at(200, 400), canvas, frame)).toBe(0);
    expect(shiftIntoFrame(at(200, 400), canvas, undefined)).toBe(0);
  });

  it('moves a target under the card left just far enough to clear it', () => {
    expect(shiftIntoFrame(at(550, 700), canvas, frame)).toBeCloseTo(-100);
  });

  it('moves a target under the left column right', () => {
    expect(shiftIntoFrame(at(40, 160), canvas, frame)).toBeCloseTo(60);
  });

  it('centres a target wider than the clear band', () => {
    expect(shiftIntoFrame(at(300, 900), canvas, frame)).toBeCloseTo(-250);
  });

  it('keeps only the core of a target wider than the band clear', () => {
    // The region spans the stage; its arrow is under the card.
    expect(shiftIntoFrame(at(0, 900), canvas, frame, at(560, 680))).toBeCloseTo(
      -80
    );
    // Its arrow already clear, nothing moves.
    expect(shiftIntoFrame(at(0, 900), canvas, frame, at(300, 400))).toBe(0);
  });
});
