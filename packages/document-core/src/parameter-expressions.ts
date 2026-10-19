import type {
  DirectEditOperation,
  DocumentNode,
  FeatureData,
  ParametricVector3,
  SketchObjectData
} from '@openzcad/shared';
import { datumPlaneSources, datumPointSources } from '@openzcad/shared';

/**
 * What a field holds (F05): a length, an angle in degrees, a unit-free
 * number, or `null` when no quantity rule applies (direction components,
 * a radians field, an on/off condition).
 */
export type ExpressionFieldDimension = 'length' | 'angle' | 'number' | null;

/** Where a visited expression is stored: its holding object and key. */
export interface ExpressionFieldSite {
  container: object;
  key: string;
}

type Rewrite = (
  expression: string,
  dimension: ExpressionFieldDimension,
  site: ExpressionFieldSite
) => string;

function fields<T extends object>(
  value: T,
  keys: readonly (keyof T)[],
  rewrite: Rewrite,
  dimension: ExpressionFieldDimension
): void {
  for (const key of keys) {
    if (typeof value[key] === 'string') {
      const next = rewrite(value[key], dimension, {
        container: value,
        key: String(key)
      });
      if (next !== value[key]) value[key] = next as T[keyof T];
    }
  }
}

function vector(
  value: ParametricVector3 | undefined,
  rewrite: Rewrite,
  dimension: ExpressionFieldDimension
): void {
  if (value) fields(value, ['x', 'y', 'z'], rewrite, dimension);
}

function directEdit(data: DirectEditOperation, rewrite: Rewrite): void {
  switch (data.kind) {
    case 'resize-through-hole':
      fields(data, ['diameter'], rewrite, 'length');
      return;
    case 'resize-imported-blind-hole':
      fields(data, ['diameter', 'depth'], rewrite, 'length');
      return;
    case 'resize-imported-counterbore':
      fields(
        data,
        ['boreDiameter', 'counterboreDiameter', 'counterboreDepth'],
        rewrite,
        'length'
      );
      return;
    case 'resize-imported-countersink':
      fields(data, ['boreDiameter', 'sinkDiameter'], rewrite, 'length');
      // Stored as raw radians: a typed angle (degrees) or length would be
      // reinterpreted, so only a unitless value may drive it.
      fields(data, ['angleRadians'], rewrite, 'number');
      return;
    case 'offset-face':
      fields(data, ['offset'], rewrite, 'length');
      return;
    case 'set-face-distance':
      fields(data, ['distance'], rewrite, 'length');
      return;
    case 'resize-cylindrical-face':
      fields(data, ['radius'], rewrite, 'length');
      return;
    case 'resize-blend':
      fields(data, ['newRadius'], rewrite, 'length');
      return;
    case 'remove-face-feature':
      return;
    default:
      data satisfies never;
  }
}

function feature(data: FeatureData, rewrite: Rewrite): void {
  switch (data.featureKind) {
    case 'primitive':
      fields(data.dimensions, Object.keys(data.dimensions), rewrite, 'length');
      return;
    case 'extrude':
      fields(data, ['distance', 'backDistance'], rewrite, 'length');
      fields(data, ['draftAngleDeg'], rewrite, 'angle');
      return;
    case 'revolve':
      fields(data, ['angleDeg'], rewrite, 'angle');
      return;
    case 'loft':
      vector(data.endPoint, rewrite, 'length');
      return;
    case 'helical-sweep':
      fields(data, ['radius', 'pitch'], rewrite, 'length');
      fields(data, ['turns'], rewrite, 'number');
      vector(data.axisOrigin, rewrite, 'length');
      vector(data.axisDirection, rewrite, null);
      return;
    case 'boolean':
      fields(data, ['activeWhen'], rewrite, null);
      return;
    case 'transform':
      fields(data.transform, ['scale'], rewrite, 'number');
      vector(data.transform.translation, rewrite, 'length');
      vector(data.transform.rotationDeg, rewrite, 'angle');
      vector(data.transform.pivot, rewrite, 'length');
      return;
    case 'mirror':
    case 'split':
      // A datum reference carries no expressions of its own; the datum's
      // feature is rewritten where it stands in history.
      if ('origin' in data.plane) {
        vector(data.plane.origin, rewrite, 'length');
        vector(data.plane.normal, rewrite, null);
      }
      return;
    case 'datum-plane': {
      const definition = data.definition;
      if (definition.kind === 'offset')
        fields(definition, ['offset'], rewrite, 'length');
      for (const source of datumPlaneSources(definition))
        if (source.type === 'canonical')
          fields(source, ['offset'], rewrite, 'length');
      for (const point of datumPointSources(definition))
        if (point.type === 'point') vector(point.point, rewrite, 'length');
      return;
    }
    case 'hole':
      fields(
        data,
        [
          'diameter',
          'depth',
          'counterboreDiameter',
          'counterboreDepth',
          'countersinkDiameter'
        ],
        rewrite,
        'length'
      );
      fields(data, ['countersinkAngleDeg'], rewrite, 'angle');
      fields(data.position, ['u', 'v'], rewrite, 'length');
      return;
    case 'shell':
    case 'thicken':
      fields(data, ['thickness'], rewrite, 'length');
      return;
    case 'solid-offset':
      fields(data, ['distance'], rewrite, 'length');
      return;
    case 'draft':
      fields(data, ['angleDeg'], rewrite, 'angle');
      vector(data.pullDirection, rewrite, null);
      vector(data.neutralPoint, rewrite, 'length');
      return;
    case 'fillet':
      fields(data, ['radius', 'endRadius'], rewrite, 'length');
      return;
    case 'chamfer':
      fields(data, ['distance', 'distance2'], rewrite, 'length');
      fields(data, ['angleDeg'], rewrite, 'angle');
      return;
    case 'pattern':
      fields(data, ['count', 'count2'], rewrite, 'number');
      fields(data, ['spacing', 'spacing2'], rewrite, 'length');
      fields(data, ['angleDeg'], rewrite, 'angle');
      vector(data.direction, rewrite, null);
      return;
    case 'direct-edit':
      directEdit(data.operation, rewrite);
      return;
    case 'sketch':
    case 'sweep':
    case 'imported-mesh':
    case 'imported-step':
      return;
    default:
      data satisfies never;
  }
}

function sketchObject(data: SketchObjectData, rewrite: Rewrite): void {
  switch (data.objectKind) {
    case 'rectangle':
      fields(
        data,
        ['width', 'height', 'centerX', 'centerY'],
        rewrite,
        'length'
      );
      return;
    case 'circle':
      fields(data, ['radius', 'centerX', 'centerY'], rewrite, 'length');
      return;
    case 'polygon':
      fields(data, ['sides'], rewrite, 'number');
      fields(data, ['radius', 'centerX', 'centerY'], rewrite, 'length');
      return;
    case 'line':
      fields(data, ['x1', 'y1', 'x2', 'y2'], rewrite, 'length');
      return;
    case 'arc':
      fields(data, ['radius', 'centerX', 'centerY'], rewrite, 'length');
      fields(data, ['startAngleDeg', 'endAngleDeg'], rewrite, 'angle');
      return;
    case 'text':
      fields(data, ['size', 'x', 'y'], rewrite, 'length');
      fields(data, ['rotation'], rewrite, 'angle');
      return;
    default:
      data satisfies never;
  }
}

/** Visits only authored expression fields; ids, enums, text and witnesses are literals. */
export function rewriteNodeExpressions(
  node: DocumentNode,
  rewrite: Rewrite
): void {
  if (node.kind === 'feature') feature(node.data, rewrite);
  else if (node.kind === 'sketch-object') sketchObject(node.data, rewrite);
  else if (node.kind === 'parameter')
    fields(node, ['expression'], rewrite, node.quantity ?? null);
  else if (node.kind === 'sketch') {
    if (node.planeRef.type === 'canonical')
      fields(node.planeRef, ['offset'], rewrite, 'length');
    fields(node, ['offset'], rewrite, 'length');
    for (const constraint of node.constraints ?? []) {
      const data = constraint.data;
      if (
        data.constraintKind === 'distance' ||
        data.constraintKind === 'radius'
      )
        fields(data, ['value'], rewrite, 'length');
      else if (data.constraintKind === 'angle')
        fields(data, ['valueDeg'], rewrite, 'angle');
    }
  }
}
