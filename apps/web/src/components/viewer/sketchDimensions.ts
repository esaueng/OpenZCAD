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

export function buildSketchDimensions(
  annotations: readonly SketchDimensionAnnotation[],
  basis: PlaneBasis,
  resolution: FatLineResolution,
  edit: (id: string, anchor: { x: number; y: number }) => void
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
      const graphic = createDimensionGraphic({ color: 0x7cc0ff });
      const start = world(annotation.span.start);
      const end = world(annotation.span.end);
      graphic.update(start, end, 1);
      group.add(graphic.object);
      spans.push({ graphic, start, end });
    }
    for (const points of annotation.lines) {
      const line = createFatLine(points.map(world), {
        color: 0x7cc0ff,
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
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('dblclick', (event) => event.stopPropagation());
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
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
    update(scaleAt: (point: THREE.Vector3) => number) {
      for (const span of spans)
        span.graphic.update(span.start, span.end, scaleAt(span.start));
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
