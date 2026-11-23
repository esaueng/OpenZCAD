import {
  clearStageFrame,
  STAGE_FRAME_GAP_PX,
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
    ignoreGuide = false
  }: { throughCover?: boolean; ignoreGuide?: boolean } = {}
): ClearStage | undefined {
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
      const side = sideFrame(vertical, panels);
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
  const side = sideFrame(verticalBounds, sides);
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
  sides: readonly StageRect[]
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
    const frame = clearStageFrame(bounds, panels);
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
  options: { throughCover?: boolean; ignoreGuide?: boolean } = {}
): NdcFrame | undefined {
  return measureClearStage(canvas, options)?.frame;
}

/**
 * Whether a model whose bounding box projects to `corners` (normalized
 * device coordinates on `canvas`) stands where nothing covers it. Inside the
 * clear stage it does. So it does where only the guide's card shaped that
 * stage, as long as it stays inside the stage without the card and off the
 * card itself: the clear stage is one rectangle, above or beside the card,
 * and a model beside a card framed above (or above one framed beside) is in
 * plain view all the same. Pressing Next reframed such a model (preview
 * check on #1969).
 */
export function cornersClearOfStage(
  canvas: HTMLElement,
  corners: readonly { x: number; y: number; z: number }[]
): boolean {
  const stage = measureFitFrame(canvas);
  if (!stage || cornersWithinFrame(corners, stage)) return true;
  const open = measureFitFrame(canvas, { ignoreGuide: true }) ?? {
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1
  };
  if (!cornersWithinFrame(corners, open)) return false;
  const bounds = canvas.getBoundingClientRect();
  const xs = corners.map(
    (corner) => bounds.left + ((corner.x + 1) / 2) * bounds.width
  );
  const ys = corners.map(
    (corner) => bounds.top + ((1 - corner.y) / 2) * bounds.height
  );
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  return panelsOver(canvas, FOOT_GUIDE).every(
    (card) =>
      card.right <= left ||
      card.left >= right ||
      card.bottom <= top ||
      card.top >= bottom
  );
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
  const frame = measureFitFrame(canvas) ?? {
    minX: -1,
    maxX: 1,
    minY: -1,
    maxY: 1
  };
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
