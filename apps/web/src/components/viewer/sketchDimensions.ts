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
import type { SketchDimensionAnnotation } from '../../lib/sketch/dimensionAnnotations';

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
export function avoidSketchDimensionOverlays(
  container: HTMLElement,
  occupiedRoot: HTMLElement | null = container.parentElement
) {
  const labels = [
    ...container.querySelectorAll<HTMLElement>('.sketch-dimension-label')
  ];
  if (labels.length === 0) return;
  const bounds = container.getBoundingClientRect();
  const occupied = occupiedRoot
    ? [
        ...occupiedRoot.querySelectorAll<HTMLElement>(
          '.viewer-rail-stack, .viewer-rail, .viewport-readout'
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
  move: (id: string, offset: { x: number; y: number }) => void = () => {}
) {
  const group = new THREE.Group();
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
    if (annotation.span) {
      const graphic = createDimensionGraphic({ color: 0x81a9ff });
      const start = world(annotation.span.start);
      const end = world(annotation.span.end);
      graphic.update(start, end, 1);
      group.add(graphic.object);
      spans.push({ graphic, start, end });
    }
    for (const points of annotation.lines) {
      const line = createFatLine(points.map(world), {
        color: 0x81a9ff,
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
    button.dataset.constraintId = annotation.id;
    button.dataset.dimensionKind = annotation.kind;
    button.textContent = `${annotation.label} · Driving`;
    button.setAttribute(
      'aria-label',
      `Edit driving ${annotation.kind}: ${annotation.label}`
    );
    button.title = 'Driving constraint target; click to edit';
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
          return;
        }
        if (dragged && latest) {
          move(annotation.id, {
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
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (dragged) {
        event.preventDefault();
        dragged = false;
        return;
      }
      const rect = button.getBoundingClientRect();
      edit(annotation.id, {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      });
    });
    const label = new CSS2DObject(button);
    label.position.copy(world(annotation.anchor));
    group.add(label);
  }
  group.traverse((child) => {
    child.raycast = () => undefined;
  });
  return {
    group,
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
