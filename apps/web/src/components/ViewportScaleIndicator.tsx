import { useEffect, useRef, type MutableRefObject } from 'react';
import { formatViewportScale, type ViewportScale } from '@openzcad/viewport';

const BAR_HEIGHT_PX = 18;
const DIVISIONS = 10;

export type ViewportScaleSink = (scale: ViewportScale | null) => void;

function cssColor(
  styles: CSSStyleDeclaration,
  property: string,
  fallback: string
): string {
  return styles.getPropertyValue(property).trim() || fallback;
}

function drawRule(canvas: HTMLCanvasElement, widthPx: number) {
  const cssWidth = Math.max(widthPx, 1);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.setProperty('--viewport-scale-width', `${cssWidth}px`);
  canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
  canvas.height = Math.round(BAR_HEIGHT_PX * pixelRatio);

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, BAR_HEIGHT_PX);

  const styles = window.getComputedStyle(canvas);
  const primary = cssColor(styles, '--color-text', '#e6edf3');
  const secondary = cssColor(styles, '--color-text-muted', '#8b949e');
  const accent = cssColor(styles, '--color-accent', '#4da3ff');
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

      drawRule(canvas, scale.widthPx);
      value.value = label;
      value.textContent = label;
      root.setAttribute(
        'aria-label',
        `Viewport scale at the camera focus plane: ${label}`
      );
      lastRenderedRef.current = { ...scale, units };
    };

    scaleSinkRef.current = update;
    update(lastScaleRef.current);
    return () => {
      if (scaleSinkRef.current === update) {
        scaleSinkRef.current = null;
      }
    };
  }, [scaleSinkRef, units]);

  return (
    <div
      ref={rootRef}
      className="viewport-scale-indicator"
      data-testid="viewport-scale-indicator"
      hidden
    >
      <canvas
        ref={canvasRef}
        className="viewport-scale-rule"
        data-testid="viewport-scale-rule"
        aria-hidden="true"
      />
      <output ref={valueRef} className="viewport-scale-value" />
    </div>
  );
}
