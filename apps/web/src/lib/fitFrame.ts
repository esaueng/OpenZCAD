import {
  clearStageFrame,
  STAGE_FRAME_GAP_PX,
  STAGE_FRAME_MIN_CLEAR_FRACTION,
  type NdcFrame,
  type StageRect
} from '@openzcad/viewport';
import { SELECTION_CALLOUT_OBSTACLES } from './selectionCalloutView';

/**
 * What covers the stage as well as the panels a selection chip keeps out
 * from under: the flyouts the rails open (the section controls, the views),
 * the View and Tweak flyouts, and the measurement workbench View and Tweak
 * float over the stage (a phone's sheet across its foot). Build's
 * workbench is a command card, already in the right lane.
 */
const CLEAR_STAGE_OBSTACLES = `${SELECTION_CALLOUT_OBSTACLES}, .tweak-flyouts, .view-flyouts, [data-rail-flyout], .viewer-shell .measurement-dock`;

/**
 * The least share of the canvas's width a clear-stage request's side band
 * keeps, against Fit's quarter: beside a 1024 × 768 tablet's Tools drawer
 * there are 243 px, a quarter of the width less 13, and the reframe let the
 * drawer go and left the model behind it (preview check on #1974). In view
 * now beats large.
 */
const REQUEST_MIN_CLEAR_FRACTION = 0.2;

/**
 * Surfaces outside the viewer area that still stand over the canvas: the
 * assistant's stream rises from the prompt line over the model.
 */
const WORKSPACE_STAGE_OBSTACLES = '.assistant-panel:not(.assistant-off-screen)';

/**
 * The modeling guide's card. At a phone width it spans most of the stage,
 * over the model it asks to be tapped ("Select to edit"), and the model is
 * framed above it. Wider, its 296 px corner card stood over the new box
 * too (a 768 × 1024 or 1024 × 768 tablet, a 1280 × 800 desktop), and the
 * model is framed above or beside it, whichever leaves the larger area.
 */
const FOOT_GUIDE = '.workspace-tour';

/**
 * The compact workspace's sheet (U12) across the stage's foot, below full
 * height (at full the stage under it is inert, and nothing is framed). It
 * stands outside the viewer area, in the shell's own chrome. Measure's page
 * in it (I47) asks for the model to be framed above it.
 */
const COMPACT_SHEET = ".compact-sheet:not([hidden]):not([data-detent='full'])";

/**
 * Whether the modeling guide's card changes the clear stage on `canvas`: a
 * phone's across it, a wider stage's over its corner. The card asks for
 * the model to be framed clear of it only then; where it changes nothing
 * (a card standing over a docked column) a request could only undo the
 * user's own pan (review on #1969).
 */
export function guideShapesClearStage(canvas: HTMLElement): boolean {
  const withGuide = measureClearStage(canvas)?.rect;
  const without = measureClearStage(canvas, { ignoreGuide: true })?.rect;
  if (!withGuide || !without) return withGuide !== without;
  return (
    withGuide.left !== without.left ||
    withGuide.right !== without.right ||
    withGuide.top !== without.top ||
    withGuide.bottom !== without.bottom
  );
}

/**
 * Whether the modeling guide's card spans the stage as a phone's does:
 * wider than half of it. Shared with the card, which asks for the model to
 * be framed clear of it on the same terms.
 */
export function guideCoversStage(
  card: Pick<DOMRectReadOnly, 'left' | 'right'>,
  stage: Pick<DOMRectReadOnly, 'left' | 'right'>
): boolean {
  return card.right - card.left > (stage.right - stage.left) / 2;
}

/**
 * The least height the guide's band leaves the model. A shorter stage (a
 * phone held sideways) frames as if the guide were not there, rather than
 * fitting the part into a strip.
 */
const FOOT_GUIDE_MIN_BAND_PX = 96;

/**
 * A panel standing over the stage's middle takes a band off it only while
 * what it leaves is at least this share of the canvas height: framed into
 * less, the model would be a sliver.
 */
const CLEAR_STAGE_MIN_BAND_FRACTION = 1 / 3;

/**
 * The clear stage: the part of the viewport canvas that nothing is drawn
 * over — the canvas less the top bar, the docked and floating panels, the
 * right lane (command card, inspector), the rails and their flyouts, the
 * left column and the assistant's stream. One rectangle, measured the same
 * way for every caller that frames the model: a project opening, Fit, a
 * sketch re-entered, an assistant preview, a cut whose controls just
 * opened. `rect` is in CSS pixels (viewport coordinates); `frame` is the
 * same rectangle in the canvas's normalized device coordinates, undefined
 * when it is the whole canvas.
 *
 * A narrow panel at a side pushes that side in. A panel wider than half the
 * canvas, or one standing across its middle (the assistant's stream, the
 * section controls on a narrow stage), takes a band off the top or the
 * bottom instead, whichever half it stands in (for a panel over the middle,
 * only while what is left is a third of the height or more).
 */
export interface ClearStage {
  rect: StageRect;
  frame: NdcFrame | undefined;
}

export function measureClearStage(
  canvas: HTMLElement,
  {
    throughCover = false,
    ignoreGuide = false,
    request = false
  }: {
    throughCover?: boolean;
    ignoreGuide?: boolean;
    /** A clear-stage request's frame: side bands down to a fifth. */
    request?: boolean;
  } = {}
): ClearStage | undefined {
  const minClear = request
    ? REQUEST_MIN_CLEAR_FRACTION
    : STAGE_FRAME_MIN_CLEAR_FRACTION;
  const bounds = canvas.getBoundingClientRect();
  const panels = [
    ...panelsOver(canvas, CLEAR_STAGE_OBSTACLES, throughCover),
    ...panelsOver(canvas, WORKSPACE_STAGE_OBSTACLES, throughCover, '.workspace')
  ];
  const width = bounds.width;
  const height = bounds.height;
  if (!(width > 0) || !(height > 0)) return undefined;
  let top = bounds.top;
  let bottom = bounds.bottom;
  const topbar = canvas.closest('.app-shell')?.querySelector('.topbar');
  if (topbar)
    top = Math.max(
      top,
      topbar.getBoundingClientRect().bottom + STAGE_FRAME_GAP_PX
    );
  const middle = bounds.left + width / 2;
  const sides: StageRect[] = [];
  // Wide lower sheets and panels over the middle reserve height, while
  // narrow rails reserve width. Keep this UI projection local: the viewport
  // package's side-band API remains available unchanged to other consumers.
  for (const panel of panels) {
    const panelLeft = Math.max(panel.left, bounds.left);
    const panelRight = Math.min(panel.right, bounds.right);
    const panelTop = Math.max(panel.top, bounds.top);
    const panelBottom = Math.min(panel.bottom, bounds.bottom);
    const panelWidth = panelRight - panelLeft;
    const panelHeight = panelBottom - panelTop;
    if (!(panelWidth > 0) || !(panelHeight > 0)) continue;
    const wide = panelWidth > width / 2;
    const across = wide || (panelLeft < middle - 1 && panelRight > middle + 1);
    if (!across || panelHeight >= height / 2) {
      sides.push(panel);
      continue;
    }
    const lower = (panelTop + panelBottom) / 2 >= bounds.top + height / 2;
    const nextTop = lower
      ? top
      : Math.max(top, panelBottom + STAGE_FRAME_GAP_PX);
    const nextBottom = lower
      ? Math.min(bottom, panelTop - STAGE_FRAME_GAP_PX)
      : bottom;
    // A panel over the middle that would leave a sliver above or below it
    // is read as a side panel instead. A sheet across the stage (a phone's
    // Tweak sheet) always takes its band: there is no side to frame beside.
    if (
      !wide &&
      nextBottom - nextTop < height * CLEAR_STAGE_MIN_BAND_FRACTION
    ) {
      sides.push(panel);
      continue;
    }
    top = nextTop;
    bottom = nextBottom;
  }
  // The compact sheet across the foot takes its band, above the same
  // minimum the guide keeps: there is no side to frame beside it.
  for (const sheet of panelsOver(
    canvas,
    COMPACT_SHEET,
    throughCover,
    '.app-shell'
  )) {
    const nextBottom = Math.max(sheet.top, bounds.top) - STAGE_FRAME_GAP_PX;
    if (nextBottom < bottom && nextBottom - top >= FOOT_GUIDE_MIN_BAND_PX) {
      bottom = nextBottom;
    }
  }
  // The guide across the middle takes its band off the foot, however little
  // it leaves above a minimum: there is no side to frame beside it.
  for (const guide of ignoreGuide
    ? []
    : panelsOver(canvas, FOOT_GUIDE, throughCover)) {
    const across =
      guideCoversStage(guide, bounds) &&
      guide.left < middle - 1 &&
      guide.right > middle + 1;
    const guideTop = Math.max(guide.top, bounds.top);
    if (guideTop >= bottom) continue;
    const nextBottom = guideTop - STAGE_FRAME_GAP_PX;
    if (across) {
      if (nextBottom - top >= FOOT_GUIDE_MIN_BAND_PX) bottom = nextBottom;
      continue;
    }
    // A corner card: framed above it or beside it, whichever
    // leaves the larger area, and only where it stands in the stage. (The
    // larger square sent a minimized guide's 50 px header beside the
    // model, giving up a full-height strip for it: review on #1969.)
    const clear = (bandBottom: number, panels: readonly StageRect[]) => {
      const vertical = {
        left: bounds.left,
        right: bounds.right,
        top,
        bottom: bandBottom
      };
      const side = sideFrame(vertical, panels, minClear);
      return {
        left: bounds.left + (((side?.minX ?? -1) + 1) / 2) * width,
        right: bounds.left + (((side?.maxX ?? 1) + 1) / 2) * width,
        top,
        bottom: bandBottom
      };
    };
    const now = clear(bottom, sides);
    if (guide.right <= now.left || guide.left >= now.right) continue;
    // A candidate counts only where it reaches no panel the stage without
    // it keeps clear of: one that let a docked column go to clear the card
    // would frame the model behind the column instead. A panel below the
    // band above the card is one it does not reach.
    const reached = (rect: StageRect) =>
      sides.filter(
        (panel) =>
          Math.min(panel.right, rect.right) > Math.max(panel.left, rect.left) &&
          Math.min(panel.bottom, rect.bottom) > Math.max(panel.top, rect.top)
      );
    const alreadyReached = reached(now);
    const room = (rect: StageRect) =>
      reached(rect).every((panel) => alreadyReached.includes(panel))
        ? (rect.right - rect.left) * (rect.bottom - rect.top)
        : -Infinity;
    const above =
      nextBottom - top >= FOOT_GUIDE_MIN_BAND_PX
        ? room(clear(nextBottom, sides))
        : -Infinity;
    const besideRect = clear(bottom, [...sides, guide]);
    // Beside counts only where the guide is not the panel let go.
    const beside =
      besideRect.left >= guide.right || besideRect.right <= guide.left
        ? room(besideRect)
        : -Infinity;
    if (above === -Infinity && beside === -Infinity) continue;
    if (above >= beside) bottom = nextBottom;
    else sides.push(guide);
  }
  if (bottom <= top) return undefined;
  const verticalBounds = {
    left: bounds.left,
    right: bounds.right,
    top,
    bottom
  };
  const side = sideFrame(verticalBounds, sides, minClear);
  const frame =
    !side && top === bounds.top && bottom === bounds.bottom
      ? undefined
      : {
          minX: side?.minX ?? -1,
          maxX: side?.maxX ?? 1,
          minY: 1 - ((bottom - bounds.top) / height) * 2,
          maxY: 1 - ((top - bounds.top) / height) * 2
        };
  return {
    rect: {
      left: bounds.left + (((frame?.minX ?? -1) + 1) / 2) * width,
      right: bounds.left + (((frame?.maxX ?? 1) + 1) / 2) * width,
      top,
      bottom
    },
    frame
  };
}

/**
 * The band the side panels leave (`clearStageFrame`). Where they leave less
 * than it accepts, the panel whose absence widens the band most is let
 * cover the model instead, and so on, rather than giving the whole canvas
 * up: at 768px the Tools drawer and the docked column together left 109px,
 * and the bracket then opened under both (I6). The drawer is the one let go.
 */
function sideFrame(
  bounds: StageRect,
  sides: readonly StageRect[],
  minClearFraction = STAGE_FRAME_MIN_CLEAR_FRACTION
): NdcFrame | undefined {
  const band = (panels: readonly StageRect[]) => {
    const middle = (bounds.left + bounds.right) / 2;
    let left = bounds.left;
    let right = bounds.right;
    for (const panel of panels) {
      if (
        Math.min(panel.right, bounds.right) <= Math.max(panel.left, bounds.left)
      )
        continue;
      if ((panel.left + panel.right) / 2 < middle)
        left = Math.max(left, panel.right + STAGE_FRAME_GAP_PX);
      else right = Math.min(right, panel.left - STAGE_FRAME_GAP_PX);
    }
    return right - left;
  };
  let panels = [...sides];
  while (panels.length > 0) {
    const frame = clearStageFrame(
      bounds,
      panels,
      STAGE_FRAME_GAP_PX,
      minClearFraction
    );
    if (frame) return frame;
    // Undefined because nothing covers a side: the whole canvas it is.
    if (band(panels) >= bounds.right - bounds.left) return undefined;
    let drop = 0;
    let widest = -Infinity;
    panels.forEach((_, index) => {
      const width = band(panels.filter((__, other) => other !== index));
      if (width > widest) {
        widest = width;
        drop = index;
      }
    });
    panels = panels.filter((_, index) => index !== drop);
  }
  return undefined;
}

/**
 * The part of the viewport canvas that Fit frames into: the clear stage
 * (`measureClearStage`) in normalized device coordinates. Undefined means
 * the whole canvas.
 */
export function measureFitFrame(
  canvas: HTMLElement,
  options: {
    throughCover?: boolean;
    ignoreGuide?: boolean;
    request?: boolean;
  } = {}
): NdcFrame | undefined {
  return measureClearStage(canvas, options)?.frame;
}

/**
 * The frame a clear-stage request reframes the model into: what Fit frames
 * into, keeping a side band down to a fifth of the width (beside a 1024 ×
 * 768 tablet's Tools drawer), and less the command bar's lane, as a
 * creation frame is (a reframe left a corner under the bar: review on
 * #1983). Undefined means the whole canvas.
 */
export function measureClearStageRequestFrame(
  canvas: HTMLElement
): NdcFrame | undefined {
  const frame = measureFitFrame(canvas, { request: true });
  const full = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  const cut = aboveCommandLane(canvas, frame ?? full);
  return cut.minY === full.minY &&
    cut.maxY === full.maxY &&
    cut.minX === full.minX &&
    cut.maxX === full.maxX
    ? undefined
    : cut;
}

/**
 * Whether a clear-stage request should leave a model whose bounding box
 * projects to `corners` (normalized device coordinates on `canvas`) where it
 * is: on the canvas, with its outline (the convex hull of its projected
 * corners) off whatever covers the canvas that the request's frame
 * (`measureClearStageRequestFrame`) keeps clear of: the top bar, the
 * panels, the guide's card, the command bar. The clear stage is one
 * rectangle kept a gap from each panel, so a model beside a card framed
 * above it (preview check on #1969), or 7 px clear of a rail inside that
 * gap (preview check on #1974), read as covered and was reframed. A cover
 * the frame cannot keep clear of (a phone's Tools drawer, wider than half
 * the stage; a tablet's in portrait, beside its docked column) does not
 * count: a reframe would land the model behind it all the same (review on
 * #1983).
 */
export function cornersClearOfStage(
  canvas: HTMLElement,
  corners: readonly { x: number; y: number; z: number }[]
): boolean {
  const frame = measureClearStageRequestFrame(canvas);
  if (!frame) return true;
  // On the canvas and between the near and far planes.
  if (!cornersWithinFrame(corners, { minX: -1, maxX: 1, minY: -1, maxY: 1 })) {
    return false;
  }
  const bounds = canvas.getBoundingClientRect();
  const outline = convexHull(
    corners.map((corner) => ({
      x: bounds.left + ((corner.x + 1) / 2) * bounds.width,
      y: bounds.top + ((1 - corner.y) / 2) * bounds.height
    }))
  );
  const target = {
    left: bounds.left + ((frame.minX + 1) / 2) * bounds.width,
    right: bounds.left + ((frame.maxX + 1) / 2) * bounds.width,
    top: bounds.top + ((1 - frame.maxY) / 2) * bounds.height,
    bottom: bounds.top + ((1 - frame.minY) / 2) * bounds.height
  };
  // Off everything drawn over the canvas: the card, every panel the clear
  // stage measures, the top bar, and the command bar's lane, which a
  // request's frame keeps out as a creation frame does (review on #1974).
  const topbar = canvas
    .closest('.app-shell')
    ?.querySelector('.topbar')
    ?.getBoundingClientRect();
  const covers = [
    ...(topbar ? [topbar] : []),
    ...panelsOver(canvas, FOOT_GUIDE),
    ...panelsOver(canvas, CLEAR_STAGE_OBSTACLES),
    ...panelsOver(canvas, WORKSPACE_STAGE_OBSTACLES, false, '.workspace'),
    ...panelsOver(canvas, COMPACT_SHEET, false, '.app-shell'),
    // The lane is a transparent full-width column; what it holds (the
    // command's bar, the search row) is centred and as wide as it reads.
    ...panelsOver(canvas, '.command-bar-lane > *', false, '.workspace')
  ];
  return covers
    .filter(
      (cover) =>
        cover.right <= target.left ||
        cover.left >= target.right ||
        cover.bottom <= target.top ||
        cover.top >= target.bottom
    )
    .every((cover) => !outlineMeetsRect(outline, cover));
}

type ScreenPoint = { x: number; y: number };

/** The convex hull of `points`, in order around it (monotone chain). */
function convexHull(points: readonly ScreenPoint[]): ScreenPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: readonly ScreenPoint[]) => {
    const chain: ScreenPoint[] = [];
    for (const point of list) {
      while (
        chain.length >= 2 &&
        cross(chain[chain.length - 2]!, chain[chain.length - 1]!, point) <= 0
      ) {
        chain.pop();
      }
      chain.push(point);
    }
    chain.pop();
    return chain;
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Whether a convex outline and a rectangle share any area: separated along
 * neither screen axis nor any edge of the outline (separating axes).
 */
function outlineMeetsRect(
  outline: readonly ScreenPoint[],
  rect: Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>
): boolean {
  if (outline.length === 0) return false;
  const corners: ScreenPoint[] = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { x: rect.left, y: rect.bottom }
  ];
  const axes: ScreenPoint[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    ...outline.map((point, index) => {
      const next = outline[(index + 1) % outline.length]!;
      return { x: next.y - point.y, y: point.x - next.x };
    })
  ];
  return axes.every((axis) => {
    if (axis.x === 0 && axis.y === 0) return true;
    const project = (point: ScreenPoint) => point.x * axis.x + point.y * axis.y;
    const outlineSpan = outline.map(project);
    const rectSpan = corners.map(project);
    return (
      Math.min(...outlineSpan) < Math.max(...rectSpan) &&
      Math.min(...rectSpan) < Math.max(...outlineSpan)
    );
  });
}

/**
 * The frame a model's first fit lands in: the clear stage, read through the
 * cover the workspace opens under. A phone's two rails stand over a third of
 * its width, and a tablet's or a laptop's docked panels over as much again
 * (I6: at 768×1024 the docked column hid the bracket's boss and second
 * hole), so every width opens the part where it can be seen.
 */
export function measureOpeningFrame(canvas: HTMLElement): NdcFrame | undefined {
  // The first fit is made while the workspace is still covered, so the
  // rails are read through the cover.
  return measureFitFrame(canvas, { throughCover: true });
}

/**
 * The clear stage a picked target is kept in: what Fit frames into, less the
 * tool palette's open fold too, which hangs outside the column's box. Any
 * band counts — a profile and its arrow fit in far less than a model needs.
 */
export function measurePickFrame(canvas: HTMLElement): NdcFrame | undefined {
  return clearStageFrame(
    canvas.getBoundingClientRect(),
    panelsOver(canvas, `${SELECTION_CALLOUT_OBSTACLES}, .command-flyout`),
    STAGE_FRAME_GAP_PX,
    0
  );
}

/**
 * The stage a creation preview is kept in: what Fit frames into, less the
 * bottom lane too, where the command's own bar (its Done) and the search
 * row stand over the model. A preview sized past it is reframed into it.
 * Always a frame, the whole canvas when nothing covers it.
 */
export function measureCreationFrame(canvas: HTMLElement): NdcFrame {
  return aboveCommandLane(
    canvas,
    measureFitFrame(canvas) ?? { minX: -1, maxX: 1, minY: -1, maxY: 1 }
  );
}

/**
 * `frame` less the bottom lane, where the command's own bar and the search
 * row stand over the model, unless that leaves under a third of it.
 */
function aboveCommandLane(canvas: HTMLElement, frame: NdcFrame): NdcFrame {
  const bounds = canvas.getBoundingClientRect();
  if (!(bounds.height > 0)) return frame;
  const lanes = [
    ...(canvas
      .closest('.workspace')
      ?.querySelectorAll<HTMLElement>('.command-bar-lane') ?? [])
  ]
    .map((lane) => lane.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (lanes.length === 0) return frame;
  const laneTop = Math.min(...lanes.map((rect) => rect.top));
  const minY =
    1 - ((laneTop - STAGE_FRAME_GAP_PX - bounds.top) / bounds.height) * 2;
  // A lane that leaves less than a third of the frame's height is not a
  // band to frame above (a phone's sheet): the frame stays as it was.
  return minY > frame.minY && frame.maxY - minY >= (frame.maxY - frame.minY) / 3
    ? { ...frame, minY }
    : frame;
}

/**
 * Whether every projected corner (normalized device coordinates, +Y up, `z`
 * the clip depth) lies inside `frame`, inset by `margin` of the frame's own
 * half-size on each side, and between the near and far planes.
 */
export function cornersWithinFrame(
  corners: readonly { x: number; y: number; z: number }[],
  frame: NdcFrame,
  margin = 0
): boolean {
  const insetX = ((frame.maxX - frame.minX) / 2) * margin;
  const insetY = ((frame.maxY - frame.minY) / 2) * margin;
  return corners.every(
    (corner) =>
      corner.x >= frame.minX + insetX &&
      corner.x <= frame.maxX - insetX &&
      corner.y >= frame.minY + insetY &&
      corner.y <= frame.maxY - insetY &&
      corner.z >= -1 &&
      corner.z <= 1
  );
}

/**
 * The rectangles of the panels drawn over `canvas`. While its project opens,
 * the workspace is laid out at its final size under a cover
 * (`.workspace-reveal`: hidden by `visibility` and inert, both of which every
 * panel inherits) and its rails are still sliding in. `throughCover` reads
 * the panels as they will stand once it lifts: neither state of the cover
 * counts against them, and each is taken where its entry motion ends.
 */
function panelsOver(
  canvas: HTMLElement,
  selector: string,
  throughCover = false,
  scope = '.viewer-area'
): StageRect[] {
  const cover = throughCover ? canvas.closest('.workspace-reveal') : null;
  const covered =
    cover !== null && getComputedStyle(cover).visibility === 'hidden';
  return [
    ...(canvas.closest(scope)?.querySelectorAll<HTMLElement>(selector) ?? [])
  ].flatMap((panel) => {
    const style = getComputedStyle(panel);
    if (style.display === 'none') return [];
    if (!covered && style.visibility === 'hidden') return [];
    const inert = panel.closest('[inert]');
    // Inert of its own, or from something inside the cover: not drawn.
    if (inert && !(covered && inert.contains(cover))) return [];
    const rect = panel.getBoundingClientRect();
    if (!covered) return [rect];
    // The rails enter on `translate` (mode-in-*, view-mode.css), which the
    // rectangle includes and which is gone by the time anyone looks.
    const [dx = 0, dy = 0] = (style.translate ?? '')
      .split(/\s+/)
      .map((part) => Number.parseFloat(part) || 0);
    return [
      {
        left: rect.left - dx,
        right: rect.right - dx,
        top: rect.top - dy,
        bottom: rect.bottom - dy
      }
    ];
  });
}

/**
 * The sideways move, in CSS pixels, that brings `target` (a screen
 * rectangle) into the clear band of `frame` on `canvas`: the smallest one
 * that fits it. A target wider than the band keeps only its `core` (what
 * must be reachable in it) clear, by the smallest move again, and a core
 * wider still is centred. Zero when nothing needs to move, or when nothing
 * covers the canvas.
 */
export function shiftIntoFrame(
  target: StageRect,
  canvas: StageRect,
  frame: NdcFrame | undefined,
  core: StageRect = target
): number {
  if (!frame) {
    return 0;
  }
  const width = canvas.right - canvas.left;
  const left = canvas.left + ((frame.minX + 1) / 2) * width;
  const right = canvas.left + ((frame.maxX + 1) / 2) * width;
  const kept = target.right - target.left <= right - left ? target : core;
  if (kept.right - kept.left > right - left) {
    return (left + right) / 2 - (kept.left + kept.right) / 2;
  }
  if (kept.left < left) {
    return left - kept.left;
  }
  if (kept.right > right) {
    return right - kept.right;
  }
  return 0;
}
