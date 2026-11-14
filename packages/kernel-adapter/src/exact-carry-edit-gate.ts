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
 *
 * Two further rules close what the document alone cannot show:
 *
 * - A dimension keeps its sign. A negative extrude distance mirrors the
 *   extrude, and an offset crossing zero turns a push into a pull, so every
 *   allow-listed size must stay non-zero on the same side of zero.
 * - Frames the build resolves stay put. A linked sketch projection is
 *   re-solved on every build (its new positions live only in the build, not
 *   the document), and a datum plane or axis through points on a body
 *   follows that body. A primitive resize can then turn a sketch, a datum or
 *   every feature placed by one, while their data is unchanged. Each build
 *   records every sketch base, datum frame and axis and linked projection up
 *   to the modifier, and any difference refuses.
 *
 * Nothing else in a document shapes the modifier's input: features (with
 * their sketches and import checksums), parameters and units are judged
 * above; body order, body names and colours, drawings, folders, revisions
 * and assets referenced by checksum do not change geometry.
 */
import {
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  ownEntry,
  type FeatureNode,
  type ParamValue,
  type PrimitiveKind,
  type ProjectDocument
} from '@openzcad/shared';
import type { ExactBuildResult } from './exact-types';

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
  /**
   * The resolved value of every allow-listed size that has a sign, keyed by
   * where it lives; null when it does not resolve.
   */
  sizes: ReadonlyMap<string, number | null>;
  /**
   * Every frame the build resolved up to the modifier: sketch bases, datum
   * planes and axes, linked projections. Canonical text, compared whole.
   */
  resolved: string;
}

/** The dimensions each primitive kind is built from (`buildPrimitive`). */
const PRIMITIVE_DIMENSIONS: Readonly<Record<PrimitiveKind, readonly string[]>> =
  {
    box: ['width', 'height', 'depth'],
    cylinder: ['radius', 'height'],
    sphere: ['radius'],
    cone: ['bottomRadius', 'topRadius', 'height'],
    torus: ['majorRadius', 'minorRadius']
  };

/**
 * Feature fields a dimension edit may change, by feature kind. A kind that
 * is absent allows no change at all.
 */
const DIMENSION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // `dimensions` itself is judged key by key: see `featureResidue`.
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

/**
 * Order-independent JSON, so equal data compares equal. Maps read as their
 * sorted entries; numbers (resolved frames) compare at 1e-9.
 */
function canonical(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return JSON.stringify(String(value));
    const rounded = Math.round(value * 1e9) / 1e9;
    return JSON.stringify(rounded === 0 ? 0 : rounded);
  }
  if (value instanceof Map) {
    return canonical(
      [...value.entries()].sort(([a], [b]) =>
        String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
      )
    );
  }
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
  if (featureKind === 'primitive') {
    // Only the kind's own dimensions may change; any other key (a future
    // position or angle) must stay as it was.
    const primitive = data as {
      primitiveKind?: PrimitiveKind;
      dimensions?: Record<string, unknown>;
    };
    const known =
      (primitive.primitiveKind
        ? ownEntry(PRIMITIVE_DIMENSIONS, primitive.primitiveKind)
        : undefined) ?? [];
    return {
      ...(without(data, ['dimensions']) as Record<string, unknown>),
      dimensions: without(primitive.dimensions ?? {}, known)
    };
  }
  if (featureKind === 'direct-edit') {
    const operation = (data as { operation?: { kind?: string } }).operation;
    const allowed =
      (operation?.kind
        ? ownEntry(DIRECT_EDIT_DIMENSION_FIELDS, operation.kind)
        : undefined) ?? [];
    return {
      ...(without(data, ['operation']) as Record<string, unknown>),
      operation: without(operation, allowed)
    };
  }
  return without(data, ownEntry(DIMENSION_FIELDS, featureKind) ?? []);
}

function sketchObjectResidue(object: unknown): unknown {
  const kind = (object as { objectKind?: string }).objectKind;
  const data = (object as { data?: unknown }).data;
  return {
    objectKind: kind,
    data: without(
      data,
      (kind ? ownEntry(SKETCH_OBJECT_DIMENSION_FIELDS, kind) : undefined) ?? []
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

/** Distinct tokens for snapshots taken without the build's state. */
let unresolvedSnapshots = 0;

/** Sizes with a sign in a feature's data: [key, value] pairs. */
function featureSizes(
  feature: FeatureNode
): [string, ParamValue | undefined][] {
  const data = feature.data as unknown as Record<string, unknown>;
  const id = feature.featureId;
  switch (feature.data.featureKind) {
    case 'primitive': {
      const dimensions = (data.dimensions ?? {}) as Record<string, ParamValue>;
      return (
        ownEntry(PRIMITIVE_DIMENSIONS, feature.data.primitiveKind) ?? []
      ).map((key) => [`${id}:dimensions.${key}`, dimensions[key]]);
    }
    case 'direct-edit': {
      const operation = (data.operation ?? {}) as Record<string, unknown>;
      const kind = typeof operation.kind === 'string' ? operation.kind : '';
      return (ownEntry(DIRECT_EDIT_DIMENSION_FIELDS, kind) ?? [])
        .filter((key) => key !== 'parameterBinding')
        .map((key) => [
          `${id}:operation.${key}`,
          operation[key] as ParamValue | undefined
        ]);
    }
    default:
      return (ownEntry(DIMENSION_FIELDS, feature.data.featureKind) ?? []).map(
        (key) => [`${id}:${key}`, data[key] as ParamValue | undefined]
      );
  }
}

/** Sizes with a sign in a sketch object (its centre is a position). */
const SKETCH_OBJECT_SIZES: ReadonlySet<string> = new Set([
  'width',
  'height',
  'radius'
]);

/**
 * Every sketch id a feature's data names, at any depth: a loft's sections,
 * a sweep's profile, path and guide, a helical sweep's profile, as well as
 * an extrude's or revolve's top-level sketch.
 */
export function referencedSketchIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) referencedSketchIds(item, into);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sketchId' && typeof entry === 'string') into.add(entry);
    else referencedSketchIds(entry, into);
  }
}

function resolveSize(
  value: ParamValue | undefined,
  scope: Record<string, number>,
  units: ProjectDocument['units']
): number | null {
  if (value === undefined) return null;
  try {
    const resolved = resolveParamValue(value, scope, 'size', units);
    return Number.isFinite(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * The snapshot of every feature before `featureId`, or null if absent.
 * `resolved` is the build's state at the modifier: what the earlier
 * features resolved (sketch bases, datums, linked projections).
 */
export function upstreamSnapshot(
  document: ProjectDocument,
  featureId: string,
  resolved?: Pick<
    ExactBuildResult,
    | 'sketchBases'
    | 'datumFrames'
    | 'datumAxes'
    | 'sketchObjectOverrides'
    | 'sketchProjections'
  >
): UpstreamSnapshot | null {
  const ordered = listFeaturesInOrder(document);
  const index = ordered.findIndex((feature) => feature.featureId === featureId);
  if (index < 0) return null;
  const upstream: FeatureNode[] = ordered.slice(0, index);
  // Loft sections, sweep profiles, paths and guides and helical-sweep
  // profiles name their sketches below the top level of the data.
  const sketchIds = new Set<string>();
  for (const feature of upstream) referencedSketchIds(feature.data, sketchIds);
  const scope = { ...getParameterScope(document).scope };
  const sizes = new Map<string, number | null>();
  for (const feature of upstream) {
    for (const [key, value] of featureSizes(feature)) {
      if (value !== undefined)
        sizes.set(key, resolveSize(value, scope, document.units));
    }
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
        const data = object.data as unknown as Record<string, ParamValue>;
        for (const key of SKETCH_OBJECT_SIZES) {
          if (data[key] !== undefined)
            sizes.set(
              `${objectId}:${key}`,
              resolveSize(data[key], scope, document.units)
            );
        }
      }
    }
    for (const constraint of node.constraints ?? []) {
      const data = constraint.data as { constraintKind: string; value?: ParamValue };
      if (LENGTH_CONSTRAINTS.has(data.constraintKind) && data.value !== undefined)
        sizes.set(
          `${constraint.constraintId}:value`,
          resolveSize(data.value, scope, document.units)
        );
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
    scope,
    sizes,
    // Without the build's state nothing proves the frames, so the snapshot
    // matches no other.
    resolved: resolved
      ? canonical({
          sketchBases: resolved.sketchBases,
          datumFrames: resolved.datumFrames,
          datumAxes: resolved.datumAxes,
          projected: resolved.sketchObjectOverrides ?? new Map(),
          projections: resolved.sketchProjections ?? new Map()
        })
      : `unresolved:${(unresolvedSnapshots += 1)}`
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
  // A frame the build resolved (a re-solved projection, a datum through a
  // body's points) may have turned with an allowed resize: refuse.
  if (before.resolved !== after.resolved) return false;
  // Every size keeps its sign and stays non-zero: a negative distance
  // mirrors an extrude, an offset through zero turns a push into a pull.
  for (const key of new Set([...before.sizes.keys(), ...after.sizes.keys()])) {
    const was = before.sizes.get(key);
    const now = after.sizes.get(key);
    if (was === now) continue;
    if (was === undefined || now === undefined || was === null || now === null)
      return false;
    if (!(was * now > 0)) return false;
  }
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
