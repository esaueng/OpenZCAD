import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { PlaneBasis } from '@openzcad/geometry';
import { clearGroup } from '@openzcad/viewport';
import type { SketchRelationGlyphChip } from '../../lib/sketch/relationGlyphs';

/**
 * Relation glyphs as screen-space chips on the sketch plane. Decorative and
 * click-through: a chip sits on the curve or point it describes, so it must
 * never take the pick meant for that geometry. The constraint list stays the
 * interactive, accessible surface for the same relations.
 */
export function buildSketchRelationGlyphs(
  chips: readonly SketchRelationGlyphChip[],
  basis: PlaneBasis
) {
  const group = new THREE.Group();
  group.name = 'sketch-relation-glyphs';
  for (const chip of chips) {
    const element = document.createElement('span');
    element.className = 'sketch-relation-chip';
    element.dataset.placement = chip.placement;
    element.setAttribute('aria-hidden', 'true');
    for (const glyph of chip.glyphs) {
      const mark = document.createElement('span');
      mark.className = 'sketch-relation-glyph';
      mark.dataset.kind = glyph.kind;
      mark.dataset.constraintId = glyph.constraintId;
      if (glyph.conflicted) mark.dataset.conflicted = 'true';
      mark.textContent = glyph.symbol;
      element.append(mark);
    }
    const label = new CSS2DObject(element);
    label.position.set(
      basis.origin.x + basis.u.x * chip.anchor.x + basis.v.x * chip.anchor.y,
      basis.origin.y + basis.u.y * chip.anchor.x + basis.v.y * chip.anchor.y,
      basis.origin.z + basis.u.z * chip.anchor.x + basis.v.z * chip.anchor.y
    );
    group.add(label);
  }
  group.traverse((child) => {
    child.raycast = () => undefined;
  });
  return {
    group,
    dispose() {
      clearGroup(group);
    }
  };
}
