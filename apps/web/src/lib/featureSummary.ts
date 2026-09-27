import type { FeatureNode, ParamValue, UnitSystem } from '@openzcad/shared';
import { unitLabel } from './measurements';
import { evalParamValue, formatNumber } from './model';

/**
 * The one short value a history row shows beside a feature's name — the
 * extrude's distance, the fillet's radius — so a run of eight "Offset face"
 * rows can be told apart without opening each one.
 *
 * Lengths are in the document's own units, as every parametric value is
 * stored; angles are degrees. A value that does not evaluate returns null
 * rather than a guess: the row then shows nothing, never a wrong number.
 * Kinds without a single driving value (booleans, transforms, imports,
 * sketches) return null too.
 */
export function featureValueSummary(
  feature: FeatureNode,
  scope: Record<string, number>,
  units: UnitSystem
): string | null {
  const unit = unitLabel('length', units);
  const num = (value: ParamValue | undefined): string | null => {
    if (value === undefined) {
      return null;
    }
    const resolved = evalParamValue(value, scope);
    return resolved === null ? null : formatNumber(resolved);
  };
  const length = (value: ParamValue | undefined): string | null => {
    const text = num(value);
    return text === null ? null : `${text} ${unit}`;
  };
  const data = feature.data;
  switch (data.featureKind) {
    case 'primitive': {
      const d = (key: string) => num(data.dimensions[key]);
      switch (data.primitiveKind) {
        case 'box': {
          // makeBox(width, height, depth) is X × Y × Z; the form calls Y
          // "Depth" and Z "Height", so this reads width × depth × height.
          const [x, y, z] = [d('width'), d('height'), d('depth')];
          return x && y && z ? `${x} × ${y} × ${z} ${unit}` : null;
        }
        case 'cylinder': {
          const [r, h] = [d('radius'), d('height')];
          return r && h ? `r ${r} · h ${h} ${unit}` : null;
        }
        case 'sphere': {
          const r = d('radius');
          return r ? `r ${r} ${unit}` : null;
        }
        case 'cone': {
          const [r1, r2, h] = [d('bottomRadius'), d('topRadius'), d('height')];
          return r1 && r2 && h ? `r ${r1}/${r2} · h ${h} ${unit}` : null;
        }
        case 'torus': {
          const [major, minor] = [d('majorRadius'), d('minorRadius')];
          return major && minor ? `R ${major} · r ${minor} ${unit}` : null;
        }
      }
      return null;
    }
    case 'extrude': {
      const distance = num(data.distance);
      if (distance === null) {
        return null;
      }
      if (data.symmetric) {
        return `${distance} ${unit} symmetric`;
      }
      const back =
        data.backDistance === undefined ? null : num(data.backDistance);
      return back !== null && back !== '0'
        ? `${distance} + ${back} ${unit}`
        : `${distance} ${unit}`;
    }
    case 'revolve': {
      // Absent means a full turn (see FeatureData).
      const angle = data.angleDeg === undefined ? '360' : num(data.angleDeg);
      return angle === null ? null : `${angle}°`;
    }
    case 'helical-sweep': {
      const turns = num(data.turns);
      return turns === null ? null : `${turns} turns`;
    }
    case 'hole': {
      const diameter = num(data.diameter);
      if (diameter === null) {
        return null;
      }
      if (data.depthMode === 'through') {
        return `⌀ ${diameter} ${unit} through`;
      }
      const depth = num(data.depth);
      return depth === null ? null : `⌀ ${diameter} × ${depth} ${unit}`;
    }
    case 'shell':
    case 'thicken':
      return length(data.thickness);
    case 'solid-offset':
      return length(data.distance);
    case 'draft': {
      const angle = num(data.angleDeg);
      return angle === null ? null : `${angle}°`;
    }
    case 'fillet': {
      const radius = num(data.radius);
      if (radius === null) {
        return null;
      }
      const end = data.endRadius === undefined ? null : num(data.endRadius);
      return end !== null
        ? `r ${radius}–${end} ${unit}`
        : `r ${radius} ${unit}`;
    }
    case 'chamfer': {
      const distance = num(data.distance);
      if (distance === null) {
        return null;
      }
      const second = data.distance2 === undefined ? null : num(data.distance2);
      if (second !== null) {
        return `${distance} × ${second} ${unit}`;
      }
      const angle = data.angleDeg === undefined ? null : num(data.angleDeg);
      return angle !== null
        ? `${distance} ${unit} × ${angle}°`
        : `${distance} ${unit}`;
    }
    case 'pattern': {
      const count = num(data.count);
      if (count === null) {
        return null;
      }
      if (data.patternKind === 'grid') {
        // Absent count2 reads as count (see FeatureData).
        const count2 = data.count2 === undefined ? count : num(data.count2);
        return count2 === null ? null : `${count} × ${count2}`;
      }
      return `× ${count}`;
    }
    default:
      return null;
  }
}
