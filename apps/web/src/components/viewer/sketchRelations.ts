import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PlaneBasis } from '@openzcad/geometry';
import { clearGroup } from '@openzcad/viewport';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';
import {
  RELATION_CHIP_MAX_SWING,
  RELATION_CHIP_SWINGS,
  RELATION_GLYPH_PX,
  RelationGlyphLayout,
  relationChipWidth
} from '../../lib/sketch/relationGlyphLayout';
import { VIEWPORT_OBSTACLE_SELECTOR } from './sketchDimensions';

/**
 * How often the viewport controls glyphs avoid are re-measured while glyphs
 * are up. Measuring runs on its own timer, not in the draw, so a flyout that
 * opens or a panel that moves while the scene is idle still moves the glyphs.
 */
export const OBSTACLE_REFRESH_MS = 250;
/** Viewport controls measured; more are ignored. */
const MAX_OBSTACLES = 32;
/**
 * What glyphs keep out from under: the viewport controls dimension labels
 * avoid, plus the right lane's command card and inspector and the tool
 * palette, which float over the stage too (the keypad avoids the same).
 */
const GLYPH_OBSTACLE_SELECTOR = `${VIEWPORT_OBSTACLE_SELECTOR}, .command-float, .inspector-float, .palette-float`;

/** The sketch dimension labels, which glyphs keep out of every frame. */
export interface SketchLabelBoxes {
  labelCount: number;
  writeLabelBoxes(
    out: Float64Array,
    at: number,
    camera: THREE.Camera,
    width: number,
    height: number
  ): number;
}

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
  select: (constraintId: string) => void = () => {},
  /**
   * The selected relation's glyph has nowhere clear to show (every spot near
   * it is under a viewport control): drop the selection, so Delete never
   * acts on a relation whose glyph cannot be seen or clicked.
   */
  selectionHidden: (constraintId: string) => void = () => {},
  /**
   * The sketch's drawn curves as plane-local segments [x1, y1, x2, y2, …]
   * (`sketchRelationStrokes`): no glyph may sit over any of them.
   */
  strokes: Float64Array = new Float64Array(0)
) {
  const group = new THREE.Group();
  group.name = 'sketch-relation-glyphs';
  const count = chips.length;
  // World anchor and world normal per chip, fixed for the overlay's life,
  // and its world directions to project each frame: a curve chip's tangent,
  // or a point chip's swing directions, built in the sketch plane so they
  // stay inside its gap however the plane is viewed.
  const anchors = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  // Per point chip: its swing directions, then its gap's two edges.
  const SWING_COUNT = RELATION_CHIP_SWINGS.length + 2;
  const directions = new Float64Array(count * SWING_COUNT * 3);
  const screenSwings = new Float64Array(SWING_COUNT * 2);
  // One chip keeps the selected relation in view: a relation on several
  // chips (parallel, equal, symmetric) pins only its first, so two pinned
  // fallbacks never land on each other.
  const pinnedIndex = chips.findIndex((chip) =>
    chip.glyphs.some((glyph) => glyph.selected)
  );
  let selectionHiddenReported = false;
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
    const planeDirection = (x: number, y: number, entry: number) => {
      const d = (index * SWING_COUNT + entry) * 3;
      directions[d] = basis.u.x * x + basis.v.x * y;
      directions[d + 1] = basis.u.y * x + basis.v.y * y;
      directions[d + 2] = basis.u.z * x + basis.v.z * y;
    };
    if (chip.placement === 'point') {
      const swingStep = Math.min(
        RELATION_CHIP_MAX_SWING,
        0.5 * (chip.halfGap ?? Math.PI)
      );
      const halfGap = chip.halfGap ?? Math.PI;
      [
        ...RELATION_CHIP_SWINGS.map((fraction) => fraction * swingStep),
        -halfGap,
        halfGap
      ].forEach((angle, entry) => {
        planeDirection(
          chip.normal.x * Math.cos(angle) - chip.normal.y * Math.sin(angle),
          chip.normal.x * Math.sin(angle) + chip.normal.y * Math.cos(angle),
          entry
        );
      });
    } else {
      // The curve's tangent at its anchor: the normal turned a quarter.
      planeDirection(-chip.normal.y, chip.normal.x, 0);
    }
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
  // The viewport controls, as last measured, and the scratch a measurement
  // is compared in; each frame copies them into `blockedBoxes` and adds
  // that frame's dimension label boxes after them.
  const obstacles = new Float64Array(MAX_OBSTACLES * 4);
  const measured = new Float64Array(MAX_OBSTACLES * 4);
  let obstacleCount = 0;
  let blockedBoxes = new Float64Array((MAX_OBSTACLES + 16) * 4);
  let watch: ReturnType<typeof setInterval> | null = null;
  /**
   * Re-measures the viewer area's floating controls against the label
   * layer, and says whether any moved, appeared or went.
   */
  const refreshObstacles = (layer: HTMLElement): boolean => {
    const root = layer.closest('.viewer-area') ?? layer.parentElement;
    const origin = layer.getBoundingClientRect();
    let found = 0;
    for (const element of root?.querySelectorAll<HTMLElement>(
      GLYPH_OBSTACLE_SELECTOR
    ) ?? []) {
      if (found === MAX_OBSTACLES) break;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const at = found * 4;
      measured[at] = Math.round(rect.left - origin.left);
      measured[at + 1] = Math.round(rect.top - origin.top);
      measured[at + 2] = Math.round(rect.right - origin.left);
      measured[at + 3] = Math.round(rect.bottom - origin.top);
      found += 1;
    }
    let changed = found !== obstacleCount;
    for (let index = 0; !changed && index < found * 4; index += 1) {
      changed = measured[index] !== obstacles[index];
    }
    if (changed) {
      obstacles.set(measured);
      obstacleCount = found;
    }
    return changed;
  };
  // Stroke ends in world space, fixed for the overlay's life, and their
  // screen segments, rewritten each frame.
  const strokeCount = Math.floor(strokes.length / 4);
  const strokeWorld = new Float64Array(strokeCount * 6);
  for (let index = 0; index < strokeCount; index += 1) {
    toWorld(
      strokes[index * 4]!,
      strokes[index * 4 + 1]!,
      strokeWorld,
      index * 6
    );
    toWorld(
      strokes[index * 4 + 2]!,
      strokes[index * 4 + 3]!,
      strokeWorld,
      index * 6 + 3
    );
  }
  const strokeScreen = new Float64Array(strokeCount * 4);
  const clip = new THREE.Vector4();
  const clipEnd = new THREE.Vector4();
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
       * The dimension labels beside the glyphs. A driving dimension and a
       * relation on the same line both start at its middle; their boxes are
       * projected every frame (no DOM read) and kept clear.
       */
      dimensions?: SketchLabelBoxes | null
    ) {
      if (count === 0) return;
      const labels = dimensions?.labelCount ?? 0;
      if (blockedBoxes.length < (obstacleCount + labels) * 4) {
        // A rare growth step, when a rebuild brings more labels.
        blockedBoxes = new Float64Array((obstacleCount + labels) * 4 * 2);
      }
      for (let index = 0; index < obstacleCount * 4; index += 1) {
        blockedBoxes[index] = obstacles[index]!;
      }
      const labelBoxes =
        dimensions?.writeLabelBoxes(
          blockedBoxes,
          obstacleCount * 4,
          camera,
          width,
          height
        ) ?? 0;
      layout.setBlocked(blockedBoxes, obstacleCount + labelBoxes);
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
        let nx = (step.x * w - clip.x * step.w) * width;
        let ny = -(step.y * w - clip.y * step.w) * height;
        const point = chips[index]!.placement === 'point';
        const d = index * SWING_COUNT * 3;
        if (point) {
          for (let entry = 0; entry < SWING_COUNT; entry += 1) {
            step
              .set(
                directions[d + entry * 3]!,
                directions[d + entry * 3 + 1]!,
                directions[d + entry * 3 + 2]!,
                0
              )
              .applyMatrix4(view)
              .applyMatrix4(projection);
            screenSwings[entry * 2] = (step.x * w - clip.x * step.w) * width;
            screenSwings[entry * 2 + 1] =
              -(step.y * w - clip.y * step.w) * height;
          }
        } else {
          // A curve chip stands off square to the curve as drawn: the
          // perpendicular of its projected tangent, on the side its
          // projected normal points to. On an oblique view the projected
          // normal itself is no longer square to the curve.
          step
            .set(directions[d]!, directions[d + 1]!, directions[d + 2]!, 0)
            .applyMatrix4(view)
            .applyMatrix4(projection);
          const tx = (step.x * w - clip.x * step.w) * width;
          const ty = -(step.y * w - clip.y * step.w) * height;
          if (Math.hypot(tx, ty) > 1e-9 * (Math.abs(nx) + Math.abs(ny) + 1)) {
            const sign = -ty * nx + tx * ny >= 0 ? 1 : -1;
            nx = -ty * sign;
            ny = tx * sign;
          }
        }
        layout.set(
          index,
          (clip.x / w) * 0.5 * width + 0.5 * width,
          (-clip.y / w) * 0.5 * height + 0.5 * height,
          nx,
          ny,
          widths[index]!,
          RELATION_GLYPH_PX,
          point,
          visible,
          chips[index]!.halfGap
        );
        if (point) layout.setSwings(index, screenSwings, 0);
        if (index === pinnedIndex) layout.pin(index);
      }
      // The drawn curves, projected. A segment crossing the near plane is
      // clipped to it in clip space first, as the renderer draws its visible
      // part; only one wholly behind the camera is dropped (marked
      // non-finite, which the layout skips).
      for (let index = 0; index < strokeCount; index += 1) {
        const w = index * 6;
        clip
          .set(strokeWorld[w]!, strokeWorld[w + 1]!, strokeWorld[w + 2]!, 1)
          .applyMatrix4(view)
          .applyMatrix4(projection);
        clipEnd
          .set(strokeWorld[w + 3]!, strokeWorld[w + 4]!, strokeWorld[w + 5]!, 1)
          .applyMatrix4(view)
          .applyMatrix4(projection);
        // Signed distance to the near plane in clip space (z = −w).
        const nearA = clip.z + clip.w;
        const nearB = clipEnd.z + clipEnd.w;
        const s4 = index * 4;
        if (nearA < 0 && nearB < 0) {
          strokeScreen[s4] = Number.NaN;
          continue;
        }
        if (nearA < 0) clip.lerp(clipEnd, nearA / (nearA - nearB));
        else if (nearB < 0) clipEnd.lerp(clip, nearB / (nearB - nearA));
        if (!(clip.w > 0) || !(clipEnd.w > 0)) {
          strokeScreen[s4] = Number.NaN;
          continue;
        }
        strokeScreen[s4] = (clip.x / clip.w) * 0.5 * width + 0.5 * width;
        strokeScreen[s4 + 1] = (-clip.y / clip.w) * 0.5 * height + 0.5 * height;
        strokeScreen[s4 + 2] =
          (clipEnd.x / clipEnd.w) * 0.5 * width + 0.5 * width;
        strokeScreen[s4 + 3] =
          (-clipEnd.y / clipEnd.w) * 0.5 * height + 0.5 * height;
      }
      layout.setStrokes(strokeScreen, strokeCount);
      layout.solve(count, width, height);
      if (
        pinnedIndex >= 0 &&
        layout.shown[pinnedIndex] === 0 &&
        !selectionHiddenReported
      ) {
        selectionHiddenReported = true;
        const selected = chips[pinnedIndex]!.glyphs.find(
          (glyph) => glyph.selected
        );
        if (selected) selectionHidden(selected.constraintId);
      }
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
    refreshObstacles,
    /**
     * Keeps the viewport controls measured while the glyphs are up: now, and
     * then every {@link OBSTACLE_REFRESH_MS}, calling `changed` (to draw a
     * frame) only when a control moved, appeared or went. An idle scene
     * stays idle.
     */
    watchObstacles(layer: HTMLElement, changed: () => void) {
      if (watch !== null) clearInterval(watch);
      if (refreshObstacles(layer)) changed();
      watch = setInterval(() => {
        if (refreshObstacles(layer)) changed();
      }, OBSTACLE_REFRESH_MS);
    },
    dispose() {
      if (watch !== null) clearInterval(watch);
      watch = null;
      clearGroup(group);
    }
  };
}
