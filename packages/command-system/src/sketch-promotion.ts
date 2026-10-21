import {
  deepClone,
  boundaryProvenanceObjectIds,
  MAX_SKETCH_POLYGON_SIDES,
  resolveSketchPromotionBoundaryTokens,
  sketchReferenceDimensionObjectIds,
  toSketchConstraintId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraint,
  type SketchConstraintData,
  type SketchId,
  type SketchObjectData,
  type SketchPointRef,
  type SketchProfileReference,
  type SketchPromotion
} from '@openzcad/shared';
import {
  cloneDocument,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  resolveParamValue,
  validateSketchConstraint,
  assertSketchProvenance
} from '@openzcad/document-core';
import {
  computeSketchProfileAnalysis,
  profileContainsPoint,
  resolveBoundaryProfileReference,
  type SketchProfile
} from '@openzcad/geometry';

export interface LegacySketchConversionInput {
  sketchId: SketchId;
  sourceObjectId: EntityId;
  /** UI previews can bind the command to their exact authored source. */
  expectedSource?: SketchObjectData;
  ids?: {
    promotionId: string;
    /** Preallocated up to the polygon cap; only the source's count is used. */
    edgeIds: EntityId[];
    centerSpokeId: EntityId;
    helperIds: EntityId[];
  };
}

export interface SketchPromotionReleaseInput {
  sketchId: SketchId;
  promotionId: string;
}

/** Explicitly free the generated graph while retaining its downstream aliases. */
export function releaseSketchPromotionStructure(
  document: ProjectDocument,
  input: SketchPromotionReleaseInput
): ProjectDocument {
  if (document.schemaVersion < 33)
    refuse('conversion ownership requires schema v33.');
  const sketch = findSketch(document, input.sketchId);
  const promotion = sketch?.promotions?.find(
    (p) => p.promotionId === input.promotionId
  );
  if (!sketch || !promotion)
    refuse('the converted shape is no longer available.');
  if (!promotion.structureConstraintIds.length) return document;
  const next = cloneDocument(document),
    target = findSketch(next, input.sketchId)!;
  target.constraints = target.constraints?.filter(
    (c) =>
      !(
        c.origin === 'promotion-structure' &&
        c.promotionId === input.promotionId
      )
  );
  target.promotions!.find(
    (p) => p.promotionId === input.promotionId
  )!.structureConstraintIds = [];
  assertSketchProvenance({ ...next, commandLog: [], editHistory: undefined });
  next.version += 1;
  return next;
}

function refuse(message: string): never {
  throw new Error(`Cannot convert to editable edges: ${message}`);
}

function containsId(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsId(item, id));
  return Boolean(
    value &&
    typeof value === 'object' &&
    Object.values(value).some((item) => containsId(item, id))
  );
}

/** Keep authored expressions live; literal coordinates stay ordinary numbers. */
function affine(
  center: ParamValue,
  size: ParamValue,
  factor: number
): ParamValue {
  if (factor === 0) return center;
  if (typeof center === 'number' && typeof size === 'number')
    return center + size * factor;
  return `(${center}) + (${size}) * (${factor})`;
}

function legacyMatch(
  reference: Exclude<SketchProfileReference, { all: true }>,
  profiles: SketchProfile[],
  tolerance: number
): SketchProfile {
  if (reference.sourceBoundaryLoops)
    return resolveBoundaryProfileReference(
      { ...reference, sourceBoundaryLoops: reference.sourceBoundaryLoops },
      profiles,
      tolerance,
      profileContainsPoint
    );
  const areaTolerance = Math.max(
    Math.abs(reference.sourceArea) * 0.01,
    tolerance * tolerance * 16
  );
  const ids = reference.sourceEntityIds
    ? [...reference.sourceEntityIds].sort().join('|')
    : undefined;
  const witness = (p: SketchProfile) =>
    Math.abs(p.area - reference.sourceArea) <= areaTolerance &&
    profileContainsPoint(p, reference.samplePoint);
  const exact = profiles.filter(
    (p) =>
      (reference.profileId && p.profileId === reference.profileId) ||
      (p.regionFingerprint === reference.regionFingerprint &&
        witness(p) &&
        (!ids || [...p.sourceEntityIds].sort().join('|') === ids))
  );
  if (exact.length === 1) return exact[0]!;
  const entities = ids
    ? profiles.filter((p) => [...p.sourceEntityIds].sort().join('|') === ids)
    : [];
  if (entities.length === 1) return entities[0]!;
  const matching = entities.filter(witness);
  if (matching.length === 1) return matching[0]!;
  const fallback = profiles.filter((p) => !p.outline && witness(p));
  if (fallback.length === 1) return fallback[0]!;
  return refuse(
    'a saved downstream profile no longer resolves uniquely. Repair it first.'
  );
}

/** One replayable replacement. No intermediate deletion or generated graph is published. */
export function convertLegacySketchObject(
  document: ProjectDocument,
  input: LegacySketchConversionInput
): ProjectDocument {
  if (document.schemaVersion < 33)
    refuse('conversion ownership requires schema v33.');
  const sketch = findSketch(document, input.sketchId);
  const source = sketch?.objectIds.includes(input.sourceObjectId)
    ? document.nodes[input.sourceObjectId]
    : undefined;
  if (
    !sketch ||
    source?.kind !== 'sketch-object' ||
    (source.data.objectKind !== 'rectangle' &&
      source.data.objectKind !== 'polygon')
  )
    refuse('select an existing legacy rectangle or regular polygon.');
  if (
    input.expectedSource &&
    JSON.stringify(input.expectedSource) !== JSON.stringify(source.data)
  )
    refuse('the authored source changed after this conversion was prepared.');
  if (
    (sketch.constraints ?? []).some((c) => containsId(c.data, source.id)) ||
    (sketch.referenceDimensions ?? []).some((r) =>
      sketchReferenceDimensionObjectIds(r.data).includes(source.id)
    )
  )
    refuse(
      'a saved source operand has no supported primitive alias. Remove or repair it first.'
    );
  if ((sketch.promotions ?? []).some((p) => p.sourceObjectId === source.id))
    refuse('the source already has conversion ownership.');
  const scopeResult = getParameterScope(document);
  const resolve = (value: ParamValue) => {
    const result = resolveParamValue(
      value,
      scopeResult.scope,
      'legacy conversion',
      document.units
    );
    if (!Number.isFinite(result))
      refuse('every source parameter must resolve to a finite value.');
    return result;
  };
  const data = source.data;
  const cx = resolve(data.centerX),
    cy = resolve(data.centerY);
  const count = data.objectKind === 'rectangle' ? 4 : resolve(data.sides);
  if (!Number.isInteger(count) || count < 3 || count > MAX_SKETCH_POLYGON_SIDES)
    refuse(
      `the polygon needs an integer side count from 3 to ${MAX_SKETCH_POLYGON_SIDES}.`
    );
  if (data.objectKind === 'rectangle') {
    if (resolve(data.width) <= 0 || resolve(data.height) <= 0)
      refuse('rectangle sizes must be positive.');
  } else if (resolve(data.radius) <= 0)
    refuse('the polygon radius must be positive.');
  const ids = input.ids;
  if (
    !ids ||
    ids.edgeIds.length !== MAX_SKETCH_POLYGON_SIDES ||
    ids.helperIds.length !== 1
  )
    refuse('the replay command has incomplete generated identities.');
  const edges = ids.edgeIds.slice(0, count);
  const helpers =
    data.objectKind === 'rectangle' ? ids.helperIds.slice(0, 1) : [];
  const memberIds = [...edges, ids.centerSpokeId, ...helpers];
  const replayIds = [
    input.sourceObjectId,
    ...ids.edgeIds,
    ids.centerSpokeId,
    ...ids.helperIds
  ];
  if (
    replayIds.some(
      (id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)
    ) ||
    new Set(replayIds).size !== replayIds.length ||
    memberIds.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(id) ||
        document.nodes[id]
    ) ||
    new Set(memberIds).size !== memberIds.length ||
    !/^sprm_[A-Za-z0-9_-]+$/.test(ids.promotionId) ||
    (sketch.promotions ?? []).some((p) => p.promotionId === ids.promotionId)
  )
    refuse('generated identities are malformed or already owned.');
  const corners =
    data.objectKind === 'rectangle'
      ? [
          [-0.5, -0.5],
          [0.5, -0.5],
          [0.5, 0.5],
          [-0.5, 0.5]
        ].map(([x, y]) => ({
          x: affine(data.centerX, data.width, x!),
          y: affine(data.centerY, data.height, y!)
        }))
      : Array.from({ length: count }, (_, index) => {
          const angle = Math.PI / 2 + (index * 2 * Math.PI) / count;
          const cosine =
            Math.abs(Math.cos(angle)) < 1e-14 ? 0 : Math.cos(angle);
          const sine = Math.abs(Math.sin(angle)) < 1e-14 ? 0 : Math.sin(angle);
          return {
            x: affine(data.centerX, data.radius, cosine),
            y: affine(data.centerY, data.radius, sine)
          };
        });
  const byId = new Map(
    sketch.objectIds.flatMap((id) => {
      const node = document.nodes[id];
      return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
    })
  );
  const analysis = computeSketchProfileAnalysis(
    [...byId].map(([id, object]) => ({ id, data: object })),
    resolve,
    undefined,
    {
      promotionBoundaryTokens: resolveSketchPromotionBoundaryTokens(
        sketch.promotions ?? [],
        byId
      )
    }
  );
  const next = cloneDocument(document);
  const nextSketch = findSketch(next, input.sketchId)!;
  const line = (
    a: { x: ParamValue; y: ParamValue },
    b: { x: ParamValue; y: ParamValue },
    construction?: boolean
  ): SketchObjectData => ({
    objectKind: 'line',
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    ...(construction ? { construction: true } : {})
  });
  const objects = [
    ...edges.map((id, i) => ({
      id,
      data: line(corners[i]!, corners[(i + 1) % count]!, data.construction)
    })),
    {
      id: ids.centerSpokeId,
      data: line({ x: data.centerX, y: data.centerY }, corners[0]!, true)
    },
    ...helpers.map((id) => ({ id, data: line(corners[0]!, corners[2]!, true) }))
  ];
  // Resolve all affected selected sections against the unmodified sketch,
  // then add their exact authored-loop witness in this explicit transaction.
  const rebind = (
    reference: SketchProfileReference
  ): SketchProfileReference => {
    if (
      reference.all === true &&
      !reference.sourceEntityIds.includes(source.id)
    )
      return reference;
    if (reference.all === true)
      return {
        ...reference,
        sourceEntityIds: [
          ...new Set(
            reference.sourceEntityIds.flatMap((id) =>
              id === source.id ? edges : [id]
            )
          )
        ]
      };
    if (
      reference.sourceBoundaryLoops
        ? !boundaryProvenanceObjectIds(reference.sourceBoundaryLoops).includes(
            source.id
          )
        : reference.sourceEntityIds?.length &&
          !reference.sourceEntityIds.includes(source.id)
    )
      return reference;
    const profile = legacyMatch(
      reference,
      analysis.profiles,
      analysis.tolerance
    );
    if (!profile.sourceEntityIds.includes(source.id)) return reference;
    if (!profile.sourceBoundaryLoops)
      refuse('the selected boundary has incomplete authored provenance.');
    return {
      ...reference,
      sourceBoundaryLoops: deepClone(profile.sourceBoundaryLoops)
    };
  };
  for (const feature of listFeaturesInOrder(next)) {
    const f = feature.data;
    if (f.featureKind === 'extrude' && f.sketchId === input.sketchId) {
      if (f.profile) f.profile = rebind(f.profile);
      if (f.profiles) f.profiles = f.profiles.map(rebind);
    } else if (f.featureKind === 'loft') {
      f.sections = f.sections.map((s) =>
        s.sketchId === input.sketchId ? { ...s, profile: rebind(s.profile) } : s
      );
    } else if (f.featureKind === 'sweep' || f.featureKind === 'helical-sweep') {
      if (f.profile.sketchId === input.sketchId)
        f.profile = { ...f.profile, profile: rebind(f.profile.profile) };
      if (
        f.featureKind === 'sweep' &&
        [f.path, f.guide].some(
          (path) =>
            path?.sketchId === input.sketchId && containsId(path, source.id)
        )
      )
        refuse('a path operand has no complete conversion alias.');
    }
  }
  const sourceIndex = nextSketch.objectIds.indexOf(source.id);
  nextSketch.objectIds.splice(sourceIndex, 1, ...memberIds);
  delete next.nodes[source.id];
  for (const object of objects)
    next.nodes[object.id] = {
      id: object.id,
      kind: 'sketch-object',
      name: `${source.name} · ${object.id === ids.centerSpokeId ? 'Center' : helpers.includes(object.id) ? 'Diagonal' : `Edge ${edges.indexOf(object.id) + 1}`}`,
      parentId: nextSketch.id,
      revisionId: null,
      objectKind: 'line',
      data: object.data
    };
  const point = (i: number): SketchPointRef => ({
    objectId: edges[i]!,
    point: 'start'
  });
  const structure: SketchConstraintData[] = edges.map((id, i) => ({
    constraintKind: 'coincident',
    a: { objectId: id, point: 'end' },
    b: point((i + 1) % count)
  }));
  const spokeStart: SketchPointRef = {
    objectId: ids.centerSpokeId,
    point: 'start'
  };
  const spokeEnd: SketchPointRef = {
    objectId: ids.centerSpokeId,
    point: 'end'
  };
  if (data.objectKind === 'rectangle') {
    structure.push(
      ...edges.map((id, i): SketchConstraintData => ({
        constraintKind: i % 2 === 0 ? 'horizontal' : 'vertical',
        objectId: id
      })),
      {
        constraintKind: 'distance',
        a: point(0),
        b: point(1),
        value: data.width
      },
      {
        constraintKind: 'distance',
        a: point(1),
        b: point(2),
        value: data.height
      },
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[0]!, point: 'start' },
        b: point(0)
      },
      {
        constraintKind: 'coincident',
        a: { objectId: helpers[0]!, point: 'end' },
        b: point(2)
      },
      { constraintKind: 'midpoint', point: spokeStart, line: helpers[0]! }
    );
  } else {
    for (let i = 1; i < count; i++)
      structure.push({ constraintKind: 'equal', a: edges[0]!, b: edges[i]! });
    for (let i = 0; i < count; i++)
      structure.push({
        constraintKind: 'distance',
        a: spokeStart,
        b: point(i),
        value: data.radius
      });
    structure.push({ constraintKind: 'vertical', objectId: ids.centerSpokeId });
  }
  structure.push({ constraintKind: 'coincident', a: spokeEnd, b: point(0) });
  const constraints: SketchConstraint[] = structure.map((constraint, i) => ({
    constraintId: toSketchConstraintId(`scon_${ids.promotionId}_${i}`),
    data: constraint,
    origin: 'promotion-structure',
    promotionId: ids.promotionId
  }));
  const existingConstraintIds = new Set(
    Object.values(next.nodes).flatMap((node) =>
      node.kind === 'sketch'
        ? (node.constraints ?? []).map((c) => c.constraintId)
        : []
    )
  );
  if (constraints.some((c) => existingConstraintIds.has(c.constraintId)))
    refuse('a generated structure identity is already in use.');
  for (const constraint of constraints)
    validateSketchConstraint(next, nextSketch, constraint.data);
  nextSketch.constraints = [...(nextSketch.constraints ?? []), ...constraints];
  const promotion: SketchPromotion = {
    promotionId: ids.promotionId,
    version: 1,
    sourceObjectId: source.id,
    sourceData: deepClone(data),
    sourceName: source.name,
    topology: {
      kind: data.objectKind === 'rectangle' ? 'rectangle' : 'regular-polygon',
      version: 1,
      count
    },
    edgeIds: edges,
    centerSpokeId: ids.centerSpokeId,
    helperIds: helpers,
    structureConstraintIds: constraints.map((c) => c.constraintId),
    aliases: {
      version: 1,
      vertices: edges.map((_, i) => point(i)),
      edges: [...edges],
      center: spokeStart
    }
  };
  nextSketch.promotions = [...(nextSketch.promotions ?? []), promotion];
  // Validate the complete ownership before publishing any graph or rebind.
  resolveSketchPromotionBoundaryTokens(
    nextSketch.promotions,
    new Map(
      nextSketch.objectIds.flatMap((id) => {
        const node = next.nodes[id];
        return node?.kind === 'sketch-object' ? [[id, node.data] as const] : [];
      })
    )
  );
  // cx/cy are deliberately evaluated even when no boundary contributes.
  if (!Number.isFinite(cx + cy)) refuse('the source center is not finite.');
  assertSketchProvenance({ ...next, commandLog: [], editHistory: undefined });
  next.version += 1;
  return next;
}
