import { listFeaturesInOrder, listParameters } from '@openzcad/document-core';
import type {
  AxisId,
  BodyId,
  BooleanOperation,
  FeatureId,
  PatternKind,
  ParamValue,
  PrimitiveKind,
  ProjectDocument,
  RevolveAxis,
  SketchId,
  TopologySelection
} from '@openzcad/shared';

export type CadPatchOperation =
  | {
      kind: 'set_parameter';
      name: string;
      expression: string;
    }
  | {
      kind: 'set_feature_dimension';
      featureId: FeatureId;
      field: string;
      value: ParamValue;
    }
  | {
      kind: 'add_primitive';
      name: string;
      primitiveKind: PrimitiveKind;
      dimensions: {
        width: ParamValue | null;
        height: ParamValue | null;
        depth: ParamValue | null;
        radius: ParamValue | null;
        bottomRadius: ParamValue | null;
        topRadius: ParamValue | null;
        majorRadius: ParamValue | null;
        minorRadius: ParamValue | null;
      };
    }
  | {
      kind: 'delete_feature';
      featureId: FeatureId;
    }
  | {
      kind: 'rename_feature';
      featureId: FeatureId;
      name: string;
    }
  | {
      kind: 'add_extrude';
      name: string;
      sketchId: SketchId;
      distance: ParamValue;
    }
  | {
      kind: 'add_revolve';
      name: string;
      sketchId: SketchId;
      axis: RevolveAxis;
    }
  | {
      kind: 'add_boolean';
      name: string;
      operation: BooleanOperation;
      targetBodyIds: BodyId[];
    }
  | {
      kind: 'add_transform';
      name: string;
      targetBodyId: BodyId;
      translation: { x: ParamValue; y: ParamValue; z: ParamValue };
      rotationDeg: { x: ParamValue; y: ParamValue; z: ParamValue };
    }
  | {
      kind: 'add_edge_modifier';
      name: string;
      modifier: 'fillet' | 'chamfer';
      targetBodyId: BodyId;
      edgeHashes: number[];
      size: ParamValue;
    }
  | {
      kind: 'add_pattern';
      name: string;
      targetBodyId: BodyId;
      patternKind: PatternKind;
      count: ParamValue;
      axis: AxisId;
      spacing: ParamValue;
      angleDeg: ParamValue;
    };

export interface CadPatchProposal {
  proposalId: string;
  summary: string;
  assumptions: string[];
  operations: CadPatchOperation[];
}

export interface CadDocumentDigest {
  schemaVersion: number;
  projectId: string;
  name: string;
  units: string;
  version: number;
  parameters: Array<{ name: string; expression: string; value: number }>;
  features: Array<{
    featureId: string;
    name: string;
    featureKind: string;
    bodyId: string | null;
    data: unknown;
  }>;
  selection?: {
    bodyId: string | null;
    topology: {
      kind: TopologySelection['kind'];
      topologyId: string;
      hash: number | null;
    } | null;
  };
  warnings: string[];
}

function compactFeatureData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }
  const feature = data as Record<string, unknown>;
  if (feature.featureKind === 'imported-step') {
    return {
      featureKind: feature.featureKind,
      artifactId: feature.artifactId,
      sourceName: feature.sourceName,
      sourceBytes:
        typeof feature.stepText === 'string' ? feature.stepText.length : 0
    };
  }
  if (feature.featureKind === 'imported-mesh') {
    return {
      featureKind: feature.featureKind,
      artifactId: feature.artifactId,
      sourceName: feature.sourceName,
      triangleCount: feature.triangleCount
    };
  }
  return feature;
}

export function createCadDocumentDigest(
  document: ProjectDocument,
  selection?: TopologySelection | null
): CadDocumentDigest {
  return {
    schemaVersion: document.schemaVersion,
    projectId: document.projectId,
    name: document.name,
    units: document.units,
    version: document.version,
    parameters: listParameters(document).map((parameter) => ({
      name: parameter.name,
      expression: parameter.expression,
      value: parameter.value
    })),
    features: listFeaturesInOrder(document).map((feature) => ({
      featureId: feature.featureId,
      name: feature.name,
      featureKind: feature.featureKind,
      bodyId: feature.bodyId ?? null,
      data: compactFeatureData(feature.data)
    })),
    selection: {
      bodyId: selection?.bodyId ?? null,
      topology: selection
        ? {
            kind: selection.kind,
            topologyId:
              selection.topologyId ?? `body:${String(selection.bodyId)}`,
            hash: selection.hash ?? null
          }
        : null
    },
    warnings: document.derived.warnings
  };
}

const scalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }]
} as const;
const nullableScalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }]
} as const;
const vectorSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { x: scalarSchema, y: scalarSchema, z: scalarSchema },
  required: ['x', 'y', 'z']
} as const;

export const CAD_PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    proposalId: { type: 'string' },
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'set_parameter' },
              name: { type: 'string' },
              expression: { type: 'string' }
            },
            required: ['kind', 'name', 'expression']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'set_feature_dimension' },
              featureId: { type: 'string' },
              field: { type: 'string' },
              value: scalarSchema
            },
            required: ['kind', 'featureId', 'field', 'value']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_primitive' },
              name: { type: 'string' },
              primitiveKind: {
                type: 'string',
                enum: ['box', 'cylinder', 'sphere', 'cone', 'torus']
              },
              dimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: nullableScalarSchema,
                  height: nullableScalarSchema,
                  depth: nullableScalarSchema,
                  radius: nullableScalarSchema,
                  bottomRadius: nullableScalarSchema,
                  topRadius: nullableScalarSchema,
                  majorRadius: nullableScalarSchema,
                  minorRadius: nullableScalarSchema
                },
                required: [
                  'width',
                  'height',
                  'depth',
                  'radius',
                  'bottomRadius',
                  'topRadius',
                  'majorRadius',
                  'minorRadius'
                ]
              }
            },
            required: ['kind', 'name', 'primitiveKind', 'dimensions']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'delete_feature' },
              featureId: { type: 'string' }
            },
            required: ['kind', 'featureId']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'rename_feature' },
              featureId: { type: 'string' },
              name: { type: 'string' }
            },
            required: ['kind', 'featureId', 'name']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_extrude' },
              name: { type: 'string' },
              sketchId: { type: 'string' },
              distance: scalarSchema
            },
            required: ['kind', 'name', 'sketchId', 'distance']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_revolve' },
              name: { type: 'string' },
              sketchId: { type: 'string' },
              axis: { type: 'string', enum: ['horizontal', 'vertical'] }
            },
            required: ['kind', 'name', 'sketchId', 'axis']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_boolean' },
              name: { type: 'string' },
              operation: {
                type: 'string',
                enum: ['union', 'subtract', 'intersect']
              },
              targetBodyIds: {
                type: 'array',
                minItems: 2,
                maxItems: 12,
                items: { type: 'string' }
              }
            },
            required: ['kind', 'name', 'operation', 'targetBodyIds']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_transform' },
              name: { type: 'string' },
              targetBodyId: { type: 'string' },
              translation: vectorSchema,
              rotationDeg: vectorSchema
            },
            required: [
              'kind',
              'name',
              'targetBodyId',
              'translation',
              'rotationDeg'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_edge_modifier' },
              name: { type: 'string' },
              modifier: { type: 'string', enum: ['fillet', 'chamfer'] },
              targetBodyId: { type: 'string' },
              edgeHashes: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: { type: 'integer', minimum: 1 }
              },
              size: scalarSchema
            },
            required: [
              'kind',
              'name',
              'modifier',
              'targetBodyId',
              'edgeHashes',
              'size'
            ]
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', const: 'add_pattern' },
              name: { type: 'string' },
              targetBodyId: { type: 'string' },
              patternKind: { type: 'string', enum: ['linear', 'circular'] },
              count: scalarSchema,
              axis: { type: 'string', enum: ['x', 'y', 'z'] },
              spacing: scalarSchema,
              angleDeg: scalarSchema
            },
            required: [
              'kind',
              'name',
              'targetBodyId',
              'patternKind',
              'count',
              'axis',
              'spacing',
              'angleDeg'
            ]
          }
        ]
      }
    }
  },
  required: ['proposalId', 'summary', 'assumptions', 'operations']
} as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('CAD patch proposal must be an object.');
  }
  return value as Record<string, unknown>;
}

function isScalar(value: unknown): value is ParamValue {
  return typeof value === 'string' || typeof value === 'number';
}

function isVector(value: unknown): boolean {
  const vector = record(value);
  return isScalar(vector.x) && isScalar(vector.y) && isScalar(vector.z);
}

export function parseCadPatchProposal(value: unknown): CadPatchProposal {
  const candidate = record(value);
  if (
    typeof candidate.proposalId !== 'string' ||
    typeof candidate.summary !== 'string' ||
    !Array.isArray(candidate.assumptions) ||
    !candidate.assumptions.every((item) => typeof item === 'string') ||
    !Array.isArray(candidate.operations) ||
    candidate.operations.length === 0 ||
    candidate.operations.length > 20
  ) {
    throw new Error('CAD patch proposal is missing required fields.');
  }

  for (const rawOperation of candidate.operations) {
    const operation = record(rawOperation);
    switch (operation.kind) {
      case 'set_parameter':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.expression !== 'string'
        ) {
          throw new Error('Invalid set_parameter operation.');
        }
        break;
      case 'set_feature_dimension':
        if (
          typeof operation.featureId !== 'string' ||
          typeof operation.field !== 'string' ||
          (typeof operation.value !== 'string' &&
            typeof operation.value !== 'number')
        ) {
          throw new Error('Invalid set_feature_dimension operation.');
        }
        break;
      case 'add_primitive':
        if (
          typeof operation.name !== 'string' ||
          !['box', 'cylinder', 'sphere', 'cone', 'torus'].includes(
            String(operation.primitiveKind)
          ) ||
          !operation.dimensions ||
          typeof operation.dimensions !== 'object'
        ) {
          throw new Error('Invalid add_primitive operation.');
        }
        break;
      case 'delete_feature':
        if (typeof operation.featureId !== 'string') {
          throw new Error('Invalid delete_feature operation.');
        }
        break;
      case 'rename_feature':
        if (
          typeof operation.featureId !== 'string' ||
          typeof operation.name !== 'string'
        ) {
          throw new Error('Invalid rename_feature operation.');
        }
        break;
      case 'add_extrude':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !isScalar(operation.distance)
        ) {
          throw new Error('Invalid add_extrude operation.');
        }
        break;
      case 'add_revolve':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.sketchId !== 'string' ||
          !['horizontal', 'vertical'].includes(String(operation.axis))
        ) {
          throw new Error('Invalid add_revolve operation.');
        }
        break;
      case 'add_boolean':
        if (
          typeof operation.name !== 'string' ||
          !['union', 'subtract', 'intersect'].includes(
            String(operation.operation)
          ) ||
          !Array.isArray(operation.targetBodyIds) ||
          operation.targetBodyIds.length < 2 ||
          !operation.targetBodyIds.every((id) => typeof id === 'string')
        ) {
          throw new Error('Invalid add_boolean operation.');
        }
        break;
      case 'add_transform':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !isVector(operation.translation) ||
          !isVector(operation.rotationDeg)
        ) {
          throw new Error('Invalid add_transform operation.');
        }
        break;
      case 'add_edge_modifier':
        if (
          typeof operation.name !== 'string' ||
          !['fillet', 'chamfer'].includes(String(operation.modifier)) ||
          typeof operation.targetBodyId !== 'string' ||
          !Array.isArray(operation.edgeHashes) ||
          operation.edgeHashes.length === 0 ||
          !operation.edgeHashes.every(
            (hash) => Number.isInteger(hash) && Number(hash) > 0
          ) ||
          !isScalar(operation.size)
        ) {
          throw new Error('Invalid add_edge_modifier operation.');
        }
        break;
      case 'add_pattern':
        if (
          typeof operation.name !== 'string' ||
          typeof operation.targetBodyId !== 'string' ||
          !['linear', 'circular'].includes(String(operation.patternKind)) ||
          !['x', 'y', 'z'].includes(String(operation.axis)) ||
          !isScalar(operation.count) ||
          !isScalar(operation.spacing) ||
          !isScalar(operation.angleDeg)
        ) {
          throw new Error('Invalid add_pattern operation.');
        }
        break;
      default:
        throw new Error(
          `Unsupported CAD patch operation: ${String(operation.kind)}.`
        );
    }
  }

  return candidate as unknown as CadPatchProposal;
}
