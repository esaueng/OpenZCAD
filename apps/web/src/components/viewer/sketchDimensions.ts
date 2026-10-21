import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PlaneBasis } from '@openzcad/geometry';
import {
  clearGroup,
  createDimensionGraphic,
  createFatLine,
  type DimensionGraphic,
  type FatLineResolution
} from '@openzcad/viewport';
import { MODEL_PANEL_OBSTACLES } from '../../lib/selectionCalloutView';
import type { SketchDimensionAnnotation } from '../../lib/sketch/dimensionAnnotations';
import {
  toSketchConstraintId,
  type SketchDimensionIdentity
} from '@openzcad/shared';

interface LayoutRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: LayoutRect, b: LayoutRect) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

/**
 * Keeps a persisted dimension offset usable when its projected label lands
 * below a viewport control. The stored plane-local offset remains untouched;
 * this is a presentation-only margin correction, recalculated from the
 * CSS2DRenderer transform on every frame like the other callout clamps.
 */
/**
 * Viewport controls drawn above the label layer. Labels and glyphs keep out
 * from under them, since a control there takes their clicks.
 */
export const VIEWPORT_OBSTACLE_SELECTOR = `.viewer-rail-stack, .viewer-rail, .viewport-readout, .sketch-relations, .sketch-flyouts, ${MODEL_PANEL_OBSTACLES}, .workspace-column-float`;

export function avoidSketchDimensionOverlays(
  container: HTMLElement,
  occupiedRoot: HTMLElement | null = container.closest('.viewer-area') ??
    container.parentElement
) {
  const labels = [
    ...container.querySelectorAll<HTMLElement>('.sketch-dimension-label')
  ];
  if (labels.length === 0) return;
  const bounds = container.getBoundingClientRect();
  const occupied = occupiedRoot
    ? [
        ...occupiedRoot.querySelectorAll<HTMLElement>(
          VIEWPORT_OBSTACLE_SELECTOR
        )
      ]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
    : [];
  const pad = 4;
  const gap = 8;
  const clamp = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  for (const label of labels) {
    const marginLeft = parseFloat(label.style.marginLeft) || 0;
    const marginTop = parseFloat(label.style.marginTop) || 0;
    const rect = label.getBoundingClientRect();
    // CSS2DRenderer owns transform; subtracting our previous margin recovers
    // the stable projected box so corrections do not accumulate.
    const base: LayoutRect = {
      left: rect.left - marginLeft,
      right: rect.right - marginLeft,
      top: rect.top - marginTop,
      bottom: rect.bottom - marginTop
    };
    const minLeft = bounds.left + pad - base.left;
    const maxLeft = bounds.right - pad - base.right;
    const minTop = bounds.top + pad - base.top;
    const maxTop = bounds.bottom - pad - base.bottom;
    const shift = (left: number, top: number): LayoutRect => ({
      left: base.left + left,
      right: base.right + left,
      top: base.top + top,
      bottom: base.bottom + top
    });
    const initial = {
      left: clamp(0, minLeft, maxLeft),
      top: clamp(0, minTop, maxTop)
    };
    let next = initial;
    if (
      occupied.some((overlay) => overlaps(shift(next.left, next.top), overlay))
    ) {
      const candidates: { left: number; top: number }[] = [];
      for (const overlay of occupied) {
        candidates.push(
          { left: overlay.right + gap - base.left, top: initial.top },
          { left: overlay.left - gap - base.right, top: initial.top },
          { left: initial.left, top: overlay.bottom + gap - base.top },
          { left: initial.left, top: overlay.top - gap - base.bottom }
        );
      }
      const usable = candidates
        .map((candidate) => ({
          left: clamp(candidate.left, minLeft, maxLeft),
          top: clamp(candidate.top, minTop, maxTop)
        }))
        .filter(
          (candidate) =>
            !occupied.some((overlay) =>
              overlaps(shift(candidate.left, candidate.top), overlay)
            )
        );
      if (usable.length > 0) {
        next = usable.reduce((best, candidate) =>
          Math.abs(candidate.left - initial.left) +
            Math.abs(candidate.top - initial.top) <
          Math.abs(best.left - initial.left) + Math.abs(best.top - initial.top)
            ? candidate
            : best
        );
      }
    }
    if (next.left !== marginLeft) {
      label.style.marginLeft = next.left ? `${next.left}px` : '';
    }
    if (next.top !== marginTop) {
      label.style.marginTop = next.top ? `${next.top}px` : '';
    }
  }
}

export function buildSketchDimensions(
  annotations: readonly SketchDimensionAnnotation[],
  basis: PlaneBasis,
  resolution: FatLineResolution,
  edit: (id: string, anchor: { x: number; y: number }) => void,
  screenToPlane: (
    clientX: number,
    clientY: number
  ) => { x: number; y: number } | null = () => null,
  move: (
    identity: SketchDimensionIdentity,
    offset: { x: number; y: number }
  ) => void = () => {}
) {
  const group = new THREE.Group();
  const referenceLabels = new Map<string, HTMLButtonElement>();
  const placedLabels: CSS2DObject[] = [];
  group.name = 'sketch-dimensions';
  const spans: {
    graphic: DimensionGraphic;
    start: THREE.Vector3;
    end: THREE.Vector3;
  }[] = [];
  const world = (point: { x: number; y: number }) =>
    new THREE.Vector3(
      basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
      basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
      basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
    );
  for (const annotation of annotations) {
    const identity = annotation.identity ?? {
      kind: 'constraint',
      constraintId: toSketchConstraintId(annotation.id)
    };
    const reference = identity.kind === 'reference';
    const color = reference ? 0xb3c4d6 : 0x81a9ff;
    if (annotation.span) {
      const graphic = createDimensionGraphic({ color });
      const start = world(annotation.span.start);
      const end = world(annotation.span.end);
      graphic.update(start, end, 1);
      group.add(graphic.object);
      spans.push({ graphic, start, end });
    }
    for (const points of annotation.lines) {
      const line = createFatLine(points.map(world), {
        color,
        linewidth: 1.5,
        depthTest: false,
        resolution
      });
      line.renderOrder = 30;
      group.add(line);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sketch-dimension-label';
    if (reference) button.dataset.annotationId = annotation.id;
    else button.dataset.constraintId = annotation.id;
    button.dataset.dimensionRole = reference ? 'reference' : 'driving';
    button.dataset.dimensionKind = annotation.kind;
    button.textContent = `${annotation.label} · ${reference ? 'Reference' : 'Driving'}`;
    button.setAttribute(
      'aria-label',
      reference
        ? `Reference ${annotation.kind}, ${annotation.label}`
        : `Edit driving ${annotation.kind}: ${annotation.label}`
    );
    button.title = reference
      ? 'Measured reference; edit geometry to change its value. Drag or use arrow keys to move this label.'
      : 'Driving constraint target; click to edit';
    if (reference) referenceLabels.set(annotation.id, button);
    button.style.touchAction = 'none';
    let dragged = false;
    button.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (event.button !== 0) return;
      // A canceled pointer sequence does not produce the click that clears
      // this flag. Reset at the start of every new sequence as well.
      dragged = false;
      const pointerId = event.pointerId;
      let latest = screenToPlane(event.clientX, event.clientY);
      const startX = event.clientX;
      const startY = event.clientY;
      const dragLabel = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        if (
          !dragged &&
          Math.hypot(next.clientX - startX, next.clientY - startY) < 3
        ) {
          return;
        }
        dragged = true;
        latest = screenToPlane(next.clientX, next.clientY) ?? latest;
        if (latest) {
          label.position.copy(world(latest));
        }
      };
      const finishLabelDrag = (next: PointerEvent) => {
        if (next.pointerId !== pointerId) return;
        document.removeEventListener('pointermove', dragLabel);
        document.removeEventListener('pointerup', finishLabelDrag);
        document.removeEventListener('pointercancel', finishLabelDrag);
        if (next.type === 'pointercancel') {
          dragged = false;
          label.position.copy(world(annotation.anchor));
          return;
        }
        if (dragged && latest) {
          move(identity, {
            x: latest.x - (annotation.baseAnchor ?? annotation.anchor).x,
            y: latest.y - (annotation.baseAnchor ?? annotation.anchor).y
          });
        }
      };
      document.addEventListener('pointermove', dragLabel);
      document.addEventListener('pointerup', finishLabelDrag);
      document.addEventListener('pointercancel', finishLabelDrag);
    });
    button.addEventListener('dblclick', (event) => event.stopPropagation());
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      if (
        reference &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        move(identity, {
          x:
            (annotation.labelOffset?.x ?? 0) +
            (event.key === 'ArrowRight'
              ? step
              : event.key === 'ArrowLeft'
                ? -step
                : 0),
          y:
            (annotation.labelOffset?.y ?? 0) +
            (event.key === 'ArrowUp'
              ? step
              : event.key === 'ArrowDown'
                ? -step
                : 0)
        });
      }
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (dragged) {
        event.preventDefault();
        dragged = false;
        return;
      }
      const rect = button.getBoundingClientRect();
      if (reference) return;
      edit(annotation.id, {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      });
    });
    const label = new CSS2DObject(button);
    label.position.copy(world(annotation.anchor));
    group.add(label);
    placedLabels.push(label);
  }
  group.traverse((child) => {
    child.raycast = () => undefined;
  });
  // Each label's laid-out size, read once it has one: a label's text only
  // changes with a rebuild, so per-frame boxes need no DOM read.
  const sizes = new Float64Array(placedLabels.length * 2);
  const scratch = new THREE.Vector3();
  return {
    group,
    /** How many boxes {@link writeLabelBoxes} can write. */
    labelCount: placedLabels.length,
    /**
     * Writes each on-screen label's box as [left, top, right, bottom] in
     * viewport pixels into `out` from `at`, and returns how many it wrote.
     * The relation glyphs keep out of them. Allocates nothing.
     */
    writeLabelBoxes(
      out: Float64Array,
      at: number,
      camera: THREE.Camera,
      width: number,
      height: number
    ): number {
      let written = 0;
      placedLabels.forEach((label, index) => {
        const element = label.element;
        if (sizes[index * 2] === 0) {
          sizes[index * 2] = element.offsetWidth;
          sizes[index * 2 + 1] = element.offsetHeight;
        }
        const w = sizes[index * 2]!;
        const h = sizes[index * 2 + 1]!;
        if (w === 0) return;
        scratch.copy(label.position).project(camera);
        if (scratch.z < -1 || scratch.z > 1) return;
        // CSS2DRenderer centres the label on its point; the overlay clamp
        // above shifts it by its margins.
        const cx =
          (scratch.x * 0.5 + 0.5) * width +
          (parseFloat(element.style.marginLeft) || 0);
        const cy =
          (-scratch.y * 0.5 + 0.5) * height +
          (parseFloat(element.style.marginTop) || 0);
        const o = at + written * 4;
        out[o] = cx - w / 2;
        out[o + 1] = cy - h / 2;
        out[o + 2] = cx + w / 2;
        out[o + 3] = cy + h / 2;
        written += 1;
      });
      return written;
    },
    focusReference(id: string) {
      referenceLabels.get(id)?.focus({ preventScroll: true });
    },
    update(scaleAt: (point: THREE.Vector3) => number, camera?: THREE.Camera) {
      for (const span of spans) {
        if (camera) {
          span.graphic.orient(camera);
        }
        span.graphic.update(span.start, span.end, scaleAt(span.start));
      }
    },
    dispose() {
      for (const span of spans) {
        group.remove(span.graphic.object);
        span.graphic.dispose();
      }
      clearGroup(group);
    }
  };
}
