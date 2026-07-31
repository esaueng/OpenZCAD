import {
  useEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import { VIEW_LABELS, type AxisProjection, type StandardView } from '@openzcad/viewport';

const AXIS_COLORS = {
  x: 'var(--color-handle-x)',
  y: 'var(--color-handle-y)',
  z: 'var(--color-handle-z)'
};

/** SVG center and pixels per cube half-edge. */
const CX = 52;
const CY = 54;
const SCALE = 21;
/** Axis stubs run from just past the face to the letter at the tip. */
const AXIS_FROM = 1.3;
const AXIS_TO = 1.95;
const AXIS_LABEL_AT = 2.25;

type Vec3 = readonly [number, number, number];

/**
 * One cube face: its outward normal and the in-plane frame its label is drawn
 * in. `u`/`v` are screen-right/screen-up when the face is viewed head-on in
 * its own standard view, so the label reads upright exactly when you arrive.
 */
interface FaceSpec {
  view: StandardView;
  opposite: StandardView;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
}

const FACES: FaceSpec[] = [
  { view: 'right', opposite: 'left', normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { view: 'left', opposite: 'right', normal: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { view: 'back', opposite: 'front', normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { view: 'front', opposite: 'back', normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { view: 'top', opposite: 'bottom', normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  // Bottom's frame follows VIEW_DIRECTIONS' pole nudge, which settles
  // screen-up on -Y when looking up — not the +Y a mirror of top would give.
  { view: 'bottom', opposite: 'top', normal: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] }
];

/** Face fill lerps between these as it turns toward the camera. */
const FACE_GLANCING = [0x22, 0x2a, 0x34] as const;
const FACE_FRONTAL = [0x3a, 0x44, 0x50] as const;

/** Below this facing ratio a face is a sliver not worth drawing or clicking. */
const FACING_EPSILON = 0.03;
/** Above this the face is head-on, and clicking it flips to the far side. */
const HEAD_ON = 0.999;
/** Preserve face clicks through normal pointer wobble, then commit to orbit. */
const DRAG_THRESHOLD_PX = 4;

interface CubeDragState {
  pointerId: number;
  captureTarget: SVGElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  dragging: boolean;
}

/**
 * View cube in the viewport's upper-right: an orthographic cube whose faces
 * are the six standard views, world-axis stubs in the handle colors, and two
 * arrows that spin the view a quarter turn about the world up axis. Clicking
 * the face you are already looking at flips to the opposite side, which is
 * how bottom/left/back stay one-or-two clicks away without cluttering the
 * cube with invisible targets.
 *
 * The viewer pushes axis projections through `orientationRef` and the SVG
 * updates imperatively, so no React render happens per camera frame — the
 * widget redraws on every orbit, and re-rendering the workspace at that rate
 * is exactly what the imperative viewport exists to avoid.
 */
export function OrientationWidget({
  orientationRef,
  onSelectView,
  onRotateView,
  onDragStart,
  onDrag,
  onDragEnd
}: {
  orientationRef: MutableRefObject<((axes: AxisProjection) => void) | null>;
  onSelectView(view: StandardView): void;
  onRotateView(direction: 'cw' | 'ccw'): void;
  onDragStart(): void;
  onDrag(deltaX: number, deltaY: number): void;
  onDragEnd(): void;
}) {
  const faceRefs = useRef<(SVGPolygonElement | null)[]>([]);
  const faceLabelRefs = useRef<(SVGTextElement | null)[]>([]);
  /** What clicking each face does right now (flips when head-on). */
  const faceActions = useRef<StandardView[]>(FACES.map((face) => face.view));
  const dragRef = useRef<CubeDragState | null>(null);
  const suppressFaceClickRef = useRef(false);
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
      const sx = (p: Vec3) => p[0] * axes.x.x + p[1] * axes.y.x + p[2] * axes.z.x;
      const sy = (p: Vec3) => p[0] * axes.x.y + p[1] * axes.y.y + p[2] * axes.z.y;
      const depth = (p: Vec3) => p[0] * axes.x.z + p[1] * axes.y.z + p[2] * axes.z.z;
      const px = (p: Vec3) => CX + SCALE * sx(p);
      const py = (p: Vec3) => CY + SCALE * sy(p);

      FACES.forEach((face, index) => {
        const polygon = faceRefs.current[index];
        const label = faceLabelRefs.current[index];
        if (!polygon || !label) {
          return;
        }
        const facing = depth(face.normal);
        if (facing < FACING_EPSILON) {
          polygon.style.display = 'none';
          label.style.display = 'none';
          return;
        }
        polygon.style.display = '';
        label.style.display = '';
        const { normal: n, u, v } = face;
        const corners: Vec3[] = [
          [n[0] + u[0] + v[0], n[1] + u[1] + v[1], n[2] + u[2] + v[2]],
          [n[0] - u[0] + v[0], n[1] - u[1] + v[1], n[2] - u[2] + v[2]],
          [n[0] - u[0] - v[0], n[1] - u[1] - v[1], n[2] - u[2] - v[2]],
          [n[0] + u[0] - v[0], n[1] + u[1] - v[1], n[2] + u[2] - v[2]]
        ];
        polygon.setAttribute(
          'points',
          corners.map((corner) => `${px(corner)},${py(corner)}`).join(' ')
        );
        // The cube is lit by facing angle alone: full-on faces are lightest.
        const fill = FACE_GLANCING.map((from, channel) =>
          Math.round(from + ((FACE_FRONTAL[channel] ?? from) - from) * facing)
        );
        polygon.setAttribute('fill', `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`);
        // An orthographic projection of a planar face is exactly a 2D affine
        // map, so the label lies on the face via a single matrix: text-right
        // along u, text-up along v (negated — SVG y grows downward).
        label.setAttribute(
          'transform',
          `matrix(${sx(u)}, ${sy(u)}, ${-sx(v)}, ${-sy(v)}, ${px(n)}, ${py(n)})`
        );
        const action = facing > HEAD_ON ? face.opposite : face.view;
        if (faceActions.current[index] !== action) {
          faceActions.current[index] = action;
          polygon.setAttribute('aria-label', `${VIEW_LABELS[action]} view`);
        }
      });

      for (const key of ['x', 'y', 'z'] as const) {
        const line = lineRefs[key].current;
        const label = labelRefs[key].current;
        if (!line || !label) {
          continue;
        }
        const dir = axes[key];
        line.setAttribute('x1', String(CX + dir.x * SCALE * AXIS_FROM));
        line.setAttribute('y1', String(CY + dir.y * SCALE * AXIS_FROM));
        line.setAttribute('x2', String(CX + dir.x * SCALE * AXIS_TO));
        line.setAttribute('y2', String(CY + dir.y * SCALE * AXIS_TO));
        label.setAttribute('x', String(CX + dir.x * SCALE * AXIS_LABEL_AT));
        label.setAttribute('y', String(CY + dir.y * SCALE * AXIS_LABEL_AT + 2.5));
        // An axis pointing at the camera collapses to a dot behind the cube;
        // fade it out rather than leave a letter floating on a face.
        const planar = Math.hypot(dir.x, dir.y);
        const opacity = Math.min(Math.max((planar - 0.3) / 0.25, 0), 1);
        line.setAttribute('opacity', String(opacity));
        label.setAttribute('opacity', String(opacity));
      }
    };
    return () => {
      orientationRef.current = null;
    };
  }, []);

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || dragRef.current) {
      return;
    }
    const captureTarget = event.target;
    if (!(captureTarget instanceof SVGElement)) {
      return;
    }
    suppressFaceClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      captureTarget,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      dragging: false
    };
    captureTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (
      !drag.dragging &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <
        DRAG_THRESHOLD_PX
    ) {
      return;
    }
    if (!drag.dragging) {
      drag.dragging = true;
      suppressFaceClickRef.current = true;
      onDragStart();
    }
    const deltaX = event.clientX - drag.lastX;
    const deltaY = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (deltaX !== 0 || deltaY !== 0) {
      onDrag(deltaX, deltaY);
    }
    event.preventDefault();
  }

  function finishPointerDrag(
    event: ReactPointerEvent<SVGSVGElement>,
    cancelled = false
  ) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (drag.dragging) {
      onDragEnd();
    }
    dragRef.current = null;
    if (cancelled) {
      suppressFaceClickRef.current = false;
    }
    if (drag.captureTarget.hasPointerCapture(event.pointerId)) {
      drag.captureTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="orientation-widget" role="group" aria-label="View orientation">
      <button
        type="button"
        className="orientation-roll"
        title="Rotate view clockwise"
        aria-label="Rotate view clockwise"
        onClick={() => onRotateView('cw')}
      >
        <Redo2 size={14} aria-hidden="true" />
      </button>
      <svg
        className="orientation-cube"
        viewBox="0 0 104 104"
        width="104"
        height="104"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerDrag(event)}
        onPointerCancel={(event) => finishPointerDrag(event, true)}
      >
        <title>Drag to rotate the view</title>
        {/* Axis stubs draw under the cube so degenerate ones hide behind it. */}
        {(['x', 'y', 'z'] as const).map((key) => (
          <g key={key}>
            <line
              ref={lineRefs[key]}
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY}
              stroke={AXIS_COLORS[key]}
              strokeWidth="1.6"
            />
            <text
              ref={labelRefs[key]}
              className="orientation-axis-label"
              x={CX}
              y={CY}
              fill={AXIS_COLORS[key]}
              aria-hidden="true"
            >
              {key.toUpperCase()}
            </text>
          </g>
        ))}
        {FACES.map((face, index) => (
          <g key={face.view}>
            <polygon
              ref={(element) => {
                faceRefs.current[index] = element;
              }}
              className="cube-face"
              style={{ display: 'none' }}
              role="button"
              tabIndex={0}
              aria-label={`${VIEW_LABELS[face.view]} view`}
              onClick={(event) => {
                if (suppressFaceClickRef.current) {
                  suppressFaceClickRef.current = false;
                  event.preventDefault();
                  return;
                }
                onSelectView(faceActions.current[index] ?? face.view);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectView(faceActions.current[index] ?? face.view);
                }
              }}
            />
            <text
              ref={(element) => {
                faceLabelRefs.current[index] = element;
              }}
              className="cube-face-label"
              style={{ display: 'none' }}
              aria-hidden="true"
            >
              {VIEW_LABELS[face.view]}
            </text>
          </g>
        ))}
      </svg>
      <button
        type="button"
        className="orientation-roll"
        title="Rotate view counterclockwise"
        aria-label="Rotate view counterclockwise"
        onClick={() => onRotateView('ccw')}
      >
        <Undo2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
