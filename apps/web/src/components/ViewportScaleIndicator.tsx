import { Grid3x3 } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  DEFAULT_SCALE_BAR_MAX_WIDTH_PX,
  chooseViewportScale,
  formatViewportScale,
  type ViewportScale
} from '@openzcad/viewport';
import { watchStageTheme } from '../lib/stagePalette';

/** The rule's width across its length: the baseline and its longest tick. */
const RULE_ACROSS_PX = 18;
const DIVISIONS = 10;
/**
 * Room kept for the value at the rule's foot ("1000 mm" in the 13px mono
 * label is about 55px) and the gap between the two.
 */
const LABEL_RESERVE_PX = 64;
/** Clearance kept from the rail above the rule and the bar beside its foot. */
const CLEARANCE_PX = 8;
/**
 * The notice lane's status row over the bar (a 28px toast and its gaps),
 * which spans the bar's width: a rule standing on the bar clears it too.
 */
const STATUS_ROW_PX = 40;
/**
 * The shortest room the rule is ever given. The stylesheet's
 * --scale-rule-reserve keeps the rail at least this far off the corner,
 * except in a window too short to spare it (540px and under).
 */
const MIN_RULE_ROOM_PX = 32;
/** The gap between the rail and a rule that has to stand beside it. */
const RAIL_GAP_PX = 10;
/** Below this length ten divisions run together; only the centre is ticked. */
const MIN_TICKED_LENGTH_PX = 60;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScaleRulePlacement {
  /** Where the rule's left edge and foot stand, in viewport pixels. */
  left: number;
  bottom: number;
  maxLengthPx: number;
}

/**
 * Where the upright rule stands and how long it may be. It keeps the far
 * bottom-left corner of the stage and is scaled to the room above it: the
 * tool rail, or a sheet docked across the foot (a phone's measurement
 * workbench), caps its length. Where the search bar runs into the corner (a
 * phone with a panel open) its foot lifts onto the bar and its status row.
 * Only where the rail reaches the corner itself, leaving no room at all (a
 * window 540px tall or less), does it stand beside the rail.
 */
export function scaleRulePlacement(
  corner: { left: number; bottom: number },
  stageTop: number,
  rail: Box | null,
  bar: Box | null,
  sheet: Box | null = null
): ScaleRulePlacement {
  const place = (left: number): ScaleRulePlacement => {
    const footRight = left + RULE_ACROSS_PX + LABEL_RESERVE_PX;
    const onBar =
      bar !== null &&
      bar.left < footRight + CLEARANCE_PX &&
      bar.right > left &&
      bar.top < corner.bottom;
    const bottom = onBar
      ? Math.min(corner.bottom, bar.top - CLEARANCE_PX - STATUS_ROW_PX)
      : corner.bottom;
    let ceiling = stageTop;
    for (const above of [rail, sheet]) {
      if (
        above !== null &&
        above.left < left + RULE_ACROSS_PX &&
        above.right > left &&
        above.top < bottom
      ) {
        ceiling = Math.max(ceiling, above.bottom + CLEARANCE_PX);
      }
    }
    return { left, bottom, maxLengthPx: bottom - ceiling };
  };
  let placement = place(corner.left);
  if (rail !== null && placement.maxLengthPx < MIN_RULE_ROOM_PX) {
    const beside = place(rail.right + RAIL_GAP_PX);
    if (beside.maxLengthPx > placement.maxLengthPx) placement = beside;
  }
  return {
    ...placement,
    maxLengthPx: Math.min(
      DEFAULT_SCALE_BAR_MAX_WIDTH_PX,
      Math.max(MIN_RULE_ROOM_PX, placement.maxLengthPx)
    )
  };
}

export type ViewportScaleSink = (scale: ViewportScale | null) => void;

function cssColor(
  styles: CSSStyleDeclaration,
  property: string,
  fallback: string
): string {
  return styles.getPropertyValue(property).trim() || fallback;
}

interface RuleColors {
  primary: string;
  secondary: string;
  accent: string;
}

/**
 * The bar is drawn straight on the stage, so it reads the stage ink, which
 * re-themes with the stage: dark on the light stage, light on the dark.
 */
function readRuleColors(canvas: HTMLCanvasElement): RuleColors {
  const styles = window.getComputedStyle(canvas);
  return {
    primary: cssColor(styles, '--color-stage-ink', '#ebedef'),
    secondary: cssColor(styles, '--color-stage-ink-muted', '#9ba2ab'),
    accent: cssColor(styles, '--color-preselect', '#81a9ff')
  };
}

/**
 * Draws the rule `lengthPx` tall: the baseline up its left edge, the ticks
 * reaching right from it toward the model.
 */
function drawRule(
  canvas: HTMLCanvasElement,
  lengthPx: number,
  { primary, secondary, accent }: RuleColors
) {
  const cssLength = Math.max(lengthPx, 1);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.setProperty('--viewport-scale-length', `${cssLength}px`);
  const across = Math.round(RULE_ACROSS_PX * pixelRatio);
  const along = Math.max(1, Math.round(cssLength * pixelRatio));
  if (canvas.width !== across) canvas.width = across;
  if (canvas.height !== along) canvas.height = along;

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const top = 1;
  const bottom = Math.max(cssLength - 1, top);
  const baselineX = 2;
  const capX = RULE_ACROSS_PX - 2;

  context.lineCap = 'square';
  context.strokeStyle = primary;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(baselineX, top);
  context.lineTo(baselineX, bottom);
  context.moveTo(baselineX, top);
  context.lineTo(capX, top);
  context.moveTo(baselineX, bottom);
  context.lineTo(capX, bottom);
  context.stroke();

  const divisions = cssLength >= MIN_TICKED_LENGTH_PX ? DIVISIONS : 2;
  for (let index = 1; index < divisions; index += 1) {
    const ratio = index / divisions;
    const y = bottom - (bottom - top) * ratio;
    const isCenter = index * 2 === divisions;
    const isQuarter = divisions === DIVISIONS && (index === 3 || index === 7);
    const tickLength = isCenter ? 12 : isQuarter ? 9 : 6;

    context.strokeStyle = isCenter ? accent : secondary;
    context.lineWidth = isCenter ? 2 : 1;
    context.beginPath();
    context.moveTo(baselineX, y);
    context.lineTo(baselineX + tickLength, y);
    context.stroke();
  }
}

export function ViewportScaleIndicator({
  scaleSinkRef,
  units
}: {
  scaleSinkRef: MutableRefObject<ViewportScaleSink | null>;
  units: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const valueRef = useRef<HTMLOutputElement | null>(null);
  const lastScaleRef = useRef<ViewportScale | null>(null);
  const lastRenderedRef = useRef<(ViewportScale & { units: string }) | null>(
    null
  );
  // Computed style is read once per theme: the bar redraws on every frame of
  // a zoom or a face drag, where a style read after the frame's DOM writes
  // forced a synchronous style recalculation each time.
  const colorsRef = useRef<RuleColors | null>(null);
  // Layout is read only when something around the rule resizes, never per
  // frame: the bar redraws on every frame of a zoom.
  const maxLengthRef = useRef(DEFAULT_SCALE_BAR_MAX_WIDTH_PX);
  const [measureTick, setMeasureTick] = useState(0);
  const measureRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const area = root?.closest<HTMLElement>('.viewer-area');
    if (!root) return;
    const box = (selector: string): Box | null => {
      const rect = area?.querySelector(selector)?.getBoundingClientRect();
      return rect && rect.width > 0 && rect.height > 0 ? rect : null;
    };
    // The offset now applied, which the corner is read back through.
    const offset = { dx: 0, dy: 0 };
    const measure = () => {
      const stage = area?.getBoundingClientRect();
      // No layout (hidden, or no stage to stand in): keep the full rule.
      if (root.hidden || !stage || stage.height <= 0) return;
      const rect = root.getBoundingClientRect();
      const corner = {
        left: rect.left - offset.dx,
        bottom: rect.bottom - offset.dy
      };
      // A stylesheet that places the rule itself says so with this flag.
      const pinned =
        window
          .getComputedStyle(root)
          .getPropertyValue('--viewport-scale-pinned')
          .trim() === '1';
      const placement = pinned
        ? { ...corner, maxLengthPx: DEFAULT_SCALE_BAR_MAX_WIDTH_PX }
        : scaleRulePlacement(
            corner,
            box('.instrument-rail')?.top ?? stage.top,
            box('.workspace-column-float'),
            box('.command-bar-row'),
            box('.measurement-dock')
          );
      const dx = Math.round(placement.left - corner.left);
      const dy = Math.round(placement.bottom - corner.bottom);
      if (dx !== offset.dx || dy !== offset.dy) {
        offset.dx = dx;
        offset.dy = dy;
        root.style.setProperty('--viewport-scale-dx', `${dx}px`);
        root.style.setProperty('--viewport-scale-dy', `${dy}px`);
      }
      const maxLengthPx = Math.floor(placement.maxLengthPx);
      if (maxLengthPx !== maxLengthRef.current) {
        maxLengthRef.current = maxLengthPx;
        setMeasureTick((tick) => tick + 1);
      }
    };
    measureRef.current = measure;
    const resizes =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    const watch = () => {
      // Observing an element twice is a no-op; a remounted rail is new.
      for (const target of [
        area,
        area?.querySelector('.command-bar-lane'),
        area?.querySelector('.command-bar-row'),
        area?.querySelector('.workspace-column-float'),
        area?.querySelector('.measurement-dock')
      ]) {
        if (target) resizes?.observe(target);
      }
      measure();
    };
    watch();
    // The tool rail and the command float (the measurement workbench's)
    // mount and unmount beside the viewer.
    const mounts =
      area && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(watch)
        : null;
    if (area) mounts?.observe(area, { childList: true });
    window.addEventListener('resize', measure);
    return () => {
      resizes?.disconnect();
      mounts?.disconnect();
      window.removeEventListener('resize', measure);
      if (measureRef.current === measure) measureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const update = (offered: ViewportScale | null) => {
      lastScaleRef.current = offered;
      // The viewer offers the longest rule (200px); where the rule stands
      // may have less room, so the step is chosen again under that cap.
      const scale =
        offered && offered.widthPx > maxLengthRef.current
          ? chooseViewportScale(
              offered.value / offered.widthPx,
              maxLengthRef.current
            )
          : offered;
      const root = rootRef.current;
      const canvas = canvasRef.current;
      const value = valueRef.current;
      if (!root || !canvas || !value) {
        return;
      }
      if (root.hidden !== (scale === null)) {
        root.hidden = scale === null;
        // Hidden, it had no box to measure the room from.
        if (scale) measureRef.current?.();
      }
      if (!scale) {
        lastRenderedRef.current = null;
        return;
      }

      const label = formatViewportScale(scale.value, units);
      const previous = lastRenderedRef.current;
      const valueTolerance = Math.max(Math.abs(scale.value), 1) * 1e-12;
      if (
        previous &&
        previous.units === units &&
        Math.abs(previous.value - scale.value) <= valueTolerance &&
        Math.abs(previous.widthPx - scale.widthPx) <= 0.05
      ) {
        return;
      }

      colorsRef.current ??= readRuleColors(canvas);
      drawRule(canvas, scale.widthPx, colorsRef.current);
      // Replacing even identical output text invalidates ancestor :has()
      // selectors across the workspace on every zoom frame. Only the rule's
      // pixel length changes between steps of the model-space scale.
      if (value.value !== label) value.value = label;
      if (value.textContent !== label) value.textContent = label;
      const accessibleLabel = `Viewport scale at the model center plane: ${label}`;
      if (root.getAttribute('aria-label') !== accessibleLabel) {
        root.setAttribute('aria-label', accessibleLabel);
      }
      lastRenderedRef.current = { ...scale, units };
    };

    scaleSinkRef.current = update;
    // New room redraws the rule it already has.
    lastRenderedRef.current = null;
    update(lastScaleRef.current);
    // The rule's colours are baked into the canvas, so a theme change has to
    // redraw it; the label is CSS and follows on its own.
    const stopWatchingTheme = watchStageTheme(() => {
      lastRenderedRef.current = null;
      colorsRef.current = null;
      update(lastScaleRef.current);
    });
    return () => {
      stopWatchingTheme();
      if (scaleSinkRef.current === update) {
        scaleSinkRef.current = null;
      }
    };
  }, [scaleSinkRef, units, measureTick]);

  return (
    // One image named by its label ("Viewport scale … : 20 mm"), not a live
    // region: as an <output> the value was a polite status that announced a
    // bare "50 mm", "100 mm" on every zoom step, and the label on a plain
    // div was never exposed at all.
    <div
      ref={rootRef}
      className="viewport-scale-indicator"
      data-testid="viewport-scale-indicator"
      role="img"
      hidden
    >
      <canvas
        ref={canvasRef}
        className="viewport-scale-rule"
        data-testid="viewport-scale-rule"
        aria-hidden="true"
      />
      <output
        ref={valueRef}
        className="viewport-scale-value"
        aria-hidden="true"
      />
    </div>
  );
}

/** Receives the grid spacing with its unit ("5 mm"), or null for no grid. */
export type SketchGridReadoutSink = (spacing: string | null) => void;

/**
 * The sketch grid spacing as a segment of the viewport readout over the
 * right-hand rails. Floating on its own it sat on whatever shared the bottom
 * edge (the old dock, then the search bar at narrower windows). The render loop pushes the
 * spacing every frame; the node is only touched when it changes. The word
 * and the icon are markup, so the compact readout can trade one for the
 * other.
 */
export function ViewportGridReadout({
  sinkRef
}: {
  sinkRef: MutableRefObject<SketchGridReadoutSink | null>;
}) {
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    let shown: string | null = null;
    const update: SketchGridReadoutSink = (spacing) => {
      const node = nodeRef.current;
      const value = valueRef.current;
      if (!node || !value || spacing === shown) {
        return;
      }
      shown = spacing;
      value.textContent = spacing ?? '';
      node.hidden = spacing === null;
    };
    sinkRef.current = update;
    return () => {
      if (sinkRef.current === update) {
        sinkRef.current = null;
      }
    };
  }, [sinkRef]);
  return (
    <span
      ref={nodeRef}
      className="viewport-dock-grid mono"
      title="Sketch grid spacing — it adapts as you zoom"
      hidden
    >
      <Grid3x3 className="viewport-readout-icon" size={12} aria-hidden="true" />
      <span className="viewport-readout-word">Grid </span>
      <span ref={valueRef} />
    </span>
  );
}
