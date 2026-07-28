import { useEffect, useRef, type MutableRefObject } from 'react';
import { VIEW_LABELS, type AxisProjection, type StandardView } from '@openzcad/viewport';

const AXIS_COLORS = {
  x: 'var(--color-handle-x)',
  y: 'var(--color-handle-y)',
  z: 'var(--color-handle-z)'
};
const WIDGET_R = 24;
/** Click radius around each axis tip; larger than the drawn label. */
const TIP_HIT_R = 8;

type Axis = 'x' | 'y' | 'z';

/**
 * Each axis reads as two views: the end you can see, and the one behind it.
 * `positive` is the view from the +axis side.
 */
const AXIS_VIEWS: Record<Axis, { positive: StandardView; negative: StandardView }> = {
  x: { positive: 'right', negative: 'left' },
  y: { positive: 'back', negative: 'front' },
  z: { positive: 'top', negative: 'bottom' }
};

/**
 * Live world-axis trihedron in the viewport's upper-right, doubling as a view
 * picker: click an axis tip to look down it, click the hub for isometric.
 *
 * The viewer pushes axis projections through `orientationRef` and the SVG
 * updates imperatively, so no React render happens per camera frame — the
 * widget redraws on every orbit, and re-rendering the workspace at that rate
 * is exactly what the imperative viewport exists to avoid.
 */
export function OrientationWidget({
  orientationRef,
  onSelectView
}: {
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectView(view: StandardView): void;
}) {
  const lineRefs = {
    x: useRef<SVGLineElement | null>(null),
    y: useRef<SVGLineElement | null>(null),
    z: useRef<SVGLineElement | null>(null)
  };
  const labelRefs = {
    x: useRef<SVGTextElement | null>(null),
    y: useRef<SVGTextElement | null>(null),
    z: useRef<SVGTextElement | null>(null)
  };
  /** Hit targets ride the tips, so they follow the camera like the labels. */
  const positiveHitRefs = {
    x: useRef<SVGCircleElement | null>(null),
    y: useRef<SVGCircleElement | null>(null),
    z: useRef<SVGCircleElement | null>(null)
  };
  const negativeHitRefs = {
    x: useRef<SVGCircleElement | null>(null),
    y: useRef<SVGCircleElement | null>(null),
    z: useRef<SVGCircleElement | null>(null)
  };

  useEffect(() => {
    orientationRef.current = (axes) => {
      for (const key of ['x', 'y', 'z'] as const) {
        const line = lineRefs[key].current;
        const label = labelRefs[key].current;
        const positive = positiveHitRefs[key].current;
        const negative = negativeHitRefs[key].current;
        if (!line || !label) {
          continue;
        }
        const tipX = 30 + axes[key].x * WIDGET_R;
        const tipY = 30 + axes[key].y * WIDGET_R;
        line.setAttribute('x2', String(tipX));
        line.setAttribute('y2', String(tipY));
        label.setAttribute('x', String(30 + axes[key].x * (WIDGET_R + 4.5)));
        label.setAttribute('y', String(30 + axes[key].y * (WIDGET_R + 4.5) + 2.5));
        positive?.setAttribute('cx', String(tipX));
        positive?.setAttribute('cy', String(tipY));
        // The opposite end has no drawn arm; it is the mirror of the tip.
        negative?.setAttribute('cx', String(60 - tipX));
        negative?.setAttribute('cy', String(60 - tipY));
      }
    };
    return () => {
      orientationRef.current = null;
    };
  }, []);

  return (
    <svg
      className="orientation-widget"
      viewBox="0 0 60 60"
      width="60"
      height="60"
      role="group"
      aria-label="View orientation"
    >
      <circle cx="30" cy="30" r="28" className="orientation-bg" />
      {(['x', 'y', 'z'] as const).map((key) => (
        <g key={key}>
          <line
            ref={lineRefs[key]}
            x1="30"
            y1="30"
            x2="30"
            y2="30"
            stroke={AXIS_COLORS[key]}
            strokeWidth="1.6"
          />
          <text
            ref={labelRefs[key]}
            x="30"
            y="30"
            fill={AXIS_COLORS[key]}
            fontSize="7"
            textAnchor="middle"
            aria-hidden="true"
          >
            {key.toUpperCase()}
          </text>
        </g>
      ))}
      {(['x', 'y', 'z'] as const).flatMap((key) =>
        (['positive', 'negative'] as const).map((end) => {
          const view = AXIS_VIEWS[key][end];
          const ref = end === 'positive' ? positiveHitRefs[key] : negativeHitRefs[key];
          return (
            <circle
              key={`${key}-${end}`}
              ref={ref}
              className="orientation-hit"
              cx="30"
              cy="30"
              r={TIP_HIT_R}
              role="button"
              tabIndex={0}
              aria-label={`${VIEW_LABELS[view]} view`}
              onClick={() => onSelectView(view)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectView(view);
                }
              }}
            />
          );
        })
      )}
      <circle
        className="orientation-home"
        cx="30"
        cy="30"
        r="6"
        role="button"
        tabIndex={0}
        aria-label="Isometric view"
        onClick={() => onSelectView('iso')}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelectView('iso');
          }
        }}
      />
    </svg>
  );
}
