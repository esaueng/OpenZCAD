import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PlaneBasis } from '@openzcad/geometry';
import { clearGroup } from '@openzcad/viewport';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';
import {
  MAX_BLOCKED,
  RELATION_GLYPH_PX,
  RelationGlyphLayout,
  relationChipWidth
} from '../../lib/sketch/relationGlyphLayout';
import { VIEWPORT_OBSTACLE_SELECTOR } from './sketchDimensions';

/** How often the viewport controls glyphs avoid are re-measured. */
const OBSTACLE_REFRESH_MS = 200;

/**
 * Relation glyphs as screen-space chips on the sketch plane. Each glyph is a
 * button that selects its relation (Delete then removes it). Chips stand off
 * the curve or point they describe, laid out every drawn frame so they never
 * cover that geometry or each other, which is what lets them take clicks;
 * the chip itself stays click-through between its glyphs. The constraint list
 * stays the keyboard surface for the same relations, so glyphs are not tab
 * stops.
 */
export function buildSketchRelationGlyphs(
  chips: readonly SketchRelationGlyphChip[],
  basis: PlaneBasis,
  select: (constraintId: string) => void = () => {}
) {
  const group = new THREE.Group();
  group.name = 'sketch-relation-glyphs';
  const count = chips.length;
  // World anchor and world normal per chip, fixed for the overlay's life.
  const anchors = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  const widths = new Float64Array(count);
  const elements: HTMLElement[] = [];
  // The last offset written per chip, so a still frame writes no style.
  const written = new Float64Array(count * 2).fill(Number.NaN);
  // Whether each chip was last drawn (1) or hidden for want of room (0).
  const writtenShown = new Int8Array(count).fill(-1);
  const layout = new RelationGlyphLayout(count);
  const toWorld = (x: number, y: number, out: Float64Array, at: number) => {
    out[at] = basis.origin.x + basis.u.x * x + basis.v.x * y;
    out[at + 1] = basis.origin.y + basis.u.y * x + basis.v.y * y;
    out[at + 2] = basis.origin.z + basis.u.z * x + basis.v.z * y;
  };
  chips.forEach((chip, index) => {
    const element = document.createElement('span');
    element.className = 'sketch-relation-chip';
    element.dataset.placement = chip.placement;
    element.dataset.chipKey = chip.key;
    for (const glyph of chip.glyphs) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.tabIndex = -1;
      mark.className = 'sketch-relation-glyph';
      mark.dataset.kind = glyph.kind;
      mark.dataset.constraintId = glyph.constraintId;
      if (glyph.conflicted) mark.dataset.conflicted = 'true';
      if (glyph.selected) mark.dataset.selected = 'true';
      mark.setAttribute('aria-pressed', glyph.selected ? 'true' : 'false');
      mark.setAttribute(
        'aria-label',
        `${glyph.label} relation${glyph.conflicted ? ' · solver residual' : ''}`
      );
      mark.title = `${glyph.label} · click to select, Delete removes it`;
      mark.textContent = glyph.symbol;
      // The canvas never sees a press on a glyph, but the host does: keep
      // the press and its double-click from reaching sketch gestures there.
      mark.addEventListener('pointerdown', (event) => event.stopPropagation());
      mark.addEventListener('dblclick', (event) => event.stopPropagation());
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        select(glyph.constraintId);
      });
      element.append(mark);
    }
    elements.push(element);
    widths[index] = relationChipWidth(chip.glyphs.length);
    toWorld(chip.anchor.x, chip.anchor.y, anchors, index * 3);
    const at = index * 3;
    normals[at] = basis.u.x * chip.normal.x + basis.v.x * chip.normal.y;
    normals[at + 1] = basis.u.y * chip.normal.x + basis.v.y * chip.normal.y;
    normals[at + 2] = basis.u.z * chip.normal.x + basis.v.z * chip.normal.y;
    const label = new CSS2DObject(element);
    label.position.set(
      anchors[index * 3]!,
      anchors[index * 3 + 1]!,
      anchors[index * 3 + 2]
    );
    group.add(label);
  });
  group.traverse((child) => {
    child.raycast = () => undefined;
  });
  let obstaclesAt = Number.NEGATIVE_INFINITY;
  const obstacles = new Float64Array(MAX_BLOCKED * 4);
  const measureObstacles = (layer: HTMLElement) => {
    const root = layer.closest('.viewer-area') ?? layer.parentElement;
    const origin = layer.getBoundingClientRect();
    let found = 0;
    for (const element of root?.querySelectorAll<HTMLElement>(
      VIEWPORT_OBSTACLE_SELECTOR
    ) ?? []) {
      if (found === MAX_BLOCKED) break;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const at = found * 4;
      obstacles[at] = rect.left - origin.left;
      obstacles[at + 1] = rect.top - origin.top;
      obstacles[at + 2] = rect.right - origin.left;
      obstacles[at + 3] = rect.bottom - origin.top;
      found += 1;
    }
    layout.setBlocked(obstacles, found);
  };
  const clip = new THREE.Vector4();
  const step = new THREE.Vector4();
  return {
    group,
    /**
     * Lays the chips out for this frame's camera. CSS2DRenderer owns each
     * chip's `transform` and centres it on its anchor; the standoff rides
     * on the independent `translate` property, rewritten only when it moves.
     */
    layout(
      camera: THREE.Camera,
      width: number,
      height: number,
      /**
       * The label layer. Its viewer area's floating controls are measured
       * at most every {@link OBSTACLE_REFRESH_MS}, not every frame: a read
       * would force layout and allocate, and controls move rarely.
       */
      layer?: HTMLElement
    ) {
      if (count === 0) return;
      if (layer) {
        const now = performance.now();
        if (now - obstaclesAt >= OBSTACLE_REFRESH_MS) {
          obstaclesAt = now;
          measureObstacles(layer);
        }
      }
      // The screen direction of each normal is the projection's derivative
      // along it, taken exactly in clip space: no probe point, so nothing
      // can cross the eye plane and flip, however far the sketch sits from
      // the origin or however close the camera is.
      const view = camera.matrixWorldInverse;
      const projection = camera.projectionMatrix;
      for (let index = 0; index < count; index += 1) {
        const at = index * 3;
        clip
          .set(anchors[at]!, anchors[at + 1]!, anchors[at + 2]!, 1)
          .applyMatrix4(view)
          .applyMatrix4(projection);
        step
          .set(normals[at]!, normals[at + 1]!, normals[at + 2]!, 0)
          .applyMatrix4(view)
          .applyMatrix4(projection);
        const w = clip.w;
        const visible = w > 0 && Math.abs(clip.z / w) <= 1;
        // d(ndc) = (d·w − clip·dw) / w²; w² > 0 only scales it, so drop it.
        layout.set(
          index,
          (clip.x / w) * 0.5 * width + 0.5 * width,
          (-clip.y / w) * 0.5 * height + 0.5 * height,
          (step.x * w - clip.x * step.w) * width,
          -(step.y * w - clip.y * step.w) * height,
          widths[index]!,
          RELATION_GLYPH_PX,
          chips[index]!.placement === 'point',
          visible
        );
      }
      layout.solve(count, width, height);
      const offset = layout.offset;
      const shown = layout.shown;
      for (let index = 0; index < count; index += 1) {
        if (writtenShown[index] !== shown[index]) {
          writtenShown[index] = shown[index]!;
          // `visibility`, not `display`: CSS2DRenderer owns `display` for
          // its frustum test. A hidden glyph takes no clicks either.
          elements[index]!.style.visibility = shown[index] ? '' : 'hidden';
        }
        const dx = Math.round(offset[index * 2]!);
        const dy = Math.round(offset[index * 2 + 1]!);
        if (written[index * 2] === dx && written[index * 2 + 1] === dy) {
          continue;
        }
        written[index * 2] = dx;
        written[index * 2 + 1] = dy;
        elements[index]!.style.setProperty('translate', `${dx}px ${dy}px`);
      }
    },
    dispose() {
      clearGroup(group);
    }
  };
}
