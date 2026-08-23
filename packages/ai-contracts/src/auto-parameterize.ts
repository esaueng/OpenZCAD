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

/** Parameter declarations are capped independently of grouped feature binds. */
const MAX_AUTO_PARAMETER_CANDIDATES = 30;
const NUMERIC_LITERAL =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const PARAMETER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface CandidateParameter {
  key: string;
  baseName: string;
  expression: string;
}

interface ParameterCandidate {
  parameters: CandidateParameter[];
  imported: boolean;
  bind(parameterNames: ReadonlyMap<string, string>): CadPatchOperation;
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
      case 'loft':
        data.sections.forEach((section) =>
          neededSketches.add(section.sketchId)
        );
        break;
      case 'sweep':
        neededSketches.add(data.profile.sketchId);
        neededSketches.add(data.path.sketchId);
        break;
      case 'helical-sweep':
        neededSketches.add(data.profile.sketchId);
        break;
      case 'boolean':
        data.targetBodyIds.forEach((bodyId) => neededBodies.add(bodyId));
        break;
      case 'transform':
      case 'mirror':
      case 'shell':
      case 'solid-offset':
      case 'draft':
      case 'thicken':
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
    parameters: [
      {
        key: field,
        baseName: parameterBase(feature.name, field.replace('.', '_')),
        expression
      }
    ],
    imported: false,
    bind: (parameterNames) => ({
      kind: 'set_feature_dimension',
      featureId: feature.featureId,
      field,
      value: parameterNames.get(field)!
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
        parameters: [
          {
            key: field,
            baseName: parameterBase(
              feature.name,
              data.objectKind,
              String(index + 1),
              field
            ),
            expression
          }
        ],
        imported: false,
        bind: (parameterNames) => ({
          kind: 'set_sketch_dimension',
          sketchId: sketch.sketchId,
          objectId,
          field,
          value: parameterNames.get(field)!
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
      case 'helical-sweep':
      case 'draft':
      case 'thicken':
      case 'loft':
      case 'sweep':
        // Manual commands and exact preflight ship first. These feature
        // dimensions are intentionally not proposed until CadPatch can apply
        // each one through the same validated update path.
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
        } else if (data.operation.kind === 'resize-imported-blind-hole') {
          add(featureCandidate(feature, 'diameter', data.operation.diameter));
          add(featureCandidate(feature, 'depth', data.operation.depth));
        } else if (data.operation.kind === 'resize-imported-counterbore') {
          add(
            featureCandidate(
              feature,
              'boreDiameter',
              data.operation.boreDiameter
            )
          );
          add(
            featureCandidate(
              feature,
              'counterboreDiameter',
              data.operation.counterboreDiameter
            )
          );
          add(
            featureCandidate(
              feature,
              'counterboreDepth',
              data.operation.counterboreDepth
            )
          );
        } else if (data.operation.kind === 'resize-imported-countersink') {
          add(
            featureCandidate(
              feature,
              'boreDiameter',
              data.operation.boreDiameter
            )
          );
          add(
            featureCandidate(
              feature,
              'sinkDiameter',
              data.operation.sinkDiameter
            )
          );
          add(
            featureCandidate(
              feature,
              'angleRadians',
              data.operation.angleRadians
            )
          );
        } else if (data.operation.kind === 'resize-cylindrical-face') {
          add(featureCandidate(feature, 'radius', data.operation.radius));
        } else if (data.operation.kind === 'resize-blend') {
          add(featureCandidate(feature, 'newRadius', data.operation.newRadius));
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
        (data.operation.kind === 'resize-through-hole' ||
          data.operation.kind === 'resize-imported-blind-hole' ||
          data.operation.kind === 'resize-imported-counterbore' ||
          data.operation.kind === 'resize-imported-countersink')
        ? [data.operation]
        : [];
    });
    if (!imported) {
      continue;
    }

    const sameImportedHole = (
      openingPoint: { x: number; y: number; z: number },
      axisDirection: { x: number; y: number; z: number }
    ): boolean =>
      existingHoleEdits.some((edit) => {
        if (edit.kind === 'resize-through-hole') {
          return false;
        }
        const scale = Math.max(
          1,
          Math.hypot(openingPoint.x, openingPoint.y, openingPoint.z)
        );
        const pointTolerance = scale * 1e-8;
        const pointDistance = Math.hypot(
          openingPoint.x - edit.sourceOpeningPoint.x,
          openingPoint.y - edit.sourceOpeningPoint.y,
          openingPoint.z - edit.sourceOpeningPoint.z
        );
        const alignment = Math.abs(
          axisDirection.x * edit.sourceAxisDirection.x +
            axisDirection.y * edit.sourceAxisDirection.y +
            axisDirection.z * edit.sourceAxisDirection.z
        );
        return pointDistance <= pointTolerance && alignment >= 1 - 1e-8;
      });
    const recognizedFeatures = body.topology.recognizedImportedFeatures ?? [];
    const claimedFaceHashes = new Set(
      recognizedFeatures
        .filter((recognized) =>
          ['blind-cylindrical-hole', 'counterbore', 'countersink'].includes(
            recognized.kind
          )
        )
        .flatMap((recognized) => recognized.participatingFaceHashes)
    );
    let holeIndex = 0;
    for (const recognized of recognizedFeatures) {
      if (
        recognized.kind !== 'blind-cylindrical-hole' &&
        recognized.kind !== 'counterbore' &&
        recognized.kind !== 'countersink'
      ) {
        continue;
      }
      holeIndex += 1;
      const recognizedIndex = holeIndex;
      const reference = recognized.seedFaceReference;
      if (
        !reference ||
        reference.currentHash !== recognized.seedFaceHash ||
        sameImportedHole(recognized.openingPoint, recognized.axisDirection)
      ) {
        continue;
      }
      const nameBase = [body.name, 'hole', String(recognizedIndex)];
      if (recognized.kind === 'blind-cylindrical-hole') {
        candidates.push({
          parameters: [
            {
              key: 'diameter',
              baseName: parameterBase(...nameBase, 'diameter'),
              expression: String(recognized.diameter)
            },
            {
              key: 'depth',
              baseName: parameterBase(...nameBase, 'depth'),
              expression: String(recognized.depth)
            }
          ],
          imported: true,
          bind: (parameterNames) => ({
            kind: 'add_direct_edit',
            name: `Parameterize ${body.name} hole ${recognizedIndex}`,
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-imported-blind-hole',
              faceHash: recognized.seedFaceHash,
              faceReference: reference,
              sourceOpeningPoint: recognized.openingPoint,
              sourceAxisDirection: recognized.axisDirection,
              sourceDiameter: recognized.diameter,
              sourceDepth: recognized.depth,
              diameter: parameterNames.get('diameter')!,
              depth: parameterNames.get('depth')!,
              parameterBinding: true
            }
          })
        });
      } else if (recognized.kind === 'counterbore') {
        candidates.push({
          parameters: [
            {
              key: 'boreDiameter',
              baseName: parameterBase(...nameBase, 'bore', 'diameter'),
              expression: String(recognized.boreDiameter)
            },
            {
              key: 'counterboreDiameter',
              baseName: parameterBase(...nameBase, 'counterbore', 'diameter'),
              expression: String(recognized.counterboreDiameter)
            },
            {
              key: 'counterboreDepth',
              baseName: parameterBase(...nameBase, 'counterbore', 'depth'),
              expression: String(recognized.counterboreDepth)
            }
          ],
          imported: true,
          bind: (parameterNames) => ({
            kind: 'add_direct_edit',
            name: `Parameterize ${body.name} hole ${recognizedIndex}`,
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-imported-counterbore',
              faceHash: recognized.seedFaceHash,
              faceReference: reference,
              sourceOpeningPoint: recognized.openingPoint,
              sourceAxisDirection: recognized.axisDirection,
              sourceBoreDiameter: recognized.boreDiameter,
              sourceCounterboreDiameter: recognized.counterboreDiameter,
              sourceCounterboreDepth: recognized.counterboreDepth,
              sourceTotalDepth: recognized.totalDepth,
              sourceEntryChamfered: recognized.entryChamfered,
              boreDiameter: parameterNames.get('boreDiameter')!,
              counterboreDiameter: parameterNames.get('counterboreDiameter')!,
              counterboreDepth: parameterNames.get('counterboreDepth')!,
              parameterBinding: true
            }
          })
        });
      } else {
        candidates.push({
          parameters: [
            {
              key: 'boreDiameter',
              baseName: parameterBase(...nameBase, 'bore', 'diameter'),
              expression: String(recognized.boreDiameter)
            },
            {
              key: 'sinkDiameter',
              baseName: parameterBase(...nameBase, 'sink', 'diameter'),
              expression: String(recognized.sinkDiameter)
            },
            {
              key: 'angleRadians',
              baseName: parameterBase(...nameBase, 'sink', 'angle', 'radians'),
              expression: String(recognized.angleRadians)
            }
          ],
          imported: true,
          bind: (parameterNames) => ({
            kind: 'add_direct_edit',
            name: `Parameterize ${body.name} hole ${recognizedIndex}`,
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-imported-countersink',
              faceHash: recognized.seedFaceHash,
              faceReference: reference,
              sourceOpeningPoint: recognized.openingPoint,
              sourceAxisDirection: recognized.axisDirection,
              sourceBoreDiameter: recognized.boreDiameter,
              sourceSinkDiameter: recognized.sinkDiameter,
              sourceAngleRadians: recognized.angleRadians,
              sourceCountersinkDepth: recognized.countersinkDepth,
              sourceTotalDepth: recognized.totalDepth,
              boreDiameter: parameterNames.get('boreDiameter')!,
              sinkDiameter: parameterNames.get('sinkDiameter')!,
              angleRadians: parameterNames.get('angleRadians')!,
              parameterBinding: true
            }
          })
        });
      }
    }

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
        reference.currentHash !== face.hash ||
        claimedFaceHashes.has(face.hash)
      ) {
        continue;
      }
      if (
        existingHoleEdits.some(
          (edit) =>
            edit.kind === 'resize-through-hole' &&
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
        parameters: [
          {
            key: 'diameter',
            baseName: parameterBase(
              body.name,
              'hole',
              String(recognizedIndex),
              'diameter'
            ),
            expression: String(diameter)
          }
        ],
        imported: true,
        bind: (parameterNames) => ({
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
            diameter: parameterNames.get('diameter')!,
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

  const selected: ParameterCandidate[] = [];
  let selectedParameterCount = 0;
  for (const candidate of allCandidates) {
    if (
      selectedParameterCount + candidate.parameters.length >
      MAX_AUTO_PARAMETER_CANDIDATES
    ) {
      break;
    }
    selected.push(candidate);
    selectedParameterCount += candidate.parameters.length;
  }
  const usedNames = new Set(
    listParameters(document).map((parameter) => parameter.name)
  );
  const named = selected.map((candidate) => ({
    candidate,
    names: new Map(
      candidate.parameters.map((parameter) => [
        parameter.key,
        uniqueParameterName(parameter.baseName, usedNames)
      ])
    )
  }));
  const importedGroups = named.filter(({ candidate }) => candidate.imported);
  const importedCount = importedGroups.reduce(
    (count, { candidate }) => count + candidate.parameters.length,
    0
  );
  const assumptions = [
    'Every literal remains an independent parameter; equal numbers were not coupled without design-intent evidence.',
    'Exact preview must preserve the current body geometry before this proposal can be applied.'
  ];
  if (native.skippedRelational > 0) {
    assumptions.push(
      'Line and arc coordinates remain literal because independent bindings could open a closed profile without a constraint solver.'
    );
  }
  const allParameterCount = allCandidates.reduce(
    (count, candidate) => count + candidate.parameters.length,
    0
  );
  if (allParameterCount > selectedParameterCount) {
    assumptions.push(
      `${allParameterCount - selectedParameterCount} additional literal dimensions remain; run Auto-parameterize again after applying this bounded batch.`
    );
  }
  if (importedCount > 0) {
    assumptions.push(
      `${importedCount} imported hole dimension${importedCount === 1 ? '' : 's'} across ${importedGroups.length} kernel-proven feature${importedGroups.length === 1 ? '' : 's'} use grouped exact topology; unsupported imported features remain unchanged.`
    );
  }

  return {
    proposalId: `auto_parameterize_v2_${document.version}`,
    summary: `${selectedParameterCount} editable parameter${selectedParameterCount === 1 ? '' : 's'} will replace literal driving values without changing the current exact geometry.`,
    assumptions,
    operations: [
      ...named.flatMap(({ candidate, names }) =>
        candidate.parameters.map((parameter) => ({
          kind: 'set_parameter' as const,
          name: names.get(parameter.key)!,
          expression: parameter.expression
        }))
      ),
      ...named.map(({ candidate, names }) => candidate.bind(names))
    ],
    preserveGeometry: true
  };
}
