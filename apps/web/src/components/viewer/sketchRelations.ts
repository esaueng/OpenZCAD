import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PlaneBasis } from '@openzcad/geometry';
import { clearGroup } from '@openzcad/viewport';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';
import {
  RELATION_GLYPH_PX,
  RelationGlyphLayout,
  relationChipWidth
} from '../../lib/sketch/relationGlyphLayout';

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
  // World anchor and anchor + normal per chip, fixed for the overlay's life.
  const anchors = new Float64Array(count * 3);
  const tips = new Float64Array(count * 3);
  const widths = new Float64Array(count);
  const elements: HTMLElement[] = [];
  // The last offset written per chip, so a still frame writes no style.
  const written = new Float64Array(count * 2).fill(Number.NaN);
  const layout = new RelationGlyphLayout(count);
  const tipLength = probeLength(chips, basis);
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
    toWorld(
      chip.anchor.x + chip.normal.x * tipLength,
      chip.anchor.y + chip.normal.y * tipLength,
      tips,
      index * 3
    );
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
  const scratch = new THREE.Vector3();
  return {
    group,
    /**
     * Lays the chips out for this frame's camera. CSS2DRenderer owns each
     * chip's `transform` and centres it on its anchor; the standoff rides
     * on the independent `translate` property, rewritten only when it moves.
     */
    layout(camera: THREE.Camera, width: number, height: number) {
      if (count === 0) return;
      for (let index = 0; index < count; index += 1) {
        const at = index * 3;
        scratch.set(anchors[at]!, anchors[at + 1]!, anchors[at + 2]);
        scratch.project(camera);
        const visible = scratch.z >= -1 && scratch.z <= 1;
        const ax = (scratch.x * 0.5 + 0.5) * width;
        const ay = (-scratch.y * 0.5 + 0.5) * height;
        scratch.set(tips[at]!, tips[at + 1]!, tips[at + 2]);
        scratch.project(camera);
        layout.set(
          index,
          ax,
          ay,
          (scratch.x * 0.5 + 0.5) * width - ax,
          (-scratch.y * 0.5 + 0.5) * height - ay,
          widths[index]!,
          RELATION_GLYPH_PX,
          chips[index]!.placement === 'point',
          visible
        );
      }
      layout.solve(count);
      const offset = layout.offset;
      for (let index = 0; index < count; index += 1) {
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

/**
 * How far along its normal a chip's direction probe reaches: a thousandth of
 * the chips' span, so it stays beside the geometry (and in front of a
 * perspective camera looking at it) however far the sketch sits from the
 * plane or world origin. The floor keeps a lone chip's probe nonzero, and the
 * magnitude term keeps it well above rounding at large coordinates.
 */
export function probeLength(
  chips: readonly SketchRelationGlyphChip[],
  basis: PlaneBasis
): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { anchor } of chips) {
    minX = Math.min(minX, anchor.x);
    minY = Math.min(minY, anchor.y);
    maxX = Math.max(maxX, anchor.x);
    maxY = Math.max(maxY, anchor.y);
  }
  if (!Number.isFinite(minX)) return 1e-3;
  const span = Math.max(maxX - minX, maxY - minY);
  const magnitude = Math.max(
    Math.abs(minX),
    Math.abs(minY),
    Math.abs(maxX),
    Math.abs(maxY),
    Math.abs(basis.origin.x),
    Math.abs(basis.origin.y),
    Math.abs(basis.origin.z)
  );
  return Math.max(span * 1e-3, 1e-6, magnitude * 1e-9);
}
