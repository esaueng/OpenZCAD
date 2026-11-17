import {
  listFeaturesInOrder,
  listParameters,
  rewriteNodeExpressions,
  type ExpressionFieldDimension
} from '@openzcad/document-core';
import type {
  DocumentNode,
  FeatureData,
  FeatureKind,
  FeatureNode,
  ParameterKind,
  PrimitiveKind,
  ProjectDocument,
  SketchNode,
  SketchObjectData,
  SketchObjectKind,
  TopologyReferenceV5
} from '@openzcad/shared';

/** The history text language version this module reads and prints. */
export const HISTORY_TEXT_VERSION = 1;

/**
 * Every feature kind the text can name. Typed against `FeatureKind`, so a new
 * kind fails to compile here until the text learns it.
 */
export const HISTORY_FEATURE_KINDS = {
  primitive: true,
  sketch: true,
  extrude: true,
  revolve: true,
  loft: true,
  sweep: true,
  'helical-sweep': true,
  boolean: true,
  transform: true,
  mirror: true,
  shell: true,
  'solid-offset': true,
  draft: true,
  thicken: true,
  fillet: true,
  chamfer: true,
  pattern: true,
  split: true,
  hole: true,
  gear: true,
  thread: true,
  'sheet-metal': true,
  'standard-part': true,
  'direct-edit': true,
  'imported-step': true,
  'imported-mesh': true,
  'datum-plane': true,
  'datum-axis': true
} as const satisfies Record<FeatureKind, true>;

export const HISTORY_SKETCH_OBJECT_KINDS = {
  rectangle: true,
  circle: true,
  polygon: true,
  line: true,
  arc: true,
  ellipse: true,
  spline: true,
  text: true,
  point: true
} as const satisfies Record<SketchObjectKind, true>;

export const HISTORY_PRIMITIVE_KINDS = {
  box: true,
  cylinder: true,
  sphere: true,
  cone: true,
  torus: true
} as const satisfies Record<PrimitiveKind, true>;

/** The dimensions a primitive may hold (`PrimitiveInput`'s fields). */
export const HISTORY_PRIMITIVE_DIMENSIONS = [
  'width',
  'height',
  'depth',
  'radius',
  'bottomRadius',
  'topRadius',
  'majorRadius',
  'minorRadius'
] as const;

export const HISTORY_PARAMETER_QUANTITIES = {
  length: true,
  angle: true,
  number: true
} as const satisfies Record<ParameterKind, true>;

export function isHistoryFeatureKind(value: string): value is FeatureKind {
  return Object.hasOwn(HISTORY_FEATURE_KINDS, value);
}

export function isHistorySketchObjectKind(
  value: string
): value is SketchObjectKind {
  return Object.hasOwn(HISTORY_SKETCH_OBJECT_KINDS, value);
}

/** Parameter fields beside its expression, as stored. */
export interface HistoryParameterExtra {
  toggle?: ParameterNodeToggle;
  exposed?: boolean;
  description?: string;
  metadata?: Record<string, string | number | boolean>;
}

type ParameterNodeToggle = NonNullable<
  Extract<DocumentNode, { kind: 'parameter' }>['toggle']
>;

export interface HistoryParameter {
  id: string;
  name: string;
  quantity?: ParameterKind;
  expression: string;
  extra: HistoryParameterExtra;
}

export interface HistorySketchObject {
  id: string;
  name: string;
  objectKind: SketchObjectKind;
  data: SketchObjectData;
  metadata?: Record<string, string | number | boolean>;
}

/** A sketch node's own fields, without bookkeeping and its object list. */
export type HistorySketchFields = Omit<
  SketchNode,
  'kind' | 'id' | 'parentId' | 'revisionId' | 'sketchId' | 'objectIds' | 'name'
> & { name?: string };

export interface HistoryFeature {
  featureId: string;
  featureKind: FeatureKind;
  name: string;
  bodyId?: string;
  data: FeatureData;
  metadata?: Record<string, string | number | boolean>;
  /** Sketch features only: the sketch they own and its objects in order. */
  sketch?: HistorySketchFields;
  objects?: HistorySketchObject[];
}

/** The content of a history text: what the document's history says. */
export interface HistoryModel {
  version: number;
  units: string;
  parameters: HistoryParameter[];
  features: HistoryFeature[];
}

const SKETCH_BOOKKEEPING = new Set([
  'kind',
  'id',
  'parentId',
  'revisionId',
  'sketchId',
  'objectIds',
  'name'
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sketchById(
  document: ProjectDocument,
  sketchId: string
): SketchNode | undefined {
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'sketch' && node.sketchId === sketchId) return node;
  }
  return undefined;
}

export function sketchFieldsOf(
  sketch: SketchNode,
  featureName: string
): HistorySketchFields {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sketch)) {
    if (SKETCH_BOOKKEEPING.has(key) || value === undefined) continue;
    fields[key] = clone(value);
  }
  if (sketch.name !== featureName) fields.name = sketch.name;
  return fields as HistorySketchFields;
}

export function sketchObjectsOf(
  document: ProjectDocument,
  sketch: SketchNode
): HistorySketchObject[] {
  const objects: HistorySketchObject[] = [];
  for (const objectId of sketch.objectIds) {
    const node = document.nodes[objectId];
    if (!node || node.kind !== 'sketch-object') continue;
    objects.push({
      id: node.id,
      name: node.name,
      objectKind: node.objectKind,
      data: clone(node.data),
      ...(node.metadata ? { metadata: clone(node.metadata) } : {})
    });
  }
  return objects;
}

/** Sketches that no feature owns: outside the history, and not printed. */
export function detachedSketches(document: ProjectDocument): SketchNode[] {
  const owned = new Set<string>();
  for (const feature of listFeaturesInOrder(document)) {
    if (feature.data.featureKind === 'sketch') owned.add(feature.data.sketchId);
  }
  return Object.values(document.nodes).filter(
    (node): node is SketchNode =>
      node.kind === 'sketch' && !owned.has(node.sketchId)
  );
}

export function historyFeatureOf(
  document: ProjectDocument,
  feature: FeatureNode
): HistoryFeature {
  const result: HistoryFeature = {
    featureId: feature.featureId,
    featureKind: feature.featureKind,
    name: feature.name,
    ...(feature.bodyId !== undefined ? { bodyId: feature.bodyId } : {}),
    data: clone(feature.data),
    ...(feature.metadata ? { metadata: clone(feature.metadata) } : {})
  };
  if (feature.data.featureKind === 'sketch') {
    const sketch = sketchById(document, feature.data.sketchId);
    if (sketch) {
      result.sketch = sketchFieldsOf(sketch, feature.name);
      result.objects = sketchObjectsOf(document, sketch);
    }
  }
  return result;
}

/** The document's history as the text form models it. */
export function historyModelOf(document: ProjectDocument): HistoryModel {
  return {
    version: HISTORY_TEXT_VERSION,
    units: document.units,
    parameters: listParameters(document).map((parameter) => ({
      id: parameter.parameterId,
      name: parameter.name,
      ...(parameter.quantity ? { quantity: parameter.quantity } : {}),
      expression: parameter.expression,
      extra: {
        ...(parameter.toggle ? { toggle: clone(parameter.toggle) } : {}),
        ...(parameter.exposed !== undefined
          ? { exposed: parameter.exposed }
          : {}),
        ...(parameter.description !== undefined
          ? { description: parameter.description }
          : {}),
        ...(parameter.metadata ? { metadata: clone(parameter.metadata) } : {})
      }
    })),
    features: listFeaturesInOrder(document).map((feature) =>
      historyFeatureOf(document, feature)
    )
  };
}

/** Where F05 reads an expression: the holding object, its key, its quantity. */
export type ExpressionSites = Map<
  object,
  Map<string, ExpressionFieldDimension>
>;

/**
 * The authored expression fields of a node, keyed by the object that holds
 * them. Uses document-core's own walker, so the text and the evaluator agree
 * on which strings are expressions.
 */
export function expressionSitesOf(node: DocumentNode): ExpressionSites {
  const sites: ExpressionSites = new Map();
  rewriteNodeExpressions(node, (expression, dimension, site) => {
    let keys = sites.get(site.container);
    if (!keys)
      sites.set(
        site.container,
        (keys = new Map<string, ExpressionFieldDimension>())
      );
    keys.set(site.key, dimension);
    return expression;
  });
  return sites;
}

/** Whether a value is a stored V5 topology reference. */
export function isTopologyReference(
  value: unknown
): value is TopologyReferenceV5 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'face' || record.kind === 'edge') &&
    typeof record.producingFeatureId === 'string' &&
    typeof record.lineageName === 'string' &&
    typeof record.currentHash === 'number' &&
    record.witnessVersion === 1 &&
    typeof record.witness === 'object' &&
    record.witness !== null
  );
}

/**
 * Stored pick pairs: a hash field and the V5 references that name the same
 * entities. The text prints the references and leaves the hashes out when
 * they agree, so a pick reads as lineage rather than as a number.
 */
export const REFERENCE_HASH_PAIRS: Readonly<Record<string, string>> = {
  edgeReferences: 'edgeHashes',
  faceReferences: 'faceHashes',
  openingFaceReferences: 'openingFaceHashes',
  faceReference: 'faceHash',
  faceAReference: 'faceAHash',
  faceBReference: 'faceBHash',
  oppositeFaceReference: 'oppositeFaceHash',
  seedFaceReference: 'seedFaceHash'
};

/** The hashes a reference field implies, or `undefined` when it is not one. */
export function hashesOfReferences(
  value: unknown
): number | number[] | undefined {
  if (isTopologyReference(value)) return value.currentHash;
  if (Array.isArray(value) && value.every(isTopologyReference)) {
    return value.map((reference) => reference.currentHash);
  }
  return undefined;
}

export function sameHashes(left: unknown, right: unknown): boolean {
  // Object.is: a stored -0 is not implied by a reference's 0.
  if (typeof left === 'number' || typeof right === 'number') {
    return Object.is(left, right);
  }
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
