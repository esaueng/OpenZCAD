import { useEffect, useRef, type MutableRefObject } from 'react';
import type { AxisProjection } from './ModelViewer';

const AXIS_COLORS = {
  x: 'var(--color-handle-x)',
  y: 'var(--color-handle-y)',
  z: 'var(--color-handle-z)'
};
const WIDGET_R = 24;

/**
 * Live world-axis trihedron in the viewport's upper-right. The viewer pushes
 * axis projections through `orientationRef` and the SVG updates imperatively,
 * so no React render happens per camera frame.
 */
export function OrientationWidget({
  orientationRef
}: {
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
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

  useEffect(() => {
    orientationRef.current = (axes) => {
      for (const key of ['x', 'y', 'z'] as const) {
        const line = lineRefs[key].current;
        const label = labelRefs[key].current;
        if (!line || !label) {
          continue;
        }
        line.setAttribute('x2', String(30 + axes[key].x * WIDGET_R));
        line.setAttribute('y2', String(30 + axes[key].y * WIDGET_R));
        label.setAttribute('x', String(30 + axes[key].x * (WIDGET_R + 4.5)));
        label.setAttribute('y', String(30 + axes[key].y * (WIDGET_R + 4.5) + 2.5));
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
      aria-hidden="true"
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
          >
            {key.toUpperCase()}
          </text>
        </g>
      ))}
    </svg>
  );
}
