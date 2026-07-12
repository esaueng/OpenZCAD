import { listFeaturesInOrder, listParameters } from '@openzcad/document-core';
import type {
  FeatureId,
  ParamValue,
  PrimitiveKind,
  ProjectDocument
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
  warnings: string[];
}

export function createCadDocumentDigest(
  document: ProjectDocument
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
      data: feature.data
    })),
    warnings: document.derived.warnings
  };
}

const scalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }]
} as const;
const nullableScalarSchema = {
  anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }]
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
              kind: { const: 'set_parameter' },
              name: { type: 'string' },
              expression: { type: 'string' }
            },
            required: ['kind', 'name', 'expression']
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { const: 'set_feature_dimension' },
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
              kind: { const: 'add_primitive' },
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
              kind: { const: 'delete_feature' },
              featureId: { type: 'string' }
            },
            required: ['kind', 'featureId']
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
      default:
        throw new Error(
          `Unsupported CAD patch operation: ${String(operation.kind)}.`
        );
    }
  }

  return candidate as unknown as CadPatchProposal;
}
