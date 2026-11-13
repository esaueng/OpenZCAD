import { afterEach, describe, expect, it } from 'vitest';
import {
  cornersWithinFrame,
  measureClearStage,
  measureCreationFrame,
  measureFitFrame,
  measureOpeningFrame,
  measurePickFrame,
  shiftIntoFrame
} from './fitFrame';

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

  it('frames between the header and a phone editing sheet', () => {
    const canvas = stage();
    const app = document.createElement('div');
    app.className = 'app-shell';
    const header = placed(document.createElement('header'), 0, 0, 1024, 60);
    header.className = 'topbar';
    app.append(header, canvas.closest('.viewer-area')!);
    document.body.append(app);
    const sheet = placed(document.createElement('aside'), 10, 360, 1014, 720);
    sheet.className = 'tweak-flyouts';
    canvas.parentElement!.append(sheet);
    const frame = measureFitFrame(canvas)!;
    expect(frame.maxY).toBeCloseTo(1 - (72 / 768) * 2);
    expect(frame.minY).toBeCloseTo(1 - (348 / 768) * 2);
    expect(frame.maxX).toBeCloseTo(((972 - 12) / 1024) * 2 - 1);
  });

  it('does not reserve space for the covered, inert dock column', () => {
    const canvas = stage('docked');
    const column = canvas
      .closest('.viewer-area')!
      .querySelector<HTMLElement>('.panel-column')!;
    column.style.visibility = 'hidden';
    column.setAttribute('inert', '');
    const frame = measureFitFrame(canvas)!;
    expect(frame.maxX).toBeCloseTo(((668 - 12) / 1024) * 2 - 1);
  });
});

describe('measureOpeningFrame', () => {
  /** A phone's stage: a 52px rail each side, 10px in from the edge. */
  function phoneStage({ covered = false, width = 390 } = {}) {
    const reveal = document.createElement('div');
    reveal.className = 'workspace-reveal';
    // The cover hides by visibility and is inert, and the panels under it
    // inherit both.
    if (covered) {
      reveal.style.visibility = 'hidden';
      reveal.setAttribute('inert', '');
    }
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, width, 844);
    const column = document.createElement('div');
    column.className = 'workspace-column-float';
    const rail = document.createElement('div');
    rail.className = 'instrument-rail';
    // Covered, the instrument rail is 16px into its slide in from the
    // edge, which its rectangle includes.
    const slide = covered ? 16 : 0;
    if (covered) rail.style.translate = '16px 0px';
    area.append(
      canvas,
      placed(column, 10, 196, 62, 750),
      placed(rail, width - 62 + slide, 164, width - 10 + slide, 637)
    );
    reveal.append(area);
    document.body.append(reveal);
    return canvas;
  }

  it('opens a phone’s model between its rails', () => {
    const frame = measureOpeningFrame(phoneStage());
    expect(frame?.minX).toBeCloseTo(((62 + 12) / 390) * 2 - 1, 12);
    expect(frame?.maxX).toBeCloseTo(((328 - 12) / 390) * 2 - 1, 12);
  });

  it('reads the rails through the cover a project opens under', () => {
    // The first fit is made before the workspace is revealed. Read as
    // hidden, the rails left the whole canvas, and both ends of the part
    // opened under them.
    const canvas = phoneStage({ covered: true });
    expect(measureFitFrame(canvas)).toBeUndefined();
    const frame = measureOpeningFrame(canvas);
    expect(frame?.minX).toBeCloseTo(((62 + 12) / 390) * 2 - 1, 12);
    // Where the rail stands once its entry motion ends.
    expect(frame?.maxX).toBeCloseTo(((328 - 12) / 390) * 2 - 1, 12);
  });

  it('still leaves out a panel that is inert or hidden under the cover', () => {
    const canvas = phoneStage({ covered: true });
    const rail = canvas
      .closest('.viewer-area')!
      .querySelector<HTMLElement>('.instrument-rail')!;
    rail.setAttribute('inert', '');
    expect(measureOpeningFrame(canvas)?.maxX).toBe(1);
    rail.removeAttribute('inert');
    rail.style.display = 'none';
    expect(measureOpeningFrame(canvas)?.maxX).toBe(1);
  });

  it('opens a docked tablet’s model clear of its column and rail too', () => {
    // I6: at 768×1024 the docked column (462–758) and the rail beside it
    // (418–458) hid the bracket's boss and second hole, because only a
    // phone opened into the clear stage.
    const reveal = document.createElement('div');
    reveal.className = 'workspace-reveal';
    reveal.style.visibility = 'hidden';
    reveal.setAttribute('inert', '');
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 768, 1024);
    const column = document.createElement('div');
    column.className = 'panel-column';
    const layer = document.createElement('div');
    layer.className = 'panel-dock-layer';
    layer.append(placed(column, 462, 60, 758, 1014));
    const rail = document.createElement('div');
    rail.className = 'instrument-rail';
    const tools = document.createElement('div');
    tools.className = 'workspace-column-float';
    area.append(
      canvas,
      layer,
      placed(rail, 418, 262, 458, 812),
      placed(tools, 10, 334, 50, 738)
    );
    reveal.append(area);
    document.body.append(reveal);
    const frame = measureOpeningFrame(canvas)!;
    expect(frame.minX).toBeCloseTo(((50 + 12) / 768) * 2 - 1, 12);
    expect(frame.maxX).toBeCloseTo(((418 - 12) / 768) * 2 - 1, 12);
    // With the Tools drawer open too, 109px are left: the drawer is let
    // cover the model, never the whole canvas given up.
    const drawer = document.createElement('div');
    drawer.className = 'workspace-column-float';
    canvas.closest('.viewer-area')!.append(placed(drawer, 50, 62, 285, 898));
    const withDrawer = measureOpeningFrame(canvas)!;
    expect(withDrawer.minX).toBeCloseTo(((50 + 12) / 768) * 2 - 1, 12);
    expect(withDrawer.maxX).toBeCloseTo(((418 - 12) / 768) * 2 - 1, 12);
  });
});

describe('measureClearStage', () => {
  function workspaceStage() {
    const workspace = document.createElement('main');
    workspace.className = 'workspace';
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 1440, 900);
    const rail = document.createElement('div');
    rail.className = 'instrument-rail';
    area.append(canvas, placed(rail, 1380, 200, 1420, 700));
    workspace.append(area);
    document.body.append(workspace);
    return { workspace, area, canvas };
  }

  it('frames above the assistant’s stream, which stands outside the viewer', () => {
    // I6: the proposal card said "in the viewport" while the stream
    // (446–993 × 442–890 at 1440) covered most of the preview.
    const { workspace, canvas } = workspaceStage();
    const stream = document.createElement('section');
    stream.className = 'assistant-panel';
    workspace.append(placed(stream, 446, 442, 993, 890));
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.bottom).toBe(442 - 12);
    expect(stage.rect.right).toBe(1380 - 12);
    expect(stage.frame!.minY).toBeCloseTo(1 - ((442 - 12) / 900) * 2, 12);
    // Off screen (a direct-manipulation mode), it covers nothing.
    stream.classList.add('assistant-off-screen');
    expect(measureClearStage(canvas)!.rect.bottom).toBe(900);
  });

  it('takes a band off the top for a flyout standing over the middle', () => {
    const { area, canvas } = workspaceStage();
    const flyout = document.createElement('div');
    flyout.setAttribute('data-rail-flyout', '');
    area.append(placed(flyout, 600, 60, 900, 280));
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.top).toBe(280 + 12);
    expect(stage.rect.left).toBe(0);
  });

  it('reads a band that would leave a sliver as a side panel', () => {
    const { area, canvas } = workspaceStage();
    const flyout = document.createElement('div');
    flyout.setAttribute('data-rail-flyout', '');
    // Centred low enough that framing above it would leave under a third.
    area.append(placed(flyout, 600, 200, 900, 640));
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.top).toBe(0);
    expect(stage.rect.bottom).toBe(900);
    expect(stage.rect.right).toBe(600 - 12);
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

describe('measureCreationFrame', () => {
  function withLane(canvas: HTMLElement, top: number) {
    const workspace = document.createElement('div');
    workspace.className = 'workspace';
    workspace.append(canvas.closest('.viewer-area')!);
    const lane = placed(document.createElement('div'), 300, top, 700, 758);
    lane.className = 'command-bar-lane';
    workspace.append(lane);
    document.body.append(workspace);
    return canvas;
  }

  it('keeps a creation preview above the command bar as well as inside the panels', () => {
    const frame = measureCreationFrame(withLane(stage('docked'), 650));
    expect(frame.minX).toBe(-1);
    expect(frame.maxX).toBeCloseTo(((668 - 12) / 1024) * 2 - 1, 12);
    expect(frame.maxY).toBe(1);
    expect(frame.minY).toBeCloseTo(1 - ((650 - 12) / 768) * 2, 12);
  });

  it('is the fit frame where no bottom lane is drawn', () => {
    const canvas = stage('docked');
    expect(measureCreationFrame(canvas)).toEqual(measureFitFrame(canvas));
  });

  it('is the whole canvas outside the workspace', () => {
    const canvas = placed(document.createElement('canvas'), 0, 0, 800, 600);
    document.body.append(canvas);
    expect(measureCreationFrame(canvas)).toEqual({
      minX: -1,
      maxX: 1,
      minY: -1,
      maxY: 1
    });
  });

  it('does not frame above a lane that takes most of the stage', () => {
    // A phone's sheet: framing into the sliver above it would shrink the
    // preview to nothing.
    const canvas = stage();
    const frame = measureCreationFrame(withLane(canvas, 120));
    expect(frame.minY).toBe(-1);
  });
});

describe('cornersWithinFrame', () => {
  const frame = { minX: -0.4, maxX: 0.6, minY: -0.5, maxY: 1 };
  const corner = (x: number, y: number, z = 0) => ({ x, y, z });

  it('holds a box whose corners are all inside the clear stage', () => {
    expect(
      cornersWithinFrame([corner(-0.4, -0.5), corner(0.6, 1)], frame)
    ).toBe(true);
  });

  it('reports a box that runs under a panel, the bar or past the canvas', () => {
    expect(cornersWithinFrame([corner(0, 0), corner(0.7, 0)], frame)).toBe(
      false
    );
    expect(cornersWithinFrame([corner(0, -0.6)], frame)).toBe(false);
    expect(cornersWithinFrame([corner(-0.5, 0)], frame)).toBe(false);
  });

  it('counts a corner behind the camera or past the far plane as outside', () => {
    expect(cornersWithinFrame([corner(0, 0, 1.2)], frame)).toBe(false);
    expect(cornersWithinFrame([corner(0, 0, -1.2)], frame)).toBe(false);
  });

  it('insets by a share of the frame, so a margin asks for more room', () => {
    // Half-sizes 0.5 and 0.75: a 0.2 margin insets 0.1 and 0.15.
    expect(cornersWithinFrame([corner(0.55, 0)], frame, 0.2)).toBe(false);
    expect(cornersWithinFrame([corner(0.5, 0.85)], frame, 0.2)).toBe(true);
    expect(cornersWithinFrame([corner(0, 0.9)], frame, 0.2)).toBe(false);
  });
});
