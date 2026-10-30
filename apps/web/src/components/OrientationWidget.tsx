import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  VIEW_LABELS,
  type AxisProjection,
  type StandardView,
  type ViewTarget
} from '@openzcad/viewport';
import {
  AXIS_KEYS,
  CORNERS,
  CUBE_SIZE,
  FACES,
  projectCube,
  type AxisKey,
  type CubeFacet,
  type CubeHighlight,
  type CubePoint,
  type OrientationLink
} from './viewer/orientationCube';

const AXIS_COLORS = {
  x: 'var(--color-handle-x)',
  y: 'var(--color-handle-y)',
  z: 'var(--color-handle-z)'
};

/** Preserve facet clicks through normal pointer wobble, then commit to orbit. */
const DRAG_THRESHOLD_PX = 4;

/**
 * How long the camera must rest before the unpainted hit layer catches up
 * with it, once the viewer draws the cube. Long enough that an orbit's frames
 * never write to the page, short enough that the facets are where they look
 * before a hand can travel to them.
 */
export const HIT_LAYER_SETTLE_MS = 120;

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
 * Lights a facet by how squarely it faces the camera. The stylesheet mixes
 * the theme's glancing and frontal cube colours by this (viewport-overlays.css),
 * so the cube re-themes without the frame loop knowing the palette.
 */
function shade(polygon: SVGPolygonElement, facing: number) {
  polygon.style.setProperty('--cube-facing', facing.toFixed(3));
}

/** Which facet an element inside the cube answers for, if any. */
function facetOf(target: EventTarget | null): CubeFacet | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<SVGElement>('[data-facet]');
  const [kind, index] = element?.dataset.facet?.split(':') ?? [];
  return (kind === 'face' || kind === 'corner') && index !== undefined
    ? { kind, index: Number(index) }
    : null;
}

/** Keyboard focus, which draws the focus stroke; a click's focus does not. */
function showsFocusRing(target: EventTarget) {
  try {
    return target instanceof Element && target.matches(':focus-visible');
  } catch {
    // An engine without the selector shows no ring, like the stylesheet.
    return false;
  }
}

function sameFacet(a: CubeFacet | null, b: CubeFacet | null) {
  return a?.kind === b?.kind && a?.index === b?.index;
}

/**
 * View cube in the viewport's upper-right: a truncated cube whose six faces
 * are the standard views and whose eight bevelled corner facets are the
 * diagonal isometric views, with an XYZ triad anchored on the origin corner
 * alongside drag-to-orbit navigation.
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
 *
 * Once the viewer paints the cube into its own canvas (`attachOverlay`), the
 * SVG stops painting and writes nothing while the camera moves: it catches up
 * when the camera rests, or the moment a pointer moves over it.
 */
export function OrientationWidget({
  orientationRef,
  onSelectView,
  onDragStart,
  onDrag,
  onDragEnd
}: {
  orientationRef: MutableRefObject<OrientationLink | null>;
  onSelectView(view: ViewTarget): void;
  onDragStart(): void;
  onDrag(deltaX: number, deltaY: number): void;
  onDragEnd(): void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const faceRefs = useRef<(SVGPolygonElement | null)[]>([]);
  const faceLabelRefs = useRef<(SVGTextElement | null)[]>([]);
  const cornerRefs = useRef<(SVGPolygonElement | null)[]>([]);
  const cornerHitRefs = useRef<(SVGPolygonElement | null)[]>([]);
  /** What clicking each face does right now (flips when head-on). */
  const faceActions = useRef<StandardView[]>(FACES.map((face) => face.view));
  const dragRef = useRef<CubeDragState | null>(null);
  const suppressFacetClickRef = useRef(false);
  const onDragEndRef = useRef(onDragEnd);
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
  const armOnSurface = useRef<Record<AxisKey, boolean | null>>({
    x: null,
    y: null,
    z: null
  });
  /**
   * The hit layer's bookkeeping while the viewer paints the cube: the axes
   * it has not caught up with yet, and what to tell the viewer when the
   * hover or focus moves.
   */
  const hitLayer = useRef<{
    pending: AxisProjection | null;
    lastPush: number;
    timer: ReturnType<typeof setTimeout> | null;
    overlayChanged: (() => void) | null;
    highlight: CubeHighlight;
    apply: ((axes: AxisProjection) => void) | null;
  }>({
    pending: null,
    lastPush: -Infinity,
    timer: null,
    overlayChanged: null,
    highlight: { hovered: null, focusVisible: null },
    apply: null
  });

  useEffect(() => {
    onDragEndRef.current = onDragEnd;
  }, [onDragEnd]);

  const finishPointerDrag = useCallback(
    (pointerId: number | null, cancelled: boolean, releaseCapture: boolean) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== null && drag.pointerId !== pointerId)) {
        return;
      }

      // Clear first so releasing capture cannot re-enter through
      // lostpointercapture and finish the same camera gesture twice.
      dragRef.current = null;
      if (cancelled) {
        // A cancelled native gesture should not turn into a face click. The
        // next real pointerdown clears this guard before its click can fire.
        suppressFacetClickRef.current = true;
      }
      if (releaseCapture) {
        try {
          if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
            drag.captureTarget.releasePointerCapture(drag.pointerId);
          }
        } catch {
          // Capture may already be gone when a window blur or unmount races
          // the browser's implicit pointer-capture release.
        }
      }
      if (drag.dragging) {
        onDragEndRef.current();
      }
    },
    []
  );

  useEffect(() => {
    const handleWindowBlur = () => finishPointerDrag(null, true, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      finishPointerDrag(null, true, true);
    };
  }, [finishPointerDrag]);

  /** Brings the hit layer up to the camera now, if it is behind. */
  const catchUp = useCallback(() => {
    const state = hitLayer.current;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const axes = state.pending;
    state.pending = null;
    if (axes) state.apply?.(axes);
  }, []);

  useEffect(() => {
    const state = hitLayer.current;
    const apply = (axes: AxisProjection) => {
      const projection = projectCube(axes);
      const outline = (points: readonly CubePoint[]) =>
        points.map((point) => `${point.x},${point.y}`).join(' ');

      FACES.forEach((_face, index) => {
        const polygon = faceRefs.current[index];
        const label = faceLabelRefs.current[index];
        if (!polygon || !label) {
          return;
        }
        const face = projection.faces[index];
        if (!face) {
          polygon.style.display = 'none';
          label.style.display = 'none';
          return;
        }
        polygon.style.display = '';
        label.style.display = '';
        polygon.setAttribute('points', outline(face.outline));
        // The cube is lit by facing angle alone: full-on facets are lightest.
        shade(polygon, face.facing);
        label.setAttribute('transform', `matrix(${face.label.join(', ')})`);
        if (faceActions.current[index] !== face.action) {
          faceActions.current[index] = face.action;
          polygon.setAttribute(
            'aria-label',
            `${VIEW_LABELS[face.action]} view`
          );
        }
      });

      CORNERS.forEach((_corner, index) => {
        const polygon = cornerRefs.current[index];
        const hit = cornerHitRefs.current[index];
        if (!polygon || !hit) {
          return;
        }
        const corner = projection.corners[index];
        if (!corner) {
          polygon.style.display = 'none';
          // The target hides with its facet: an invisible triangle over a
          // corner that has turned away would swallow clicks meant for the
          // face now covering that ground.
          hit.style.display = 'none';
          return;
        }
        polygon.style.display = '';
        hit.style.display = '';
        polygon.setAttribute('points', outline(corner.outline));
        shade(polygon, corner.facing);
        hit.setAttribute('points', outline(corner.target));
      });

      for (const key of AXIS_KEYS) {
        const group = armGroupRefs[key].current;
        const line = armLineRefs[key].current;
        const label = armLabelRefs[key].current;
        const under = underLayerRef.current;
        const over = overLayerRef.current;
        if (!group || !line || !label || !under || !over) {
          continue;
        }
        const arm = projection.arms[key];
        if (armOnSurface.current[key] !== arm.onSurface) {
          armOnSurface.current[key] = arm.onSurface;
          (arm.onSurface ? over : under).appendChild(group);
        }
        line.setAttribute('x1', String(arm.from.x));
        line.setAttribute('y1', String(arm.from.y));
        line.setAttribute('x2', String(arm.to.x));
        line.setAttribute('y2', String(arm.to.y));
        label.setAttribute('x', String(arm.letter.x));
        label.setAttribute('y', String(arm.letter.y));
        line.setAttribute('opacity', String(arm.opacity));
        label.setAttribute('opacity', String(arm.opacity));
      }
    };
    state.apply = apply;

    const link: OrientationLink = {
      update(axes) {
        if (!state.overlayChanged) {
          // The SVG is what you see: it follows every frame.
          apply(axes);
          return;
        }
        // Painted by the viewer: the first push after a rest lands at once,
        // so a single programmatic turn is never late, and a stream of them
        // waits for the camera to settle.
        const now = performance.now();
        const resting = now - state.lastPush > HIT_LAYER_SETTLE_MS;
        state.lastPush = now;
        state.pending = axes;
        if (resting && state.timer === null) {
          catchUp();
          return;
        }
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = setTimeout(catchUp, HIT_LAYER_SETTLE_MS);
      },
      get element() {
        return svgRef.current;
      },
      get highlight() {
        return state.highlight;
      },
      attachOverlay(onChange) {
        const svg = svgRef.current;
        state.overlayChanged = onChange;
        if (svg) svg.dataset.overlay = 'viewer';
        // The overlay draws over the SVG's box, so anything that moves the
        // box without resizing the canvas has to ask for a frame: the docks
        // write their widths onto an ancestor's style, the inspector and the
        // column layout are classes, and the rail stack grows with its rows.
        const ancestors = new MutationObserver(onChange);
        for (
          let node = svg?.parentElement ?? null;
          node && node !== document.documentElement;
          node = node.parentElement
        ) {
          ancestors.observe(node, {
            attributes: true,
            attributeFilter: ['class', 'style']
          });
        }
        const resize =
          typeof ResizeObserver === 'undefined'
            ? null
            : new ResizeObserver(() => onChange());
        if (svg?.parentElement) resize?.observe(svg.parentElement);
        return () => {
          ancestors.disconnect();
          resize?.disconnect();
          if (state.overlayChanged === onChange) {
            state.overlayChanged = null;
            catchUp();
            if (svg) delete svg.dataset.overlay;
          }
        };
      }
    };
    orientationRef.current = link;
    return () => {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.pending = null;
      state.apply = null;
      if (orientationRef.current === link) orientationRef.current = null;
    };
  }, [catchUp]);

  /** Tells the viewer which facet to light, when that changes. */
  function setHighlight(next: Partial<CubeHighlight>) {
    const state = hitLayer.current;
    const merged = { ...state.highlight, ...next };
    if (
      sameFacet(merged.hovered, state.highlight.hovered) &&
      sameFacet(merged.focusVisible, state.highlight.focusVisible)
    ) {
      return;
    }
    state.highlight = merged;
    state.overlayChanged?.();
  }

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
    try {
      captureTarget.setPointerCapture(event.pointerId);
    } catch {
      // If capture cannot be established, abandon this gesture rather than
      // retaining a drag that can never receive a reliable finish event.
      dragRef.current = null;
      suppressFacetClickRef.current = true;
    }
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag) {
      // A hand reaching for the cube while it still turns (a view glide just
      // started by a click) finds the facets where they are drawn.
      catchUp();
      return;
    }
    if (drag.pointerId !== event.pointerId) {
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

  /** Facet click that respects an orbit drag released over the facet. */
  function selectFacet(target: ViewTarget) {
    if (suppressFacetClickRef.current) {
      suppressFacetClickRef.current = false;
      return;
    }
    onSelectView(target);
  }
  return (
    <div
      className="orientation-widget"
      role="group"
      aria-label="View orientation"
    >
      {/* A group, not the img an SVG with a title is by default: an img's
          children are presentational, which hid the face and corner buttons
          inside it from some screen readers. */}
      <svg
        ref={svgRef}
        role="group"
        className="orientation-cube"
        viewBox={`0 0 ${CUBE_SIZE} ${CUBE_SIZE}`}
        width={CUBE_SIZE}
        height={CUBE_SIZE}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointerDrag(event.pointerId, false, true)}
        onPointerCancel={(event) =>
          finishPointerDrag(event.pointerId, true, true)
        }
        onLostPointerCapture={(event) =>
          finishPointerDrag(event.pointerId, true, false)
        }
        onPointerOver={(event) =>
          setHighlight({ hovered: facetOf(event.target) })
        }
        onPointerLeave={() => setHighlight({ hovered: null })}
        onFocus={(event) =>
          setHighlight({
            focusVisible: showsFocusRing(event.target)
              ? facetOf(event.target)
              : null
          })
        }
        onBlur={() => setHighlight({ focusVisible: null })}
      >
        <title>Drag to rotate the view</title>
        {/* Occluded triad arms live under the opaque facets, which is what
            clips them to the cube's silhouette: only overhang shows. */}
        <g className="orientation-triad" ref={underLayerRef}>
          {AXIS_KEYS.map((key) => (
            <g key={key} ref={armGroupRefs[key]}>
              <line
                ref={armLineRefs[key]}
                x1={CUBE_SIZE / 2}
                y1={CUBE_SIZE / 2}
                x2={CUBE_SIZE / 2}
                y2={CUBE_SIZE / 2}
                stroke={AXIS_COLORS[key]}
                strokeWidth="2.2"
                strokeLinecap="round"
              />
              <text
                ref={armLabelRefs[key]}
                className="orientation-axis-label"
                x={CUBE_SIZE / 2}
                y={CUBE_SIZE / 2}
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
              data-facet={`face:${index}`}
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
          // The painted facet and the deeper cut that widens it. The click
          // lives on the group, so the target is the union of the two: the
          // cut's outline contains the facet, and the union keeps that true
          // for the facet's painted seam as well, so the target can never
          // be smaller than what is drawn. Hover and focus are styled off
          // the group too, so the drawn triangle lights up from anywhere in
          // the union.
          <g
            className="cube-corner-target"
            key={corner.label}
            data-facet={`corner:${index}`}
            onClick={() => {
              selectFacet({ corner: corner.corner });
            }}
          >
            <polygon
              ref={(element) => {
                cornerRefs.current[index] = element;
              }}
              className="cube-corner"
              style={{ display: 'none' }}
              aria-hidden="true"
            />
            <polygon
              ref={(element) => {
                cornerHitRefs.current[index] = element;
              }}
              className="cube-corner-hit"
              style={{ display: 'none' }}
              role="button"
              tabIndex={0}
              aria-label={corner.label}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectView({ corner: corner.corner });
                }
              }}
            />
          </g>
        ))}
        <g className="orientation-triad" ref={overLayerRef} />
      </svg>
    </div>
  );
}
