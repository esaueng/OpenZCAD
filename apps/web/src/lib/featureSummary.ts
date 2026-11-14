import {
  ownEntry,
  type BooleanOperation,
  type DirectEditOperation,
  type EdgeTopologyReferenceV5,
  type FeatureNode,
  type ParamValue,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import { pipeThreadLabel } from '@openzcad/shared';
import { edgeSelectionName, storedLoopEdges } from './edgeLoops';
import { unitLabel } from './measurements';
import { evalParamValue, formatNumber } from './model';

/**
 * "5 edges · R 2 mm": a blend over several edges says how many, so two
 * fillets of one radius still read apart. A single edge needs no count.
 *
 * A rim a boolean split into four arcs is the one closed edge the user
 * clicked, and the readout said so; the row reads "closed edge · R 3.8 mm"
 * rather than a count of arcs. Without stored witnesses for every edge the
 * row keeps the plain count.
 */
function withEdgeCount(
  edgeHashes: readonly number[] | undefined,
  edgeReferences: readonly EdgeTopologyReferenceV5[] | undefined,
  value: string
): string {
  const count = new Set(edgeHashes ?? []).size;
  if (count < 2) return value;
  const edges = storedLoopEdges(edgeHashes, edgeReferences);
  // The readout's own label, lower-cased to sit mid-row: "closed edge".
  const named = edges ? edgeSelectionName(edges).label : `${count} edges`;
  const label = `${named[0]!.toLowerCase()}${named.slice(1)}`;
  return `${label} · ${value}`;
}

const BOOLEAN_JOINERS: Record<BooleanOperation, string> = {
  union: ' + ',
  subtract: ' − ',
  intersect: ' ∩ '
};

/**
 * A Boolean's operands by name, "Box 1 + Cylinder 1" (a subtract reads
 * target − tools), or how many there are when any one cannot be named.
 */
function booleanOperands(
  operation: BooleanOperation,
  bodyIds: readonly string[],
  bodyName?: (bodyId: string) => string | undefined
): string | null {
  if (bodyIds.length === 0) return null;
  const names = bodyIds.map((bodyId) => bodyName?.(bodyId)?.trim());
  if (names.every((name): name is string => Boolean(name))) {
    return names.join(ownEntry(BOOLEAN_JOINERS, operation) ?? ', ');
  }
  return `${bodyIds.length} bod${bodyIds.length === 1 ? 'y' : 'ies'}`;
}

/** The app's Z-up face names, as the selection readout gives them. */
const NORMAL_FACE_NAMES: Record<string, string> = {
  'z:1': 'Top',
  'z:-1': 'Bottom',
  'x:1': 'Right',
  'x:-1': 'Left',
  'y:1': 'Back',
  'y:-1': 'Front'
};

/** "box.face.x-max" and its kin, for a face whose normal is not on an axis. */
const LINEAGE_FACE_NAMES: Record<string, string> = {
  'z-max': 'Top',
  'z-min': 'Bottom',
  'x-max': 'Right',
  'x-min': 'Left',
  'y-max': 'Back',
  'y-min': 'Front'
};

function faceDirectionName(
  normal: Vector3 | undefined,
  lineageName: string | undefined
): string | null {
  if (normal) {
    const magnitude = Math.hypot(normal.x, normal.y, normal.z);
    if (magnitude > 1e-9) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const component = normal[axis] / magnitude;
        if (Math.abs(component) >= 0.999) {
          return NORMAL_FACE_NAMES[`${axis}:${component > 0 ? 1 : -1}`]!;
        }
      }
    }
  }
  const side = /\.face\.([xyz]-(?:min|max))$/.exec(lineageName ?? '')?.[1];
  return side ? LINEAGE_FACE_NAMES[side]! : null;
}

/**
 * The face a direct edit moved and by how much, so a run of seven
 * "Offset face" rows reads "Bottom · +12.5 mm", "Right · −13.5 mm" … rather
 * than seven identical names.
 */
function directEditSummary(
  operation: DirectEditOperation,
  num: (value: ParamValue | undefined) => string | null,
  unit: string
): string | null {
  switch (operation.kind) {
    case 'offset-face': {
      const offset = num(operation.offset);
      if (offset === null) return null;
      const signed = offset.startsWith('-')
        ? `−${offset.slice(1)}`
        : offset === '0'
          ? offset
          : `+${offset}`;
      const face = faceDirectionName(
        operation.sourceNormal,
        operation.faceReference?.lineageName
      );
      return face ? `${face} · ${signed} ${unit}` : `${signed} ${unit}`;
    }
    case 'set-face-distance': {
      const distance = num(operation.distance);
      return distance === null ? null : `${distance} ${unit} apart`;
    }
    case 'resize-cylindrical-face':
    case 'resize-blend': {
      const radius = num(
        operation.kind === 'resize-blend'
          ? operation.newRadius
          : operation.radius
      );
      return radius === null ? null : `r ${radius} ${unit}`;
    }
    case 'resize-through-hole':
    case 'resize-imported-blind-hole': {
      const diameter = num(operation.diameter);
      return diameter === null ? null : `⌀ ${diameter} ${unit}`;
    }
    default:
      return null;
  }
}

/**
 * The one short value a history row shows beside a feature's name — the
 * extrude's distance, the fillet's radius — so a run of eight "Offset face"
 * rows can be told apart without opening each one.
 *
 * Lengths are in the document's own units, as every parametric value is
 * stored; angles are degrees. A value that does not evaluate returns null
 * rather than a guess: the row then shows nothing, never a wrong number.
 * A Boolean names its operands instead of a value; other kinds without a
 * single driving value (transforms, imports, sketches) return null.
 */
export function featureValueSummary(
  feature: FeatureNode,
  scope: Record<string, number>,
  units: UnitSystem,
  /**
   * A body's display name, for the kinds whose inputs are bodies (a
   * Boolean's operands). Without it, or for a body it cannot name, those
   * rows fall back to a count.
   */
  bodyName?: (bodyId: string) => string | undefined
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
  const lengthValue = (value: ParamValue | undefined): string | null => {
    if (value === undefined) {
      return null;
    }
    const resolved = evalParamValue(value, scope, {
      documentUnits: units,
      dimension: 'length'
    });
    return resolved === null ? null : formatNumber(resolved);
  };
  const data = feature.data;
  switch (data.featureKind) {
    case 'primitive': {
      // Primitive sizes are lengths, so a suffixed size summarises in
      // document units as the kernel builds it.
      const d = (key: string) => lengthValue(data.dimensions[key] ?? '');
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
      if (data.endCondition === 'through-all') {
        return data.throughAllSide === 'both'
          ? 'Through all, both sides'
          : 'Through all';
      }
      // F01 (v29): a draft rides after the extent, in degrees.
      const angle =
        data.draftAngleDeg === undefined ? null : num(data.draftAngleDeg);
      const drafted = (extent: string) =>
        angle !== null && angle !== '0'
          ? `${extent} · ${angle}° draft`
          : extent;
      if (data.endCondition === 'to-face') {
        return drafted('To face');
      }
      const distance = lengthValue(data.distance);
      if (distance === null) {
        return null;
      }
      if (data.symmetric) {
        return `${distance} ${unit} symmetric`;
      }
      const back =
        data.backDistance === undefined ? '0' : lengthValue(data.backDistance);
      if (back === null) {
        return null;
      }
      return back !== '0'
        ? `${distance} + ${back} ${unit}`
        : drafted(`${distance} ${unit}`);
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
    case 'gear': {
      const teeth = num(data.teeth);
      if (teeth === null) return null;
      if (data.gearType === 'worm') {
        return teeth === '1' ? 'Worm, 1 start' : `Worm, ${teeth} starts`;
      }
      if (data.gearType === 'enveloping-worm') {
        const starts = teeth === '1' ? '1 start' : `${teeth} starts`;
        const wheel = data.mateTeeth === undefined ? null : num(data.mateTeeth);
        return wheel === null
          ? `Enveloping worm, ${starts}`
          : `Enveloping worm, ${starts}, for ${wheel}-tooth wheel`;
      }
      if (data.gearType === 'enveloping-wheel') {
        const starts =
          data.mateTeeth === undefined ? null : num(data.mateTeeth);
        return starts === null
          ? `${teeth} teeth, enveloping wheel`
          : `${teeth} teeth, enveloping wheel for ${starts}-start worm`;
      }
      if (data.gearType === 'worm-wheel') {
        const starts =
          data.mateTeeth === undefined ? null : num(data.mateTeeth);
        const wheel = data.throated ? 'throated worm wheel' : 'worm wheel';
        return starts === null
          ? `${teeth} teeth, ${wheel}`
          : `${teeth} teeth, ${wheel} for ${starts}-start worm`;
      }
      if (data.gearType === 'bevel') {
        const mate = data.mateTeeth === undefined ? null : num(data.mateTeeth);
        return mate === null
          ? `${teeth} teeth, bevel`
          : `${teeth} teeth, bevel to ${mate}`;
      }
      const helix =
        data.helixAngleDeg === undefined ? '0' : num(data.helixAngleDeg);
      return helix === null || helix === '0'
        ? `${teeth} teeth`
        : `${teeth} teeth, ${helix}° ${data.hand ?? 'right'} ${data.herringbone ? 'herringbone' : 'helix'}`;
    }
    case 'thread': {
      if (data.profile === 'npt' || data.profile === 'bspt') {
        // Schema v57 pipe threads: the callout, or the standard where the
        // face picks the size.
        const standard = data.profile === 'npt' ? 'NPT' : 'BSPT';
        return data.pipeSize === undefined
          ? `${standard}, fits the face`
          : data.profile === 'npt'
            ? pipeThreadLabel('npt', data.pipeSize)
            : `${data.pipeSize} BSPT`;
      }
      const profile =
        data.profile === 'printable'
          ? 'printable'
          : data.profile === 'iso-metric'
            ? 'ISO'
            : 'custom';
      const major =
        data.majorDiameter === undefined ? null : num(data.majorDiameter);
      const pitch = data.pitch === undefined ? null : num(data.pitch);
      const size =
        major !== null && pitch !== null
          ? `⌀ ${major} × ${pitch} ${unit}`
          : pitch !== null
            ? `pitch ${pitch} ${unit}`
            : 'fits the face';
      return `${size}, ${profile}`;
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
    case 'datum-plane': {
      const flip = data.definition.reverseNormal ? ' flipped' : '';
      if (data.definition.kind === 'midplane') return `midplane${flip}`;
      if (data.definition.kind === 'three-point') return `3 points${flip}`;
      if (data.definition.kind === 'parallel-point')
        return `through point${flip}`;
      // A length, so a unit-bearing offset ("1 in") still summarises.
      const offset = lengthValue(data.definition.offset);
      return offset === null ? null : `${offset} ${unit}${flip}`;
    }
    case 'datum-axis': {
      const reversed = data.definition.reverseDirection ? ' reversed' : '';
      return `${
        {
          'two-point': '2 points',
          edge: 'along edge',
          cylinder: 'cylinder axis',
          'plane-intersection': 'planes meet'
        }[data.definition.kind]
      }${reversed}`;
    }
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
      return withEdgeCount(
        data.edgeHashes,
        data.edgeReferences,
        // "R", as the fillet's own radius chip and Options field name it:
        // History said "r 2 mm" of the value the card had called "R".
        end !== null ? `R ${radius}–${end} ${unit}` : `R ${radius} ${unit}`
      );
    }
    case 'chamfer': {
      const distance = num(data.distance);
      if (distance === null) {
        return null;
      }
      const second = data.distance2 === undefined ? null : num(data.distance2);
      if (second !== null) {
        return withEdgeCount(
          data.edgeHashes,
          data.edgeReferences,
          `${distance} × ${second} ${unit}`
        );
      }
      const angle = data.angleDeg === undefined ? null : num(data.angleDeg);
      return withEdgeCount(
        data.edgeHashes,
        data.edgeReferences,
        angle !== null
          ? `${distance} ${unit} × ${angle}°`
          : `${distance} ${unit}`
      );
    }
    case 'boolean':
      return booleanOperands(data.operation, data.targetBodyIds, bodyName);
    case 'direct-edit':
      return directEditSummary(data.operation, num, unit);
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
