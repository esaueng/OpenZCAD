import type {
  EntityId,
  ParamValue,
  SketchComposite,
  SketchCompositeId,
  SketchObjectData,
  SketchPointRef
} from './index';
import {
  isSketchComposite,
  resolveSketchComposite,
  sketchCompositeHelperKinds,
  sketchCompositeSideRange,
  type SketchCompositePoint
} from './sketch-composites';

/** A coordinate-free witness of the ordered topology a named target owns. */
export interface SketchCompositeTargetTopology {
  version: 1;
  edgeIds: EntityId[];
  helperIds: EntityId[];
}

interface SketchCompositeTargetBase {
  compositeId: SketchCompositeId;
  /** Zero-based corner or side index; it is never wrapped or clamped. */
  index: number;
  topology: SketchCompositeTargetTopology;
}

export interface SketchCompositeCornerTarget extends SketchCompositeTargetBase {
  kind: 'composite-corner';
}

export interface SketchCompositeSideTarget extends SketchCompositeTargetBase {
  kind: 'composite-side';
}

export type SketchCompositeTarget =
  SketchCompositeCornerTarget | SketchCompositeSideTarget;

type UnresolvedTarget = { status: 'unresolved'; reason: string };
export type SketchCompositeCornerTargetResolution =
  | {
      status: 'resolved';
      pointRef: SketchPointRef;
      point: SketchCompositePoint;
    }
  | UnresolvedTarget;
export type SketchCompositeSideTargetResolution =
  | {
      status: 'resolved';
      objectId: EntityId;
      start: SketchCompositePoint;
      end: SketchCompositePoint;
    }
  | UnresolvedTarget;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdList(value: unknown): value is EntityId[] {
  return (
    Array.isArray(value) &&
    Array.from(value).every((id) => typeof id === 'string' && id.length > 0)
  );
}

function isTarget(
  value: unknown,
  kind: SketchCompositeTarget['kind']
): boolean {
  if (!isRecord(value) || value.kind !== kind) return false;
  if (
    typeof value.compositeId !== 'string' ||
    !value.compositeId.startsWith('scmp_') ||
    !Number.isInteger(value.index) ||
    !isRecord(value.topology)
  )
    return false;
  const { version, edgeIds, helperIds } = value.topology;
  if (
    version !== 1 ||
    !isIdList(edgeIds) ||
    !isIdList(helperIds) ||
    edgeIds.length < 3 ||
    edgeIds.length > sketchCompositeSideRange('polygon').max ||
    helperIds.length > 2 ||
    (value.index as number) < 0 ||
    (value.index as number) >= edgeIds.length
  )
    return false;
  const ids = [...edgeIds, ...helperIds];
  return (
    new Set(ids).size === ids.length &&
    Object.keys(value).length === 4 &&
    Object.keys(value.topology).length === 3
  );
}

export function isSketchCompositeCornerTarget(
  value: unknown
): value is SketchCompositeCornerTarget {
  return isTarget(value, 'composite-corner');
}

export function isSketchCompositeSideTarget(
  value: unknown
): value is SketchCompositeSideTarget {
  return isTarget(value, 'composite-side');
}

function createTarget(
  composite: SketchComposite,
  index: number,
  kind: SketchCompositeTarget['kind']
): SketchCompositeTarget {
  const compositeId =
    isRecord(composite) && typeof composite.compositeId === 'string'
      ? composite.compositeId
      : 'unknown';
  if (!isSketchComposite(composite))
    throw new Error(
      `Composite "${compositeId}" has malformed ordered topology.`
    );
  const target = {
    kind,
    compositeId: composite.compositeId,
    index,
    topology: {
      version: 1 as const,
      edgeIds: [...composite.edgeIds],
      helperIds: [...(composite.helperIds ?? [])]
    }
  };
  if (!isTarget(target, kind))
    throw new Error(
      `Composite "${composite.compositeId}" has no ${kind === 'composite-corner' ? 'corner' : 'side'} at index ${index}.`
    );
  return target;
}

export function createSketchCompositeCornerTarget(
  composite: SketchComposite,
  index: number
): SketchCompositeCornerTarget {
  return createTarget(
    composite,
    index,
    'composite-corner'
  ) as SketchCompositeCornerTarget;
}

export function createSketchCompositeSideTarget(
  composite: SketchComposite,
  index: number
): SketchCompositeSideTarget {
  return createTarget(
    composite,
    index,
    'composite-side'
  ) as SketchCompositeSideTarget;
}

/** Every captured member remains a dependency, even if the owner is missing. */
export function sketchCompositeTargetMemberIds(
  target: SketchCompositeTarget
): EntityId[] {
  return [...target.topology.edgeIds, ...target.topology.helperIds];
}

function targetFailure(target: unknown, detail: string): UnresolvedTarget {
  const record = isRecord(target) ? target : {};
  const id =
    typeof record.compositeId === 'string' ? record.compositeId : 'unknown';
  const index = typeof record.index === 'number' ? record.index + 1 : '?';
  return {
    status: 'unresolved',
    reason: `Composite "${id}" ${record.kind === 'composite-side' ? 'side' : 'corner'} ${index}: ${detail}`
  };
}

export type SketchCompositeTargetIdentityResolution =
  { status: 'resolved'; composite: SketchComposite } | UnresolvedTarget;

/** Structural qualification without resolving expression-backed geometry. */
export function resolveSketchCompositeTargetIdentity(
  target: SketchCompositeTarget,
  composites: readonly SketchComposite[],
  objects?: ReadonlyMap<string, SketchObjectData>
): SketchCompositeTargetIdentityResolution {
  if (
    !isSketchCompositeCornerTarget(target) &&
    !isSketchCompositeSideTarget(target)
  )
    return targetFailure(target, 'the saved target descriptor is malformed.');
  const matches = composites.filter(
    (c) => isRecord(c) && c.compositeId === target.compositeId
  );
  if (matches.length !== 1)
    return targetFailure(
      target,
      'its owning composite is missing or ambiguous in this sketch.'
    );
  const composite = matches[0]!;
  if (
    !isSketchComposite(composite) ||
    !isIdList(composite.edgeIds) ||
    !isIdList(composite.helperIds ?? [])
  )
    return targetFailure(target, 'its owning composite is malformed.');
  const sameIds = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  if (
    !sameIds(composite.edgeIds, target.topology.edgeIds) ||
    !sameIds(composite.helperIds ?? [], target.topology.helperIds)
  )
    return targetFailure(
      target,
      'its ordered sides or helpers changed. Re-create the reference explicitly.'
    );
  if (objects) {
    for (const id of composite.edgeIds)
      if (objects.get(id)?.objectKind !== 'line')
        return targetFailure(
          target,
          `side "${id}" is missing or is no longer a line.`
        );
    const helperKinds = sketchCompositeHelperKinds(composite.method);
    for (const [index, id] of (composite.helperIds ?? []).entries()) {
      const helper = objects.get(id);
      if (
        !helper ||
        helper.objectKind !== helperKinds[index] ||
        !helper.construction
      )
        return targetFailure(
          target,
          `construction helper "${id}" is missing or has changed kind.`
        );
    }
  }
  return { status: 'resolved', composite };
}

function resolveTarget(
  target: SketchCompositeTarget,
  composites: readonly SketchComposite[],
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: (value: ParamValue) => number | undefined
):
  | {
      status: 'resolved';
      composite: SketchComposite;
      corners: SketchCompositePoint[];
    }
  | UnresolvedTarget {
  const identity = resolveSketchCompositeTargetIdentity(
    target,
    composites,
    objects
  );
  if (identity.status === 'unresolved') return identity;
  const { composite } = identity;
  const resolved = resolveSketchComposite(composite, objects, (value) => {
    try {
      const result = resolve(value);
      return typeof result === 'number' && Number.isFinite(result)
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  });
  if (resolved.status === 'broken')
    return targetFailure(target, resolved.reason);
  return { status: 'resolved', composite, corners: resolved.corners };
}

/** Resolve a complete named shape before lowering its corner to a solver point. */
export function resolveSketchCompositeCornerTarget(
  target: SketchCompositeCornerTarget,
  composites: readonly SketchComposite[],
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: (value: ParamValue) => number | undefined
): SketchCompositeCornerTargetResolution {
  if (!isSketchCompositeCornerTarget(target))
    return targetFailure(
      target,
      'the saved corner target descriptor is malformed.'
    );
  const result = resolveTarget(target, composites, objects, resolve);
  if (result.status === 'unresolved') return result;
  return {
    status: 'resolved',
    pointRef: {
      objectId: result.composite.edgeIds[target.index]!,
      point: 'start'
    },
    point: result.corners[target.index]!
  };
}

/** Resolve a complete named shape before lowering its side to a real line. */
export function resolveSketchCompositeSideTarget(
  target: SketchCompositeSideTarget,
  composites: readonly SketchComposite[],
  objects: ReadonlyMap<string, SketchObjectData>,
  resolve: (value: ParamValue) => number | undefined
): SketchCompositeSideTargetResolution {
  if (!isSketchCompositeSideTarget(target))
    return targetFailure(
      target,
      'the saved side target descriptor is malformed.'
    );
  const result = resolveTarget(target, composites, objects, resolve);
  if (result.status === 'unresolved') return result;
  const objectId = result.composite.edgeIds[target.index]!;
  const line = objects.get(objectId)!;
  if (line.objectKind !== 'line')
    return targetFailure(target, 'its side is no longer a line.');
  try {
    const x = resolve(line.x2);
    const y = resolve(line.y2);
    if (
      typeof x !== 'number' ||
      !Number.isFinite(x) ||
      typeof y !== 'number' ||
      !Number.isFinite(y)
    )
      return targetFailure(target, 'its side endpoint does not resolve.');
    return {
      status: 'resolved',
      objectId,
      start: result.corners[target.index]!,
      end: { x, y }
    };
  } catch {
    return targetFailure(target, 'its side endpoint does not resolve.');
  }
}
