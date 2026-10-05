import type {
  DirectEditOperation,
  DocumentNode,
  FeatureData,
  ParametricVector3,
  SketchObjectData
} from '@openzcad/shared';

type Rewrite = (expression: string) => string;

function fields<T extends object>(
  value: T,
  keys: readonly (keyof T)[],
  rewrite: Rewrite
): void {
  for (const key of keys) {
    if (typeof value[key] === 'string') {
      const next = rewrite(value[key]);
      if (next !== value[key]) value[key] = next as T[keyof T];
    }
  }
}

function vector(value: ParametricVector3 | undefined, rewrite: Rewrite): void {
  if (value) fields(value, ['x', 'y', 'z'], rewrite);
}

function directEdit(data: DirectEditOperation, rewrite: Rewrite): void {
  switch (data.kind) {
    case 'resize-through-hole':
      fields(data, ['diameter'], rewrite);
      return;
    case 'resize-imported-blind-hole':
      fields(data, ['diameter', 'depth'], rewrite);
      return;
    case 'resize-imported-counterbore':
      fields(
        data,
        ['boreDiameter', 'counterboreDiameter', 'counterboreDepth'],
        rewrite
      );
      return;
    case 'resize-imported-countersink':
      fields(data, ['boreDiameter', 'sinkDiameter', 'angleRadians'], rewrite);
      return;
    case 'offset-face':
      fields(data, ['offset'], rewrite);
      return;
    case 'set-face-distance':
      fields(data, ['distance'], rewrite);
      return;
    case 'resize-cylindrical-face':
      fields(data, ['radius'], rewrite);
      return;
    case 'resize-blend':
      fields(data, ['newRadius'], rewrite);
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
      fields(data.dimensions, Object.keys(data.dimensions), rewrite);
      return;
    case 'extrude':
      fields(data, ['distance', 'backDistance'], rewrite);
      return;
    case 'revolve':
      fields(data, ['angleDeg'], rewrite);
      return;
    case 'loft':
      vector(data.endPoint, rewrite);
      return;
    case 'helical-sweep':
      fields(data, ['radius', 'pitch', 'turns'], rewrite);
      vector(data.axisOrigin, rewrite);
      vector(data.axisDirection, rewrite);
      return;
    case 'boolean':
      fields(data, ['activeWhen'], rewrite);
      return;
    case 'transform':
      fields(data.transform, ['scale'], rewrite);
      vector(data.transform.translation, rewrite);
      vector(data.transform.rotationDeg, rewrite);
      return;
    case 'mirror':
    case 'split':
      vector(data.plane.origin, rewrite);
      vector(data.plane.normal, rewrite);
      return;
    case 'hole':
      fields(
        data,
        [
          'diameter',
          'depth',
          'counterboreDiameter',
          'counterboreDepth',
          'countersinkDiameter',
          'countersinkAngleDeg'
        ],
        rewrite
      );
      fields(data.position, ['u', 'v'], rewrite);
      return;
    case 'shell':
    case 'thicken':
      fields(data, ['thickness'], rewrite);
      return;
    case 'solid-offset':
      fields(data, ['distance'], rewrite);
      return;
    case 'draft':
      fields(data, ['angleDeg'], rewrite);
      vector(data.pullDirection, rewrite);
      vector(data.neutralPoint, rewrite);
      return;
    case 'fillet':
      fields(data, ['radius', 'endRadius'], rewrite);
      return;
    case 'chamfer':
      fields(data, ['distance', 'angleDeg', 'distance2'], rewrite);
      return;
    case 'pattern':
      fields(
        data,
        ['count', 'spacing', 'angleDeg', 'spacing2', 'count2'],
        rewrite
      );
      vector(data.direction, rewrite);
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
      fields(data, ['width', 'height', 'centerX', 'centerY'], rewrite);
      return;
    case 'circle':
      fields(data, ['radius', 'centerX', 'centerY'], rewrite);
      return;
    case 'polygon':
      fields(data, ['sides', 'radius', 'centerX', 'centerY'], rewrite);
      return;
    case 'line':
      fields(data, ['x1', 'y1', 'x2', 'y2'], rewrite);
      return;
    case 'arc':
      fields(
        data,
        ['radius', 'centerX', 'centerY', 'startAngleDeg', 'endAngleDeg'],
        rewrite
      );
      return;
    case 'text':
      fields(data, ['size', 'x', 'y', 'rotation'], rewrite);
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
  else if (node.kind === 'parameter') fields(node, ['expression'], rewrite);
  else if (node.kind === 'sketch') {
    if (node.planeRef.type === 'canonical')
      fields(node.planeRef, ['offset'], rewrite);
    fields(node, ['offset'], rewrite);
    for (const constraint of node.constraints ?? []) {
      const data = constraint.data;
      if (
        data.constraintKind === 'distance' ||
        data.constraintKind === 'radius'
      )
        fields(data, ['value'], rewrite);
      else if (data.constraintKind === 'angle')
        fields(data, ['valueDeg'], rewrite);
    }
  }
}
