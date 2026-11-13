import {
  clearStageFrame,
  STAGE_FRAME_GAP_PX,
  type NdcFrame,
  type StageRect
} from '@openzcad/viewport';
import { SELECTION_CALLOUT_OBSTACLES } from './selectionCalloutView';

/**
 * The part of the viewport canvas that Fit frames into: the canvas less the
 * floating panels over it — the right lane (command card, inspector), the
 * model panels, the instrument rail, the left column and the tool palette. These
 * are the same panels a selection chip keeps out from under. Undefined means
 * the whole canvas.
 */
export function measureFitFrame(
  canvas: HTMLElement,
  { throughCover = false }: { throughCover?: boolean } = {}
): NdcFrame | undefined {
  const bounds = canvas.getBoundingClientRect();
  const panels = panelsOver(
    canvas,
    `${SELECTION_CALLOUT_OBSTACLES}, .tweak-flyouts, .view-flyouts`,
    throughCover
  );
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
  // Wide lower sheets reserve height, while narrow rails reserve width.
  // Keep this UI projection local: the viewport package's side-band API
  // remains available unchanged to other consumers.
  for (const panel of panels) {
    const panelWidth = panel.right - panel.left;
    const panelHeight = panel.bottom - panel.top;
    if (
      panelWidth <= width / 2 ||
      panelHeight >= height / 2 ||
      panelHeight <= 0
    )
      continue;
    if ((panel.top + panel.bottom) / 2 >= bounds.top + height / 2)
      bottom = Math.min(bottom, panel.top - STAGE_FRAME_GAP_PX);
    else top = Math.max(top, panel.bottom + STAGE_FRAME_GAP_PX);
  }
  if (bottom <= top) return undefined;
  const verticalBounds = {
    left: bounds.left,
    right: bounds.right,
    top,
    bottom
  };
  const sides = clearStageFrame(verticalBounds, panels);
  if (!sides && top === bounds.top && bottom === bounds.bottom)
    return undefined;
  return {
    minX: sides?.minX ?? -1,
    maxX: sides?.maxX ?? 1,
    minY: 1 - ((bottom - bounds.top) / height) * 2,
    maxY: 1 - ((top - bounds.top) / height) * 2
  };
}

/**
 * At or below this canvas width the model's first frame is fitted into the
 * clear stage rather than the whole canvas: a phone's two rails stand over a
 * third of its width, and the home fit put both ends of the part under them.
 * The same width at which the phone lane rests (`PANEL_LANE_REST_MAX_WIDTH`).
 */
export const OPENING_FRAME_MAX_WIDTH = 520;

/**
 * The frame a model's first fit lands in. On a phone, what `measureFitFrame`
 * gives, so the part opens between the rails; wider, undefined (the whole
 * canvas), as the home fit has always been: the rails take little of a wide
 * stage, and the docks open over it afterwards.
 */
export function measureOpeningFrame(canvas: HTMLElement): NdcFrame | undefined {
  // The first fit is made while the workspace is still covered, so the
  // rails are read through the cover.
  return canvas.getBoundingClientRect().width <= OPENING_FRAME_MAX_WIDTH
    ? measureFitFrame(canvas, { throughCover: true })
    : undefined;
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
  throughCover = false
): StageRect[] {
  const cover = throughCover ? canvas.closest('.workspace-reveal') : null;
  const covered =
    cover !== null && getComputedStyle(cover).visibility === 'hidden';
  return [
    ...(canvas
      .closest('.viewer-area')
      ?.querySelectorAll<HTMLElement>(selector) ?? [])
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
