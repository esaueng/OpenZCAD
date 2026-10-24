import { Grid3x3 } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { formatViewportScale, type ViewportScale } from '@openzcad/viewport';
import { watchStageTheme } from '../lib/stagePalette';

const BAR_HEIGHT_PX = 18;
const DIVISIONS = 10;
/**
 * Wider than a phone the rule stands upright at the model's left edge; on a
 * phone it lies along the foot, under the measurement sheet, as it always
 * has. Keep in step with the ruler rules in quiet-stage.css.
 */
const UPRIGHT_QUERY = '(min-width: 621px)';

function prefersUpright(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(UPRIGHT_QUERY).matches
  );
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
 * Draws the rule `lengthPx` long. Lying down, the ticks rise from the
 * baseline along its foot; upright, the baseline runs down its left side
 * and the ticks reach right, into the model. The drawing is the lying rule
 * turned a quarter, so both read the same.
 */
function drawRule(
  canvas: HTMLCanvasElement,
  lengthPx: number,
  { primary, secondary, accent }: RuleColors,
  upright: boolean
) {
  const cssWidth = Math.max(lengthPx, 1);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.setProperty('--viewport-scale-length', `${cssWidth}px`);
  const along = Math.max(1, Math.round(cssWidth * pixelRatio));
  const across = Math.round(BAR_HEIGHT_PX * pixelRatio);
  canvas.width = upright ? across : along;
  canvas.height = upright ? along : across;

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  // Upright: the lying rule's x runs up the canvas (its start at the foot,
  // like a measured height) and its y runs left to right, mirrored so the
  // baseline is on the left.
  if (upright) {
    context.setTransform(0, -pixelRatio, -pixelRatio, 0, across, along);
  } else {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }
  context.clearRect(0, 0, cssWidth, BAR_HEIGHT_PX);

  const left = 1;
  const right = Math.max(cssWidth - 1, left);
  const baselineY = 16;

  context.lineCap = 'square';
  context.strokeStyle = primary;
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(left, baselineY);
  context.lineTo(right, baselineY);
  context.moveTo(left, 2);
  context.lineTo(left, baselineY);
  context.moveTo(right, 2);
  context.lineTo(right, baselineY);
  context.stroke();

  for (let index = 1; index < DIVISIONS; index += 1) {
    const ratio = index / DIVISIONS;
    const x = left + (right - left) * ratio;
    const isCenter = index === DIVISIONS / 2;
    const isQuarter = index === 3 || index === 7;
    const tickHeight = isCenter ? 12 : isQuarter ? 9 : 6;

    context.strokeStyle = isCenter ? accent : secondary;
    context.lineWidth = isCenter ? 2 : 1;
    context.beginPath();
    context.moveTo(x, baselineY - tickHeight);
    context.lineTo(x, baselineY);
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
  const [upright, setUpright] = useState(prefersUpright);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(UPRIGHT_QUERY);
    const follow = () => setUpright(query.matches);
    follow();
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);

  useEffect(() => {
    const update = (scale: ViewportScale | null) => {
      lastScaleRef.current = scale;
      const root = rootRef.current;
      const canvas = canvasRef.current;
      const value = valueRef.current;
      if (!root || !canvas || !value) {
        return;
      }
      root.hidden = scale === null;
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
      drawRule(canvas, scale.widthPx, colorsRef.current, upright);
      value.value = label;
      value.textContent = label;
      root.setAttribute(
        'aria-label',
        `Viewport scale at the model center plane: ${label}`
      );
      lastRenderedRef.current = { ...scale, units };
    };

    scaleSinkRef.current = update;
    // A new orientation redraws the rule it already has.
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
  }, [scaleSinkRef, units, upright]);

  return (
    // One image named by its label ("Viewport scale … : 20 mm"), not a live
    // region: as an <output> the value was a polite status that announced a
    // bare "50 mm", "100 mm" on every zoom step, and the label on a plain
    // div was never exposed at all.
    <div
      ref={rootRef}
      className={`viewport-scale-indicator${upright ? ' is-upright' : ''}`}
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
 * The sketch grid spacing as a segment of the bottom-left viewport readout.
 * Floating on its own it sat on whatever shared the bottom edge (the old
 * dock, then the search bar at narrower windows). The render loop pushes the
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
