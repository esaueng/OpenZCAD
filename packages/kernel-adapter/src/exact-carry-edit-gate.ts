/**
 * Which upstream edits a hash-only edge selection may be carried across.
 *
 * The carry (`exact-edge-selection-transport.ts`) matches edges by structure
 * in a world frame. Some edits produce a solid that no comparison can tell
 * apart from a dimension change. Turning a disk with an off-centre boss 180°
 * about the disk's axis leaves the rims where they were and moves only the
 * boss's x planes, exactly as moving the boss would. A carry there names
 * the edge that now sits where the old one did, not the one that turned.
 * Only the edit itself says which happened.
 *
 * So the carry is allowed only when every difference between the document
 * the selection was recorded on and the one being built is a pure
 * dimension edit, judged on the features up to the modifier. The allow-list
 * below is explicit:
 *
 * - a primitive's dimensions;
 * - an extrude's distance or back distance;
 * - a fillet's radius, a chamfer's distance;
 * - a direct edit's offset, face distance, cylinder radius or blend radius;
 * - a rectangle, circle or polygon's size or centre in an upstream sketch;
 * - the value of a sketch distance or radius constraint;
 * - a parameter, but only when every upstream use of it is in one of those
 *   fields.
 *
 * Anything else refuses: a transform (rotation, pivot, translation, scale),
 * a mirror plane, a pattern, a revolve angle, a draft angle, a feature added,
 * removed, reordered or suppressed, a sketch plane, a constraint added, or
 * a line or arc redrawn. A refusal is what the build did before carrying
 * existed, so an edit missing from the list costs a re-pick, never a wrong
 * edge.
 */
import { getParameterScope, listFeaturesInOrder } from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/** What the features up to an edge modifier were, for one build. */
export interface UpstreamSnapshot {
  units: string;
  features: readonly {
    featureId: string;
    featureKind: string;
    data: unknown;
    suppressed: boolean;
  }[];
  /** Upstream sketches by sketch id: their node and objects. */
  sketches: ReadonlyMap<
    string,
    { node: unknown; objects: ReadonlyMap<string, unknown> }
  >;
  /** Resolved parameter values. */
  scope: Readonly<Record<string, number>>;
}

/**
 * Feature fields a dimension edit may change, by feature kind. A kind that
 * is absent allows no change at all.
 */
const DIMENSION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  primitive: ['dimensions'],
  extrude: ['distance', 'backDistance'],
  fillet: ['radius', 'endRadius'],
  chamfer: ['distance']
};

/** Direct-edit operation fields a dimension edit may change, by kind. */
const DIRECT_EDIT_DIMENSION_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  'offset-face': ['offset'],
  'set-face-distance': ['distance', 'parameterBinding'],
  'resize-cylindrical-face': ['radius'],
  'resize-blend': ['newRadius', 'parameterBinding']
};

/**
 * Sketch-object fields a dimension edit may change: a size, or a centre
 * (a translation). Lines, arcs and freeform curves are not listed: moving
 * their points can turn a profile.
 */
const SKETCH_OBJECT_DIMENSION_FIELDS: Readonly<
  Record<string, readonly string[]>
> = {
  rectangle: ['width', 'height', 'centerX', 'centerY'],
  circle: ['radius', 'centerX', 'centerY'],
  polygon: ['radius', 'centerX', 'centerY']
};

/** Constraint kinds whose `value` is a length. */
const LENGTH_CONSTRAINTS: ReadonlySet<string> = new Set(['distance', 'radius']);

/** Sketch node fields that are presentation, never geometry. */
const SKETCH_PRESENTATION_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'parentId',
  'revisionId',
  'metadata',
  'dimensionLabelPositions',
  'referenceDimensions'
]);

/** Order-independent JSON, so equal data compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function without(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key of keys) delete copy[key];
  return copy;
}

/** The fields of a feature's data a dimension edit may not touch. */
function featureResidue(featureKind: string, data: unknown): unknown {
  if (featureKind === 'direct-edit') {
    const operation = (data as { operation?: { kind?: string } }).operation;
    const allowed =
      (operation?.kind
        ? DIRECT_EDIT_DIMENSION_FIELDS[operation.kind]
        : undefined) ?? [];
    return {
      ...(without(data, ['operation']) as Record<string, unknown>),
      operation: without(operation, allowed)
    };
  }
  return without(data, DIMENSION_FIELDS[featureKind] ?? []);
}

function sketchObjectResidue(object: unknown): unknown {
  const kind = (object as { objectKind?: string }).objectKind;
  const data = (object as { data?: unknown }).data;
  return {
    objectKind: kind,
    data: without(
      data,
      (kind ? SKETCH_OBJECT_DIMENSION_FIELDS[kind] : undefined) ?? []
    )
  };
}

function sketchResidue(node: unknown): unknown {
  const fields = Object.entries(node as Record<string, unknown>).filter(
    ([key]) => !SKETCH_PRESENTATION_FIELDS.has(key)
  );
  const residue: Record<string, unknown> = Object.fromEntries(fields);
  const constraints = residue.constraints;
  if (Array.isArray(constraints)) {
    residue.constraints = (constraints as unknown[]).map(
      (constraint): unknown => {
        const data = (constraint as { data?: { constraintKind?: string } })
          .data;
        return data?.constraintKind &&
          LENGTH_CONSTRAINTS.has(data.constraintKind)
          ? {
              ...(constraint as Record<string, unknown>),
              data: without(data, ['value'])
            }
          : constraint;
      }
    );
  }
  return residue;
}

/** The snapshot of every feature before `featureId`, or null if absent. */
export function upstreamSnapshot(
  document: ProjectDocument,
  featureId: string
): UpstreamSnapshot | null {
  const ordered = listFeaturesInOrder(document);
  const index = ordered.findIndex((feature) => feature.featureId === featureId);
  if (index < 0) return null;
  const upstream: FeatureNode[] = ordered.slice(0, index);
  const sketchIds = new Set<string>();
  for (const feature of upstream) {
    const sketchId = (feature.data as { sketchId?: unknown }).sketchId;
    if (typeof sketchId === 'string') sketchIds.add(sketchId);
  }
  const sketches = new Map<
    string,
    { node: unknown; objects: Map<string, unknown> }
  >();
  for (const node of Object.values(document.nodes)) {
    if (node.kind !== 'sketch' || !sketchIds.has(node.sketchId)) continue;
    const objects = new Map<string, unknown>();
    for (const objectId of node.objectIds) {
      const object = document.nodes[objectId];
      if (object?.kind === 'sketch-object') {
        objects.set(objectId, {
          objectKind: object.objectKind,
          data: object.data
        });
      }
    }
    sketches.set(node.sketchId, { node, objects });
  }
  return {
    units: document.units,
    features: upstream.map((feature) => ({
      featureId: feature.featureId,
      featureKind: feature.data.featureKind,
      data: feature.data,
      suppressed: isFeatureSuppressed(feature)
    })),
    sketches,
    scope: { ...getParameterScope(document).scope }
  };
}

/**
 * Whether `after` differs from `before` only by allow-listed dimension
 * edits. Nothing outside the list passes.
 */
export function onlyDimensionEdits(
  before: UpstreamSnapshot,
  after: UpstreamSnapshot
): boolean {
  if (before.units !== after.units) return false;
  if (before.features.length !== after.features.length) return false;
  for (let index = 0; index < before.features.length; index += 1) {
    const was = before.features[index]!;
    const now = after.features[index]!;
    if (
      was.featureId !== now.featureId ||
      was.featureKind !== now.featureKind ||
      was.suppressed !== now.suppressed
    ) {
      return false;
    }
    if (canonical(was.data) === canonical(now.data)) continue;
    if (
      canonical(featureResidue(was.featureKind, was.data)) !==
      canonical(featureResidue(now.featureKind, now.data))
    ) {
      return false;
    }
  }
  if (before.sketches.size !== after.sketches.size) return false;
  for (const [sketchId, was] of before.sketches) {
    const now = after.sketches.get(sketchId);
    if (!now) return false;
    if (canonical(sketchResidue(was.node)) !== canonical(sketchResidue(now.node)))
      return false;
    if (was.objects.size !== now.objects.size) return false;
    for (const [objectId, object] of was.objects) {
      const other = now.objects.get(objectId);
      if (
        other === undefined ||
        canonical(sketchObjectResidue(object)) !==
          canonical(sketchObjectResidue(other))
      ) {
        return false;
      }
    }
  }
  // A parameter may change only where every upstream use of it is a
  // dimension field: its name must not appear in any residue.
  const changed = new Set<string>();
  for (const name of new Set([
    ...Object.keys(before.scope),
    ...Object.keys(after.scope)
  ])) {
    if (before.scope[name] !== after.scope[name]) changed.add(name);
  }
  if (changed.size === 0) return true;
  const residues = [
    ...after.features.map((feature) =>
      canonical(featureResidue(feature.featureKind, feature.data))
    ),
    ...[...after.sketches.values()].flatMap((sketch) => [
      canonical(sketchResidue(sketch.node)),
      ...[...sketch.objects.values()].map((object) =>
        canonical(sketchObjectResidue(object))
      )
    ])
  ];
  for (const name of changed) {
    const use = new RegExp(
      `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`
    );
    if (residues.some((residue) => use.test(residue))) return false;
  }
  return true;
}
