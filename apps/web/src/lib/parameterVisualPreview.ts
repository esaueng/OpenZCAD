import { growingHolderHistories } from '@openzcad/command-system';
import {
  evaluateExpression,
  findSketch,
  getParameterScope,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  isFeatureSuppressed,
  type BodyId,
  type BodyRepresentation,
  type ParamValue,
  type ProjectDocument
} from '@openzcad/shared';

/** Viewport-owned instances. They never enter document.derived or an export. */
export interface ParameterPreviewBody {
  bodyId: BodyId;
  replaces: BodyId[];
  color: string;
  opacity?: number;
  parts: { key: string; mesh: BodyRepresentation['mesh']; matrix: number[] }[];
}
export type ParameterVisualPreview = ParameterPreviewBody[];
const axes = ['x', 'y', 'z'] as const;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const evaluate = (value: ParamValue, scope: Record<string, number>) =>
  typeof value === 'number' ? value : evaluateExpression(value, scope);

/** Unknown warnings fail closed; attributed suppression/advisories do not. */
export function previewWarningsAllow(
  document: ProjectDocument,
  features: Set<string>
): boolean {
  return document.derived.warnings.every((message) => {
    const attributed = document.derived.featureWarnings?.filter(
      (w) => w.message === message
    );
    return (
      !!attributed?.length &&
      attributed.every(
        (w) =>
          w.kind === 'suppressed' ||
          w.kind === 'advisory' ||
          !features.has(w.featureId)
      )
    );
  });
}

interface Construction {
  result: BodyId;
  features: Set<string>;
  controls: [string, number][];
  parts: {
    bodyId: BodyId;
    move: Record<'x' | 'y' | 'z', ParamValue>;
    stretch?: {
      axis: 'x' | 'y' | 'z';
      offset: ParamValue;
      distance: ParamValue;
    };
  }[];
}

/** Compatibility with the prepared two-import construction, without rewriting it. */
function legacyConstruction(doc: ProjectDocument): Construction | null {
  const features = listFeaturesInOrder(doc);
  const [left, right, section, bridge, moveLeft, moveRight, union] = features;
  if (
    !left ||
    !right ||
    !section ||
    !bridge ||
    !moveLeft ||
    !moveRight ||
    !union ||
    features.slice(0, 7).some(isFeatureSuppressed) ||
    left.data.featureKind !== 'imported-step' ||
    right.data.featureKind !== 'imported-step' ||
    section.data.featureKind !== 'sketch' ||
    bridge.data.featureKind !== 'extrude' ||
    moveLeft.data.featureKind !== 'transform' ||
    moveRight.data.featureKind !== 'transform' ||
    union.data.featureKind !== 'boolean' ||
    !left.bodyId ||
    !right.bodyId ||
    !bridge.bodyId ||
    !union.bodyId
  )
    return null;
  const width = 'require_min(opening_width, 16.1)';
  const sketch = findSketch(doc, bridge.data.sketchId);
  if (
    !sketch ||
    sketch.sketchId !== section.data.sketchId ||
    sketch.constraints?.length ||
    sketch.planeRef.type !== 'canonical' ||
    sketch.planeRef.plane !== 'YZ' ||
    sketch.planeRef.offset !== `19 - (${width}) / 2` ||
    bridge.data.distance !== `(${width}) - 16` ||
    bridge.data.symmetric ||
    bridge.data.backDistance ||
    (bridge.data.operation && bridge.data.operation !== 'new-body') ||
    !sketch.objectIds.length ||
    sketch.objectIds.some((id) => {
      const node = doc.nodes[id];
      return (
        node?.kind !== 'sketch-object' ||
        !['line', 'arc'].includes(node.objectKind) ||
        Object.entries(node.data).some(
          ([key, value]) =>
            key !== 'objectKind' &&
            typeof value !== 'boolean' &&
            (typeof value !== 'number' || !Number.isFinite(value))
        )
      );
    })
  )
    return null;
  for (const [feature, body, x] of [
    [moveLeft, left.bodyId, `(46 - (${width})) / 2`],
    [moveRight, right.bodyId, `((${width}) - 46) / 2`]
  ] as const) {
    const d = feature.data;
    if (
      d.featureKind !== 'transform' ||
      d.targetBodyId !== body ||
      d.transform.translation.x !== x ||
      d.transform.translation.y !== 0 ||
      d.transform.translation.z !== 0 ||
      Object.values(d.transform.rotationDeg).some((v) => v !== 0) ||
      (d.transform.scale !== undefined && d.transform.scale !== 1)
    )
      return null;
  }
  if (
    union.data.operation !== 'union' ||
    union.data.activeWhen !== undefined ||
    JSON.stringify(union.data.targetBodyIds) !==
      JSON.stringify([left.bodyId, bridge.bodyId, right.bodyId])
  )
    return null;
  return {
    result: union.bodyId,
    controls: [['opening_width', 16.1]],
    features: new Set(features.slice(0, 7).map((f) => f.featureId)),
    parts: [
      { bodyId: left.bodyId, move: moveLeft.data.transform.translation },
      {
        bodyId: bridge.bodyId,
        move: { x: 0, y: 0, z: 0 },
        stretch: {
          axis: 'x',
          offset: sketch.planeRef.offset,
          distance: bridge.data.distance
        }
      },
      { bodyId: right.bodyId, move: moveRight.data.transform.translation }
    ]
  };
}

function constructionFeatures(
  doc: ProjectDocument,
  result: BodyId
): Set<string> {
  const needed = new Set<string>([result]);
  const features = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') needed.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(collect);
  };
  const ordered = listFeaturesInOrder(doc);
  let producer = -1;
  ordered.forEach((f, i) => {
    if (f.bodyId === result) producer = i;
  });
  for (const f of ordered.slice(0, producer + 1).reverse()) {
    if (
      (f.bodyId && needed.has(f.bodyId)) ||
      ('targetBodyId' in f.data && needed.has(f.data.targetBodyId!)) ||
      ('sketchId' in f.data && needed.has(f.data.sketchId))
    ) {
      features.add(f.featureId);
      if (f.data.featureKind !== 'imported-step') collect(f.data);
    }
  }
  return features;
}

function constructions(doc: ProjectDocument): Construction[] {
  const histories = growingHolderHistories(doc);
  if (!histories.length) {
    const legacy = legacyConstruction(doc);
    return legacy ? [legacy] : [];
  }
  return histories.flatMap((h) => {
    const features = constructionFeatures(doc, h.resultBodyId);
    const holder: Construction = {
      result: h.resultBodyId,
      features,
      controls: [
        [h.recipe.parameter, h.recipe.minimumOpening],
        ...(h.recipe.height
          ? [
              [h.recipe.height.parameter, h.recipe.height.minimumHeight] as [
                string,
                number
              ]
            ]
          : [])
      ],
      parts: h.plan.unionOrder.map((key) => {
        const bridge = h.plan.bridges.find((b) => b.key === key);
        const piece = bridge ?? h.plan.pieces.find((p) => p.key === key)!;
        return {
          bodyId: h.bodies[key]!,
          move: piece.move,
          ...(bridge
            ? {
                stretch: {
                  axis: bridge.axis,
                  offset: bridge.offset,
                  distance: bridge.distance
                }
              }
            : {})
        };
      })
    };
    return h.text
      ? [
          holder,
          {
            ...holder,
            result: h.text.bodyId,
            features: constructionFeatures(doc, h.text.bodyId),
            parts: [{ bodyId: h.text.bodyId, move: h.text.move }]
          }
        ]
      : [holder];
  });
}

function mentions(value: unknown, names: Set<string>): boolean {
  if (typeof value === 'string')
    return [...names].some(
      (name) => value === name || new RegExp(`\\b${name}\\b`).test(value)
    );
  if (Array.isArray(value)) return value.some((v) => mentions(v, names));
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some((v) => mentions(v, names))
  );
}

/** No per-vertex work: an edit allocates only a few matrices and instance records. */
export function parameterVisualPreview(
  base: ProjectDocument | null,
  next: ProjectDocument | null,
  includeUnchanged = false
): ParameterVisualPreview | null {
  if (
    !base ||
    !next ||
    base.projectId !== next.projectId ||
    base.units !== next.units ||
    JSON.stringify(base.featureOrder) !== JSON.stringify(next.featureOrder) ||
    JSON.stringify(base.bodyOrder) !== JSON.stringify(next.bodyOrder)
  )
    return null;
  const structure = (d: ProjectDocument) =>
    Object.values(d.nodes).filter((n) => n.kind !== 'parameter');
  if (JSON.stringify(structure(base)) !== JSON.stringify(structure(next)))
    return null;
  const recipes = constructions(next);
  if (!recipes.length) return null;
  const before = getParameterScope(base),
    after = getParameterScope(next);
  if (before.errors.length || after.errors.length) return null;
  const controlled = new Set(
    recipes.flatMap((r) => r.controls.map(([name]) => name))
  );
  const changed = new Set(
    [
      ...new Set([...Object.keys(before.scope), ...Object.keys(after.scope)])
    ].filter((k) => before.scope[k] !== after.scope[k])
  );
  if (
    (!changed.size && !includeUnchanged) ||
    [...changed].some((k) => !controlled.has(k))
  )
    return null;
  const previewedFeatures = new Set(recipes.flatMap((r) => [...r.features]));
  const previews: ParameterVisualPreview = [];
  try {
    for (const recipe of recipes) {
      if (changed.size && !recipe.controls.some(([name]) => changed.has(name)))
        continue;
      if (
        !previewWarningsAllow(base, recipe.features) ||
        recipe.controls.some(
          ([name, min]) =>
            !Number.isFinite(before.scope[name]) ||
            !Number.isFinite(after.scope[name]) ||
            before.scope[name]! < min ||
            after.scope[name]! < min
        )
      )
        return null;
      const body = base.derived.bodyRepresentations[recipe.result];
      if (!body) return null;
      let preview: ParameterPreviewBody = {
        bodyId: body.bodyId,
        replaces: [body.bodyId, ...recipe.parts.map((p) => p.bodyId)],
        color: body.color,
        opacity: body.opacity,
        parts: []
      };
      for (const part of recipe.parts) {
        const representation = base.derived.bodyRepresentations[part.bodyId];
        if (!representation) return null;
        const matrix = identity();
        axes.forEach((axis, i) => {
          matrix[12 + i] =
            evaluate(part.move[axis], after.scope) -
            evaluate(part.move[axis], before.scope);
        });
        if (part.stretch) {
          const i = axes.indexOf(part.stretch.axis);
          const ratio =
            evaluate(part.stretch.distance, after.scope) /
            evaluate(part.stretch.distance, before.scope);
          if (!(ratio > 0)) return null;
          matrix[i * 5] = ratio;
          matrix[12 + i] =
            evaluate(part.stretch.offset, after.scope) +
            evaluate(part.move[part.stretch.axis], after.scope) -
            (evaluate(part.stretch.offset, before.scope) +
              evaluate(part.move[part.stretch.axis], before.scope)) *
              ratio;
        }
        if (!matrix.every(Number.isFinite)) return null;
        preview.parts.push({
          key: part.bodyId,
          mesh: representation.mesh,
          matrix
        });
      }
      // Only supported consumers may stand in for the changed result. Never
      // leave an unrelated dependent cut/fillet displaying obsolete geometry.
      const affected = new Set<string>([
        recipe.result,
        ...recipe.parts.map((part) => part.bodyId)
      ]);
      for (const feature of listFeaturesInOrder(next)) {
        if (
          previewedFeatures.has(feature.featureId) ||
          isFeatureSuppressed(feature)
        )
          continue;
        const d = feature.data;
        if (d.featureKind === 'imported-step') continue;
        if (!mentions(d, affected) && !mentions(d, changed)) continue;
        if (
          d.featureKind !== 'pattern' ||
          d.targetBodyId !== preview.bodyId ||
          !feature.bodyId ||
          d.patternKind === 'circular' ||
          d.direction
        )
          return null;
        const count = Math.round(evaluate(d.count, after.scope));
        const count2 =
          d.patternKind === 'grid'
            ? Math.round(evaluate(d.count2 ?? d.count, after.scope))
            : 1;
        const spacing = evaluate(d.spacing, after.scope),
          spacing2 = evaluate(d.spacing2 ?? d.spacing, after.scope);
        if (
          count < 2 ||
          count > 100 ||
          count2 < (d.patternKind === 'grid' ? 2 : 1) ||
          count * count2 > 100 ||
          !Number.isFinite(spacing) ||
          !Number.isFinite(spacing2) ||
          spacing === 0 ||
          (d.patternKind === 'grid' &&
            (spacing2 === 0 || d.axis === (d.axis2 ?? 'y')))
        )
          return null;
        const parts: ParameterPreviewBody['parts'] = [];
        for (let x = 0; x < count; x++)
          for (let y = 0; y < count2; y++)
            for (const part of preview.parts) {
              const matrix = [...part.matrix];
              matrix[12 + axes.indexOf(d.axis)]! += x * spacing;
              matrix[12 + axes.indexOf(d.axis2 ?? 'y')]! += y * spacing2;
              parts.push({
                ...part,
                key: `${feature.bodyId}:${x}:${y}:${part.key}`,
                matrix
              });
            }
        affected.add(feature.bodyId);
        preview = {
          ...preview,
          bodyId: feature.bodyId,
          replaces: [...preview.replaces, feature.bodyId],
          parts
        };
      }
      previews.push(preview);
    }
  } catch {
    return null;
  }
  return previews.length ? previews : null;
}
