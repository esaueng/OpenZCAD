import { useEffect, useRef, type MutableRefObject } from 'react';
import { Box, Camera, Focus, Grid3x3, Maximize2 } from 'lucide-react';
import type { AxisProjection, ProjectionMode, StandardView } from './ModelViewer';

interface ViewportNavProps {
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  projection: ProjectionMode;
  showGrid: boolean;
  hasSelection: boolean;
  onView(view: StandardView): void;
  onToggleProjection(): void;
  onToggleGrid(): void;
  onFit(target: 'all' | 'selection'): void;
}

const AXIS_COLORS = { x: 'var(--color-handle-x)', y: 'var(--color-handle-y)', z: 'var(--color-handle-z)' };
const WIDGET_R = 26;

/**
 * Compact camera cluster in the viewport's upper-right: a live orientation
 * widget (world axes projected to screen space, updated imperatively so no
 * React render happens per frame) plus standard views, projection, grid, and
 * fit controls.
 */
export function ViewportNav({
  orientationRef,
  projection,
  showGrid,
  hasSelection,
  onView,
  onToggleProjection,
  onToggleGrid,
  onFit
}: ViewportNavProps) {
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
        const endX = 32 + axes[key].x * WIDGET_R;
        const endY = 32 + axes[key].y * WIDGET_R;
        line.setAttribute('x2', String(endX));
        line.setAttribute('y2', String(endY));
        label.setAttribute('x', String(32 + axes[key].x * (WIDGET_R + 5)));
        label.setAttribute('y', String(32 + axes[key].y * (WIDGET_R + 5) + 2.5));
      }
    };
    return () => {
      orientationRef.current = null;
    };
  }, []);

  return (
    <div className="viewport-nav" role="toolbar" aria-label="Camera controls">
      <svg
        className="orientation-widget"
        viewBox="0 0 64 64"
        width="64"
        height="64"
        aria-hidden="true"
      >
        <circle cx="32" cy="32" r="30" className="orientation-bg" />
        {(['x', 'y', 'z'] as const).map((key) => (
          <g key={key}>
            <line
              ref={lineRefs[key]}
              x1="32"
              y1="32"
              x2="32"
              y2="32"
              stroke={AXIS_COLORS[key]}
              strokeWidth="1.6"
            />
            <text
              ref={labelRefs[key]}
              x="32"
              y="32"
              fill={AXIS_COLORS[key]}
              fontSize="7.5"
              textAnchor="middle"
            >
              {key.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
      <div className="view-buttons">
        <button type="button" title="Isometric view (0)" onClick={() => onView('iso')}>
          <Box size={12} aria-hidden="true" />
        </button>
        <button type="button" title="Front view (1)" onClick={() => onView('front')}>
          F
        </button>
        <button type="button" title="Top view (2)" onClick={() => onView('top')}>
          T
        </button>
        <button type="button" title="Right view (3)" onClick={() => onView('right')}>
          R
        </button>
      </div>
      <div className="view-buttons">
        <button type="button" title="Fit view (F)" onClick={() => onFit('all')}>
          <Maximize2 size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          title="Fit selection (Shift+F)"
          disabled={!hasSelection}
          onClick={() => onFit('selection')}
        >
          <Focus size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={projection === 'orthographic' ? 'active' : ''}
          title={`Projection: ${projection} (P toggles)`}
          aria-pressed={projection === 'orthographic'}
          onClick={onToggleProjection}
        >
          <Camera size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={showGrid ? 'active' : ''}
          title="Toggle grid (G)"
          aria-pressed={showGrid}
          onClick={onToggleGrid}
        >
          <Grid3x3 size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
