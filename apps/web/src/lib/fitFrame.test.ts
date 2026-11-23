import { afterEach, describe, expect, it } from 'vitest';
import {
  cornersClearOfStage,
  cornersWithinFrame,
  guideShapesClearStage,
  measureClearStage,
  measureClearStageRequestFrame,
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

  it('frames above View’s measurement sheet across a phone’s foot', () => {
    const { area, canvas } = workspaceStage();
    const shell = document.createElement('section');
    shell.className = 'viewer-shell';
    const sheet = document.createElement('section');
    sheet.className = 'measurement-dock';
    shell.append(placed(sheet, 10, 600, 1430, 860));
    area.append(shell);
    expect(measureClearStage(canvas)!.rect.bottom).toBe(600 - 12);
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

describe('the modeling guide', () => {
  function phoneStage() {
    const workspace = document.createElement('main');
    workspace.className = 'workspace';
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 390, 844);
    workspace.append(area);
    area.append(canvas);
    document.body.append(workspace);
    return { area, canvas };
  }
  function guide(
    area: HTMLElement,
    left: number,
    top: number,
    right: number,
    bottom: number
  ) {
    const card = document.createElement('section');
    card.className = 'workspace-tour';
    area.append(placed(card, left, top, right, bottom));
    return card;
  }

  it('frames a phone’s model above the guide standing across its middle', () => {
    // A 390 × 844 phone: the expanded guide stood over the new box it asked
    // to be tapped (preview check on #1951).
    const { area, canvas } = phoneStage();
    guide(area, 72, 405, 318, 655);
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.bottom).toBe(405 - 12);
    expect(stage.frame!.minY).toBeCloseTo(1 - ((405 - 12) / 844) * 2, 12);
    // A creation preview is kept above it too.
    expect(measureCreationFrame(canvas).minY).toBeCloseTo(
      1 - ((405 - 12) / 844) * 2,
      12
    );
  });

  it('follows the guide folded to its header', () => {
    const { area, canvas } = phoneStage();
    guide(area, 72, 610, 318, 655);
    expect(measureClearStage(canvas)!.rect.bottom).toBe(610 - 12);
  });

  it('asks a phone’s card and a desktop’s alike for a reframe', () => {
    const { area, canvas } = phoneStage();
    guide(area, 72, 405, 318, 655);
    expect(guideShapesClearStage(canvas)).toBe(true);
    document.body.replaceChildren();
    const desk = document.createElement('div');
    desk.className = 'viewer-area';
    const deskCanvas = placed(
      document.createElement('canvas'),
      0,
      0,
      768,
      1024
    );
    desk.append(deskCanvas);
    document.body.append(desk);
    guide(desk, 116, 700, 412, 960);
    expect(guideShapesClearStage(deskCanvas)).toBe(true);
  });

  it('frames a desktop’s model beside its corner card where that leaves more', () => {
    // 1440 × 900: above the card leaves 588 px of height, beside it the
    // whole height.
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 1440, 900);
    area.append(canvas);
    document.body.append(area);
    guide(area, 72, 600, 368, 840);
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.left).toBe(368 + 12);
    expect(stage.rect.bottom).toBe(900);
  });

  it('frames a desktop’s model above a minimized guide’s header', () => {
    // 1600 × 900: the header from y 838 to 888 costs a 62 px band; beside
    // it would have given up a full-height strip (review on #1969).
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 1600, 900);
    area.append(canvas);
    document.body.append(area);
    guide(area, 116, 838, 412, 888);
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.bottom).toBe(838 - 12);
    expect(stage.rect.left).toBe(0);
  });

  it('frames a mouse’s 768 px model above the card where that leaves more', () => {
    // The undocked Build layout at 768: the 296 px card from x 116 to 412
    // leaves 344 px beside it and the full width above it.
    const area = document.createElement('div');
    area.className = 'viewer-area';
    const canvas = placed(document.createElement('canvas'), 0, 0, 768, 1024);
    area.append(canvas);
    document.body.append(area);
    guide(area, 116, 700, 412, 960);
    const stage = measureClearStage(canvas)!;
    expect(stage.rect.bottom).toBe(700 - 12);
    expect(stage.rect.left).toBe(0);
  });

  describe('in a corner, beside docked panels', () => {
    function tabletStage(width: number, height: number, column: number) {
      const area = document.createElement('div');
      area.className = 'viewer-area';
      const canvas = placed(
        document.createElement('canvas'),
        0,
        0,
        width,
        height
      );
      area.append(canvas);
      // The docked column the tablet keeps on its right.
      const layer = document.createElement('div');
      layer.className = 'panel-dock-layer';
      const docked = document.createElement('div');
      docked.className = 'panel-column';
      layer.append(placed(docked, column, 60, width, height));
      area.append(layer);
      document.body.append(area);
      return { area, canvas };
    }

    it('frames a portrait tablet’s model above its corner card', () => {
      // 768 × 1024: the 296 px card from x 116 to 412 stood over the new
      // box it asks to be tapped, beside the docked column.
      const { area, canvas } = tabletStage(768, 1024, 462);
      guide(area, 116, 606, 412, 845);
      const stage = measureClearStage(canvas)!;
      expect(stage.rect.bottom).toBe(606 - 12);
      expect(stage.rect.right).toBe(462 - 12);
    });

    it('frames a landscape tablet’s model beside its card where that leaves more', () => {
      // 1024 × 768: the card from y 350 left a 278 px band above it, and
      // 412 px beside it.
      const { area, canvas } = tabletStage(1024, 768, 864);
      guide(area, 124, 350, 420, 589);
      const stage = measureClearStage(canvas)!;
      expect(stage.rect.bottom).toBe(768);
      expect(stage.rect.left).toBe(420 + 12);
      expect(stage.rect.right).toBe(864 - 12);
    });

    it('never frames beside the card by letting a docked column go', () => {
      // 768 × 1024 with a left rail to x 104 and the column from x 462:
      // beside the card left 26 px, and letting the column go to widen it
      // framed the box behind the column (review on this change).
      const { area, canvas } = tabletStage(768, 1024, 462);
      const rail = document.createElement('div');
      rail.className = 'workspace-column-float';
      area.append(placed(rail, 0, 60, 104, 1024));
      guide(area, 116, 606, 412, 845);
      const stage = measureClearStage(canvas)!;
      expect(stage.rect.bottom).toBe(606 - 12);
      expect(stage.rect.right).toBe(462 - 12);
    });

    it('frames above the card past a floating panel standing below that band', () => {
      // The right panel floats from y 650 to 900, under the band above the
      // card: that band is clear of it, and wider than the stage beside it
      // (re-check on this change).
      const { area, canvas } = tabletStage(768, 1024, 462);
      area.querySelector('.panel-dock-layer')!.replaceChildren();
      const floating = document.createElement('div');
      floating.className = 'panel-unpinned';
      area
        .querySelector('.panel-dock-layer')!
        .append(placed(floating, 462, 650, 768, 900));
      guide(area, 116, 606, 412, 845);
      expect(measureClearStage(canvas)!.rect.bottom).toBe(606 - 12);
      expect(guideShapesClearStage(canvas)).toBe(true);
    });

    it('asks for a reframe only where the card changes the stage', () => {
      const { area, canvas } = tabletStage(768, 1024, 462);
      const card = guide(area, 116, 606, 412, 845);
      expect(guideShapesClearStage(canvas)).toBe(true);
      // Over the docked column, the card changes nothing: a request could
      // only undo the user's pan.
      placed(card, 470, 606, 766, 845);
      expect(guideShapesClearStage(canvas)).toBe(false);
    });

    it('leaves a card out that stands clear of the stage', () => {
      // The card under the docked column: nothing of the model's to cover.
      const { area, canvas } = tabletStage(1024, 768, 500);
      guide(area, 600, 350, 896, 589);
      expect(measureClearStage(canvas)!.rect.bottom).toBe(768);
    });
  });

  describe('cornersClearOfStage', () => {
    // 1440 × 900 with the card at x 72–368, y 600–840: the clear stage is
    // framed beside it, from x 380.
    function desk() {
      const workspace = document.createElement('main');
      workspace.className = 'workspace';
      const area = document.createElement('div');
      area.className = 'viewer-area';
      workspace.append(area);
      const canvas = placed(document.createElement('canvas'), 0, 0, 1440, 900);
      area.append(canvas);
      document.body.append(workspace);
      guide(area, 72, 600, 368, 840);
      return canvas;
    }
    /** The corners of a screen rectangle, in the canvas's NDC. */
    function box(left: number, top: number, right: number, bottom: number) {
      const points: ReadonlyArray<readonly [number, number]> = [
        [left, top],
        [right, top],
        [left, bottom],
        [right, bottom]
      ];
      return points.map(([x, y]) => ({
        x: (x / 1440) * 2 - 1,
        y: 1 - (y / 900) * 2,
        z: 0
      }));
    }

    it('holds a model above the card though the stage was framed beside it', () => {
      // Pressing Next reframed this (preview check on #1969).
      expect(cornersClearOfStage(desk(), box(100, 100, 500, 560))).toBe(true);
    });

    it('lets a model under the card be reframed', () => {
      expect(cornersClearOfStage(desk(), box(100, 400, 500, 700))).toBe(false);
    });

    it('lets a model past the canvas be reframed', () => {
      expect(cornersClearOfStage(desk(), box(900, 100, 1500, 500))).toBe(false);
    });

    it('lets a model beside the card but under the command bar be reframed', () => {
      // The stage without the card reaches the canvas's foot, over the
      // command bar's lane (review on #1974).
      const canvas = desk();
      const lane = document.createElement('div');
      lane.className = 'command-bar-lane';
      placed(lane, 0, 860, 1440, 900);
      // The bar it holds is centred, 520 px wide.
      const bar = document.createElement('div');
      bar.className = 'command-search';
      lane.append(placed(bar, 460, 860, 980, 900));
      canvas.closest('.workspace')!.append(lane);
      expect(cornersClearOfStage(canvas, box(375, 700, 600, 880))).toBe(false);
      // Past the bar's end, the lane is only a transparent wrapper (re-check
      // on #1974).
      expect(cornersClearOfStage(canvas, box(1000, 700, 1200, 880))).toBe(true);
    });

    it('lets a model under a panel the stage let go be reframed', () => {
      // 768 × 1024: the Tools drawer and the docked column leave too narrow
      // a gap, so the stage without the card lets the drawer go; a model
      // under it is still covered (review on #1974).
      const area = document.createElement('div');
      area.className = 'viewer-area';
      const canvas = placed(document.createElement('canvas'), 0, 0, 768, 1024);
      area.append(canvas);
      const drawer = document.createElement('div');
      drawer.className = 'workspace-column-float';
      area.append(placed(drawer, 0, 60, 420, 1000));
      const layer = document.createElement('div');
      layer.className = 'panel-dock-layer';
      const docked = document.createElement('div');
      docked.className = 'panel-column';
      layer.append(placed(docked, 462, 60, 768, 1024));
      area.append(layer);
      document.body.append(area);
      guide(area, 116, 606, 412, 845);
      const corners = [
        [75, 650],
        [105, 650],
        [75, 720],
        [105, 720]
      ].map(([x = 0, y = 0]) => ({
        x: (x / 768) * 2 - 1,
        y: 1 - (y / 1024) * 2,
        z: 0
      }));
      expect(cornersClearOfStage(canvas, corners)).toBe(false);
    });

    it('holds a model inside a panel’s gap, clear of the panel', () => {
      // A rail from x 1200: the stage keeps 12 px from it, and a model 7 px
      // clear of it read as covered (preview check on #1974).
      const canvas = desk();
      const rail = document.createElement('div');
      rail.className = 'instrument-rail';
      canvas
        .closest('.viewer-area')!
        .append(placed(rail, 1200, 100, 1240, 800));
      expect(cornersClearOfStage(canvas, box(900, 100, 1193, 500))).toBe(true);
      expect(cornersClearOfStage(canvas, box(900, 100, 1205, 500))).toBe(false);
    });

    it('judges a model by its outline, not its bounding rectangle', () => {
      // A diamond whose bounding rectangle (x 300–530, y 370–700) reaches
      // over the card's corner (x 72–368, y 600–840) while the diamond's
      // own edge passes x 390 at the card's top.
      const canvas = desk();
      const ndc = (x: number, y: number) => ({
        x: (x / 1440) * 2 - 1,
        y: 1 - (y / 900) * 2,
        z: 0
      });
      const diamond = [
        ndc(300, 450),
        ndc(450, 370),
        ndc(530, 450),
        ndc(450, 700)
      ];
      expect(cornersClearOfStage(canvas, diamond)).toBe(true);
      const over = [ndc(200, 620), ndc(450, 370), ndc(530, 450), ndc(450, 700)];
      expect(cornersClearOfStage(canvas, over)).toBe(false);
    });

    it('lets a model under the Tools drawer’s fold be reframed', () => {
      const canvas = desk();
      const fold = document.createElement('div');
      fold.className = 'command-flyout';
      canvas.closest('.viewer-area')!.append(placed(fold, 400, 60, 640, 700));
      expect(cornersClearOfStage(canvas, box(500, 100, 900, 500))).toBe(false);
    });

    it('holds a model inside the clear stage', () => {
      expect(cornersClearOfStage(desk(), box(500, 100, 900, 800))).toBe(true);
    });
  });

  it('frames as if it were not there where it would leave only a strip', () => {
    const { area, canvas } = phoneStage();
    guide(area, 72, 90, 318, 655);
    expect(measureClearStage(canvas)!.rect.bottom).toBe(844);
  });
});

describe('measurePickFrame', () => {
  it('reframes a clear-stage request clear of the open tool fold, Fit not', () => {
    // 1024 × 768 with the docked column: a guide's reframe landed the model
    // behind the Tools drawer (preview check on #1974). Fit, as before,
    // frames as if the passing fold were shut.
    const canvas = stage('docked');
    const column = placed(document.createElement('div'), 10, 260, 50, 590);
    column.className = 'workspace-column-float';
    const fold = placed(document.createElement('div'), 60, 260, 304, 740);
    fold.className = 'command-flyout';
    column.append(fold);
    canvas.closest('.viewer-area')!.append(column);
    expect(measureClearStageRequestFrame(canvas)!.minX).toBeCloseTo(
      ((304 + 12) / 1024) * 2 - 1,
      12
    );
    expect(measureFitFrame(canvas)!.minX).toBeCloseTo(
      ((50 + 12) / 1024) * 2 - 1,
      12
    );
  });

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
