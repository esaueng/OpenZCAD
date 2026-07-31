import {
  useEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { Redo2, Undo2 } from 'lucide-react';
import {
  VIEW_LABELS,
  type AxisProjection,
  type CubeCorner,
  type StandardView,
  type ViewTarget
} from '@openzcad/viewport';

const AXIS_COLORS = {
  x: 'var(--color-handle-x)',
  y: 'var(--color-handle-y)',
  z: 'var(--color-handle-z)'
};

/** SVG center and pixels per cube half-edge. */
const CX = 56;
const CY = 56;
const SCALE = 21;
/** Fraction of a half-edge cut off each corner for the isometric facets. */
const BEVEL = 0.42;
/**
 * The triad is anchored on the cube corner the model origin projects to, and
 * its arms run along the cube edges — through the far corners at 2 half-edges
 * — before overhanging into free space, letters at the tips.
 */
const TRIAD_ORIGIN: Vec3 = [-1, -1, -1];
const ARM_TO = 2.5;
const ARM_LABEL_AT = 2.85;

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
  // Bottom mirrors top left-to-right: both poles share screen-up +Y (the
  // cameraUpForDirection convention), and looking up flips only screen-right.
  { view: 'bottom', opposite: 'top', normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] }
];

/**
 * Face outline with its corners cut for the bevel facets, in the face's
 * `(u, v)` plane. Each square corner is replaced by the two points `BEVEL`
 * short of it, so the octagons and corner triangles tile the cube exactly.
 */
const FACE_OUTLINE: readonly (readonly [number, number])[] = (() => {
  const b = 1 - BEVEL;
  return [
    [b, 1],
    [-b, 1],
    [-1, b],
    [-1, -b],
    [-b, -1],
    [b, -1],
    [1, -b],
    [1, b]
  ];
})();

/**
 * One bevelled corner facet: a large click target for the isometric view out
 * of that octant. The triangle's vertices sit `BEVEL` short of the corner
 * along each of its three edges, splicing into the faces' cut corners.
 */
interface CornerSpec {
  corner: CubeCorner;
  normal: Vec3;
  points: readonly Vec3[];
  label: string;
}

const CORNERS: CornerSpec[] = ([-1, 1] as const).flatMap((sx) =>
  ([-1, 1] as const).flatMap((sy) =>
    ([-1, 1] as const).map((sz): CornerSpec => {
      const b = 1 - BEVEL;
      const n = 1 / Math.sqrt(3);
      return {
        corner: [sx, sy, sz],
        normal: [sx * n, sy * n, sz * n],
        points: [
          [sx * b, sy, sz],
          [sx, sy * b, sz],
          [sx, sy, sz * b]
        ],
        // "isometric" between the octant and "view" keeps every corner name
        // distinct from the face names under substring accessible-name
        // matching: "top front right view" would otherwise contain "right
        // view".
        label: `${sz > 0 ? 'Top' : 'Bottom'} ${sy > 0 ? 'back' : 'front'} ${
          sx > 0 ? 'right' : 'left'
        } isometric view`
      };
    })
  )
);

/**
 * Which two cube faces each triad arm's edge belongs to. An arm is drawn over
 * the cube while either face shows — the edge is then on the visible surface
 * — and drops behind the opaque faces otherwise, so the silhouette clips it
 * and only its overhang past the cube stays visible.
 */
const ARM_FACES: Record<'x' | 'y' | 'z', readonly [Vec3, Vec3]> = {
  x: [
    [0, -1, 0],
    [0, 0, -1]
  ],
  y: [
    [-1, 0, 0],
    [0, 0, -1]
  ],
  z: [
    [-1, 0, 0],
    [0, -1, 0]
  ]
};

const AXIS_VECTORS: Record<'x' | 'y' | 'z', Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
};

/** Face fill lerps between these as it turns toward the camera. */
const FACE_GLANCING = [0x22, 0x2a, 0x34] as const;
const FACE_FRONTAL = [0x3a, 0x44, 0x50] as const;

/** Below this facing ratio a facet is a sliver not worth drawing or clicking. */
const FACING_EPSILON = 0.03;
/** Above this the face is head-on, and clicking it flips to the far side. */
const HEAD_ON = 0.999;
/** Preserve facet clicks through normal pointer wobble, then commit to orbit. */
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

function shade(facing: number): string {
  const fill = FACE_GLANCING.map((from, channel) =>
    Math.round(from + ((FACE_FRONTAL[channel] ?? from) - from) * facing)
  );
  return `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`;
}

/**
 * View cube in the viewport's upper-right: a truncated cube whose six faces
 * are the standard views and whose eight bevelled corner facets are the
 * diagonal isometric views, with an XYZ triad anchored on the origin corner
 * and two arrows that spin the view a quarter turn about the world up axis.
 * Clicking the face you are already looking at flips to the opposite side,
 * so bottom/left/back stay one-or-two clicks away even when their facets are
 * turned away.
 *
 * The viewer pushes axis projections through `orientationRef` and the SVG
 * updates imperatively, so no React render happens per camera frame — the
 * widget redraws on every orbit, and re-rendering the workspace at that rate
 * is exactly what the imperative viewport exists to avoid. That includes the
 * triad's occlusion: arms hop between a layer under the opaque facets and one
 * over them by reparenting, not by re-rendering.
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
  onSelectView(view: ViewTarget): void;
  onRotateView(direction: 'cw' | 'ccw'): void;
  onDragStart(): void;
  onDrag(deltaX: number, deltaY: number): void;
  onDragEnd(): void;
}) {
  const faceRefs = useRef<(SVGPolygonElement | null)[]>([]);
  const faceLabelRefs = useRef<(SVGTextElement | null)[]>([]);
  const cornerRefs = useRef<(SVGPolygonElement | null)[]>([]);
  /** What clicking each face does right now (flips when head-on). */
  const faceActions = useRef<StandardView[]>(FACES.map((face) => face.view));
  const dragRef = useRef<CubeDragState | null>(null);
  const suppressFacetClickRef = useRef(false);
  const underLayerRef = useRef<SVGGElement | null>(null);
  const overLayerRef = useRef<SVGGElement | null>(null);
  const armGroupRefs = {
    x: useRef<SVGGElement | null>(null),
    y: useRef<SVGGElement | null>(null),
    z: useRef<SVGGElement | null>(null)
  };
  const armLineRefs = {
    x: useRef<SVGLineElement | null>(null),
    y: useRef<SVGLineElement | null>(null),
    z: useRef<SVGLineElement | null>(null)
  };
  const armLabelRefs = {
    x: useRef<SVGTextElement | null>(null),
    y: useRef<SVGTextElement | null>(null),
    z: useRef<SVGTextElement | null>(null)
  };
  /** Which layer each arm currently sits in; null until the first frame. */
  const armOnSurface = useRef<Record<'x' | 'y' | 'z', boolean | null>>({
    x: null,
    y: null,
    z: null
  });

  useEffect(() => {
    orientationRef.current = (axes) => {
      const sx = (p: Vec3) => p[0] * axes.x.x + p[1] * axes.y.x + p[2] * axes.z.x;
      const sy = (p: Vec3) => p[0] * axes.x.y + p[1] * axes.y.y + p[2] * axes.z.y;
      const depth = (p: Vec3) => p[0] * axes.x.z + p[1] * axes.y.z + p[2] * axes.z.z;
      const px = (p: Vec3) => CX + SCALE * sx(p);
      const py = (p: Vec3) => CY + SCALE * sy(p);
      const outline = (points: readonly Vec3[]) =>
        points.map((point) => `${px(point)},${py(point)}`).join(' ');

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
        polygon.setAttribute(
          'points',
          outline(
            FACE_OUTLINE.map(([a, b]): Vec3 => [
              n[0] + a * u[0] + b * v[0],
              n[1] + a * u[1] + b * v[1],
              n[2] + a * u[2] + b * v[2]
            ])
          )
        );
        // The cube is lit by facing angle alone: full-on facets are lightest.
        polygon.setAttribute('fill', shade(facing));
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

      CORNERS.forEach((corner, index) => {
        const polygon = cornerRefs.current[index];
        if (!polygon) {
          return;
        }
        const facing = depth(corner.normal);
        if (facing < FACING_EPSILON) {
          polygon.style.display = 'none';
          return;
        }
        polygon.style.display = '';
        polygon.setAttribute('points', outline(corner.points));
        polygon.setAttribute('fill', shade(facing));
      });

      for (const key of ['x', 'y', 'z'] as const) {
        const group = armGroupRefs[key].current;
        const line = armLineRefs[key].current;
        const label = armLabelRefs[key].current;
        const under = underLayerRef.current;
        const over = overLayerRef.current;
        if (!group || !line || !label || !under || !over) {
          continue;
        }
        const [faceA, faceB] = ARM_FACES[key];
        const onSurface =
          depth(faceA) > FACING_EPSILON || depth(faceB) > FACING_EPSILON;
        if (armOnSurface.current[key] !== onSurface) {
          armOnSurface.current[key] = onSurface;
          (onSurface ? over : under).appendChild(group);
        }
        const axis = AXIS_VECTORS[key];
        const tip: Vec3 = [
          TRIAD_ORIGIN[0] + axis[0] * ARM_TO,
          TRIAD_ORIGIN[1] + axis[1] * ARM_TO,
          TRIAD_ORIGIN[2] + axis[2] * ARM_TO
        ];
        const letter: Vec3 = [
          TRIAD_ORIGIN[0] + axis[0] * ARM_LABEL_AT,
          TRIAD_ORIGIN[1] + axis[1] * ARM_LABEL_AT,
          TRIAD_ORIGIN[2] + axis[2] * ARM_LABEL_AT
        ];
        line.setAttribute('x1', String(px(TRIAD_ORIGIN)));
        line.setAttribute('y1', String(py(TRIAD_ORIGIN)));
        line.setAttribute('x2', String(px(tip)));
        line.setAttribute('y2', String(py(tip)));
        // +3 re-centers the letter vertically: text-anchor handles x, but
        // SVG has no dominant-baseline shorthand old enough to trust here.
        label.setAttribute('x', String(px(letter)));
        label.setAttribute('y', String(py(letter) + 3));
        // An axis pointing at the camera collapses its arm to a dot on the
        // corner; fade it out rather than leave a letter floating there.
        const dir = axes[key];
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
    suppressFacetClickRef.current = false;
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
      suppressFacetClickRef.current = true;
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
      suppressFacetClickRef.current = false;
    }
    if (drag.captureTarget.hasPointerCapture(event.pointerId)) {
      drag.captureTarget.releasePointerCapture(event.pointerId);
    }
  }

  /** Facet click that respects an orbit drag released over the facet. */
  function selectFacet(target: ViewTarget) {
    if (suppressFacetClickRef.current) {
      suppressFacetClickRef.current = false;
      return;
    }
    onSelectView(target);
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
        viewBox="0 0 112 112"
        width="112"
        height="112"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerDrag(event)}
        onPointerCancel={(event) => finishPointerDrag(event, true)}
      >
        <title>Drag to rotate the view</title>
        {/* Occluded triad arms live under the opaque facets, which is what
            clips them to the cube's silhouette: only overhang shows. */}
        <g className="orientation-triad" ref={underLayerRef}>
          {(['x', 'y', 'z'] as const).map((key) => (
            <g key={key} ref={armGroupRefs[key]}>
              <line
                ref={armLineRefs[key]}
                x1={CX}
                y1={CY}
                x2={CX}
                y2={CY}
                stroke={AXIS_COLORS[key]}
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <text
                ref={armLabelRefs[key]}
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
        </g>
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
              onClick={() => {
                selectFacet(faceActions.current[index] ?? face.view);
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
        {CORNERS.map((corner, index) => (
          <polygon
            key={corner.label}
            ref={(element) => {
              cornerRefs.current[index] = element;
            }}
            className="cube-corner"
            style={{ display: 'none' }}
            role="button"
            tabIndex={0}
            aria-label={corner.label}
            onClick={() => {
              selectFacet({ corner: corner.corner });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectView({ corner: corner.corner });
              }
            }}
          />
        ))}
        <g className="orientation-triad" ref={overLayerRef} />
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
