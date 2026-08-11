import {
  isFeatureSuppressed,
  type BodyId,
  type FeatureId,
  type FeatureNode,
  type ParameterNode,
  type ParamValue,
  type ProjectDocument,
  type SketchNode,
  type SketchObjectData
} from '@openzcad/shared';
import type {
  CadPatchOperation,
  CadPatchProposal,
  CadSelectionContext
} from './index';
import { isSketchDimensionField } from './sketch-dimensions';

/** Two patch operations (declare + bind) are emitted for every candidate. */
const MAX_AUTO_PARAMETER_CANDIDATES = 30;
const NUMERIC_LITERAL =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const PARAMETER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface ParameterCandidate {
  baseName: string;
  expression: string;
  imported: boolean;
  bind(parameterName: string): CadPatchOperation;
}

function listFeaturesInOrder(document: ProjectDocument): FeatureNode[] {
  const features = Object.values(document.nodes).filter(
    (node): node is FeatureNode => node.kind === 'feature'
  );
  const byId = new Map(features.map((feature) => [feature.featureId, feature]));
  const ordered = document.featureOrder.flatMap((featureId) => {
    const feature = byId.get(featureId);
    if (feature) {
      byId.delete(featureId);
      return [feature];
    }
    return [];
  });
  return [...ordered, ...byId.values()];
}

function findSketch(
  document: ProjectDocument,
  sketchId: string
): SketchNode | undefined {
  return Object.values(document.nodes).find(
    (node): node is SketchNode =>
      node.kind === 'sketch' && node.sketchId === sketchId
  );
}

function listParameters(document: ProjectDocument): ParameterNode[] {
  return Object.values(document.nodes).filter(
    (node): node is ParameterNode => node.kind === 'parameter'
  );
}

function literalExpression(value: ParamValue | undefined): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const expression = value.trim();
  return NUMERIC_LITERAL.test(expression) && Number.isFinite(Number(expression))
    ? expression
    : null;
}

function isZeroLiteral(expression: string): boolean {
  return Math.abs(Number(expression)) <= Number.EPSILON;
}

function parameterBase(...parts: string[]): string {
  let name = parts
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))
    .join('_')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 72);
  if (!name) {
    name = 'dimension';
  }
  if (/^[0-9]/.test(name)) {
    name = `dimension_${name}`;
  }
  return PARAMETER_NAME.test(name) ? name : `dimension_${name}`;
}

function uniqueParameterName(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || !PARAMETER_NAME.test(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function selectedBodyIds(selection: CadSelectionContext): BodyId[] {
  return [
    ...new Set([
      ...selection.bodyIds,
      ...selection.topologies.map((topology) => String(topology.bodyId))
    ])
  ] as BodyId[];
}

function sameAxisSpan(
  firstStart: { x: number; y: number; z: number },
  firstEnd: { x: number; y: number; z: number },
  secondStart: { x: number; y: number; z: number },
  secondEnd: { x: number; y: number; z: number }
): boolean {
  const distance = (
    left: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number }
  ) => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
  const scale = Math.max(
    1,
    distance(firstStart, firstEnd),
    distance(secondStart, secondEnd)
  );
  const tolerance = scale * 1e-8;
  const close = (
    left: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number }
  ) => distance(left, right) <= tolerance;
  return (
    (close(firstStart, secondStart) && close(firstEnd, secondEnd)) ||
    (close(firstStart, secondEnd) && close(firstEnd, secondStart))
  );
}

/** Walks the canonical history backwards from one or more result bodies. */
function featureScopeForBodies(
  document: ProjectDocument,
  bodyIds: readonly BodyId[]
): Set<FeatureId> {
  const features = listFeaturesInOrder(document);
  const neededBodies = new Set(bodyIds);
  const neededSketches = new Set<string>();
  const included = new Set<FeatureId>();

  for (let index = features.length - 1; index >= 0; index -= 1) {
    const feature = features[index]!;
    if (isFeatureSuppressed(feature)) {
      continue;
    }
    const data = feature.data;
    const includedByBody =
      (feature.bodyId !== undefined && neededBodies.has(feature.bodyId)) ||
      ((data.featureKind === 'transform' ||
        data.featureKind === 'direct-edit') &&
        neededBodies.has(data.targetBodyId));
    const includedBySketch =
      data.featureKind === 'sketch' && neededSketches.has(data.sketchId);
    if (!includedByBody && !includedBySketch) {
      continue;
    }

    included.add(feature.featureId);
    switch (data.featureKind) {
      case 'sketch':
        break;
      case 'extrude':
        neededSketches.add(data.sketchId);
        if (data.targetBodyId) {
          neededBodies.add(data.targetBodyId);
        }
        break;
      case 'revolve':
        neededSketches.add(data.sketchId);
        break;
      case 'boolean':
        data.targetBodyIds.forEach((bodyId) => neededBodies.add(bodyId));
        break;
      case 'transform':
      case 'mirror':
      case 'shell':
      case 'solid-offset':
      case 'fillet':
      case 'chamfer':
      case 'pattern':
      case 'direct-edit':
        neededBodies.add(data.targetBodyId);
        break;
      case 'primitive':
      case 'imported-step':
      case 'imported-mesh':
        break;
    }
  }
  return included;
}

function featureScope(
  document: ProjectDocument,
  selection: CadSelectionContext
): Set<FeatureId> {
  const bodies = selectedBodyIds(selection);
  if (bodies.length > 0) {
    return featureScopeForBodies(document, bodies);
  }
  if (selection.featureIds.length > 0) {
    return new Set(selection.featureIds);
  }
  return new Set(
    listFeaturesInOrder(document)
      .filter((feature) => !isFeatureSuppressed(feature))
      .map((feature) => feature.featureId)
  );
}

function featureCandidate(
  feature: FeatureNode,
  field: string,
  value: ParamValue | undefined
): ParameterCandidate | null {
  const expression = literalExpression(value);
  if (!expression) {
    return null;
  }
  return {
    baseName: parameterBase(feature.name, field.replace('.', '_')),
    expression,
    imported: false,
    bind: (parameterName) => ({
      kind: 'set_feature_dimension',
      featureId: feature.featureId,
      field,
      value: parameterName
    })
  };
}

function sketchCandidates(
  document: ProjectDocument,
  feature: FeatureNode
): { candidates: ParameterCandidate[]; skippedRelational: number } {
  if (feature.data.featureKind !== 'sketch') {
    return { candidates: [], skippedRelational: 0 };
  }
  const sketch = findSketch(document, feature.data.sketchId);
  if (!sketch) {
    return { candidates: [], skippedRelational: 0 };
  }
  const candidates: ParameterCandidate[] = [];
  let skippedRelational = 0;
  sketch.objectIds.forEach((objectId, index) => {
    const object = document.nodes[objectId];
    if (!object || object.kind !== 'sketch-object') {
      return;
    }
    const data = object.data;
    // Independent line/arc coordinate bindings can open a previously closed
    // profile. Leave them literal until the constraint model can preserve the
    // relationship instead of merely preserving today's numeric coincidence.
    if (data.objectKind === 'line' || data.objectKind === 'arc') {
      skippedRelational += Object.keys(data).filter((field) =>
        isSketchDimensionField(data.objectKind, field)
      ).length;
      return;
    }
    for (const field of Object.keys(data)) {
      if (!isSketchDimensionField(data.objectKind, field)) {
        continue;
      }
      const expression = literalExpression(
        data[field as keyof SketchObjectData] as ParamValue | undefined
      );
      if (!expression) {
        continue;
      }
      const positional = ['centerX', 'centerY', 'x', 'y', 'rotation'].includes(
        field
      );
      if (positional && isZeroLiteral(expression)) {
        continue;
      }
      candidates.push({
        baseName: parameterBase(
          feature.name,
          data.objectKind,
          String(index + 1),
          field
        ),
        expression,
        imported: false,
        bind: (parameterName) => ({
          kind: 'set_sketch_dimension',
          sketchId: sketch.sketchId,
          objectId,
          field,
          value: parameterName
        })
      });
    }
  });
  return { candidates, skippedRelational };
}

function nativeCandidates(
  document: ProjectDocument,
  scope: Set<FeatureId>
): { candidates: ParameterCandidate[]; skippedRelational: number } {
  const candidates: ParameterCandidate[] = [];
  let skippedRelational = 0;
  const add = (candidate: ParameterCandidate | null) => {
    if (candidate) {
      candidates.push(candidate);
    }
  };

  for (const feature of listFeaturesInOrder(document)) {
    if (!scope.has(feature.featureId) || isFeatureSuppressed(feature)) {
      continue;
    }
    const data = feature.data;
    switch (data.featureKind) {
      case 'primitive':
        Object.entries(data.dimensions).forEach(([field, value]) =>
          add(featureCandidate(feature, field, value))
        );
        break;
      case 'sketch': {
        const sketch = sketchCandidates(document, feature);
        candidates.push(...sketch.candidates);
        skippedRelational += sketch.skippedRelational;
        break;
      }
      case 'extrude':
        add(featureCandidate(feature, 'distance', data.distance));
        break;
      case 'revolve':
        add(featureCandidate(feature, 'angleDeg', data.angleDeg));
        break;
      case 'transform':
        (['translation', 'rotationDeg'] as const).forEach((group) =>
          (['x', 'y', 'z'] as const).forEach((axis) => {
            const value = data.transform[group][axis];
            const expression = literalExpression(value);
            if (expression && !isZeroLiteral(expression)) {
              add(featureCandidate(feature, `${group}.${axis}`, value));
            }
          })
        );
        break;
      case 'shell':
        add(featureCandidate(feature, 'thickness', data.thickness));
        break;
      case 'solid-offset':
        add(featureCandidate(feature, 'distance', data.distance));
        break;
      case 'fillet':
        add(featureCandidate(feature, 'radius', data.radius));
        break;
      case 'chamfer':
        add(featureCandidate(feature, 'distance', data.distance));
        break;
      case 'pattern':
        add(featureCandidate(feature, 'count', data.count));
        add(featureCandidate(feature, 'spacing', data.spacing));
        add(featureCandidate(feature, 'angleDeg', data.angleDeg));
        break;
      case 'direct-edit':
        if (data.operation.kind === 'resize-through-hole') {
          add(featureCandidate(feature, 'diameter', data.operation.diameter));
        } else if (data.operation.kind === 'resize-cylindrical-face') {
          add(featureCandidate(feature, 'radius', data.operation.radius));
        } else if (data.operation.kind === 'offset-face') {
          add(featureCandidate(feature, 'offset', data.operation.offset));
        }
        break;
      case 'boolean':
      case 'mirror':
      case 'imported-step':
      case 'imported-mesh':
        break;
    }
  }
  return { candidates, skippedRelational };
}

function importedThroughHoleCandidates(
  document: ProjectDocument,
  selection: CadSelectionContext
): ParameterCandidate[] {
  const selected = selectedBodyIds(selection);
  const targetBodyIds =
    selected.length > 0
      ? selected
      : document.derived.exportableBodyIds.filter(
          (bodyId) => !document.derived.bodyRepresentations[bodyId]?.consumed
        );
  const features = listFeaturesInOrder(document);
  const candidates: ParameterCandidate[] = [];

  for (const bodyId of targetBodyIds) {
    const body = document.derived.bodyRepresentations[bodyId];
    if (!body?.topology || body.consumed) {
      continue;
    }
    const scope = featureScopeForBodies(document, [bodyId]);
    const imported = features.some(
      (feature) =>
        scope.has(feature.featureId) &&
        feature.data.featureKind === 'imported-step'
    );
    const existingHoleEdits = features.flatMap((feature) => {
      const data = feature.data;
      return scope.has(feature.featureId) &&
        data.featureKind === 'direct-edit' &&
        data.targetBodyId === bodyId &&
        data.operation.kind === 'resize-through-hole'
        ? [data.operation]
        : [];
    });
    if (!imported) {
      continue;
    }

    let holeIndex = 0;
    for (const face of body.topology.faces) {
      const geometry = face.geometry;
      const reference = face.reference;
      const diameter = geometry?.diameter;
      const axisStart = geometry?.axisStart;
      const axisEnd = geometry?.axisEnd;
      if (
        geometry?.featureType !== 'through-hole' ||
        diameter === undefined ||
        !axisStart ||
        !axisEnd ||
        !reference ||
        reference.currentHash !== face.hash
      ) {
        continue;
      }
      if (
        existingHoleEdits.some((edit) =>
          sameAxisSpan(
            axisStart,
            axisEnd,
            edit.sourceAxisStart,
            edit.sourceAxisEnd
          )
        )
      ) {
        continue;
      }
      holeIndex += 1;
      const recognizedIndex = holeIndex;
      candidates.push({
        baseName: parameterBase(
          body.name,
          'hole',
          String(recognizedIndex),
          'diameter'
        ),
        expression: String(diameter),
        imported: true,
        bind: (parameterName) => ({
          kind: 'add_direct_edit',
          name: `Parameterize ${body.name} hole ${recognizedIndex}`,
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-through-hole',
            faceHash: face.hash,
            faceReference: reference,
            sourceDiameter: diameter,
            sourceAxisStart: axisStart,
            sourceAxisEnd: axisEnd,
            diameter: parameterName,
            parameterBinding: true
          }
        })
      });
    }
  }
  return candidates;
}

/**
 * Creates a provider-free assistant proposal from exact document state.
 * Language-model output never supplies topology here: names and bindings are
 * deterministic, and normal assistant preview/Apply still exact-preflights the
 * result as one undoable transaction.
 */
export function createAutoParameterizeProposal(
  document: ProjectDocument,
  selection: CadSelectionContext
): CadPatchProposal | null {
  const scope = featureScope(document, selection);
  const native = nativeCandidates(document, scope);
  const allCandidates = [
    ...native.candidates,
    ...importedThroughHoleCandidates(document, selection)
  ];
  if (allCandidates.length === 0) {
    return null;
  }

  const selected = allCandidates.slice(0, MAX_AUTO_PARAMETER_CANDIDATES);
  const usedNames = new Set(
    listParameters(document).map((parameter) => parameter.name)
  );
  const named = selected.map((candidate) => ({
    candidate,
    name: uniqueParameterName(candidate.baseName, usedNames)
  }));
  const importedCount = named.filter(
    ({ candidate }) => candidate.imported
  ).length;
  const assumptions = [
    'Every literal remains an independent parameter; equal numbers were not coupled without design-intent evidence.',
    'Exact preview must preserve the current body geometry before this proposal can be applied.'
  ];
  if (native.skippedRelational > 0) {
    assumptions.push(
      'Line and arc coordinates remain literal because independent bindings could open a closed profile without a constraint solver.'
    );
  }
  if (allCandidates.length > selected.length) {
    assumptions.push(
      `${allCandidates.length - selected.length} additional literal dimensions remain; run Auto-parameterize again after applying this bounded batch.`
    );
  }
  if (importedCount > 0) {
    assumptions.push(
      `${importedCount} imported through-hole diameter${importedCount === 1 ? '' : 's'} use kernel-proven exact topology; unsupported imported features remain unchanged.`
    );
  }

  return {
    proposalId: `auto_parameterize_v1_${document.version}`,
    summary: `${named.length} editable parameter${named.length === 1 ? '' : 's'} will replace literal driving values without changing the current exact geometry.`,
    assumptions,
    operations: [
      ...named.map(({ candidate, name }) => ({
        kind: 'set_parameter' as const,
        name,
        expression: candidate.expression
      })),
      ...named.map(({ candidate, name }) => candidate.bind(name))
    ],
    preserveGeometry: true
  };
}
