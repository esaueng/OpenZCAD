import { listFeaturesInOrder, listParameters } from '@openzcad/document-core';
import type {
  DocumentNode,
  FeatureNode,
  ProjectDocument,
  SketchNode
} from '@openzcad/shared';
import {
  detachedSketches,
  expressionSitesOf,
  hashesOfReferences,
  HISTORY_TEXT_VERSION,
  isTopologyReference,
  REFERENCE_HASH_PAIRS,
  sameHashes,
  type ExpressionSites
} from './model';
import { ID_PATTERN } from './syntax';

const LINE_WIDTH = 80;
const INDENT = '  ';
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SKETCH_BOOKKEEPING = new Set([
  'kind',
  'id',
  'parentId',
  'revisionId',
  'sketchId',
  'objectIds',
  'name'
]);

interface PrintContext {
  /** Every id the document defines, printed as `#id` where a string names one. */
  ids: ReadonlySet<string>;
  sites: ExpressionSites;
}

function printNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`A stored number is not finite (${value}).`);
  }
  return Object.is(value, -0) ? '-0' : String(value);
}

function printKey(key: string): string {
  return BARE_KEY.test(key.startsWith('@') ? key.slice(1) : key)
    ? key
    : JSON.stringify(key);
}

function printExpression(value: string): string {
  return value.includes('`') || value.includes('\n')
    ? `expr(${JSON.stringify(value)})`
    : `\`${value}\``;
}

function printString(value: string, context: PrintContext): string {
  return context.ids.has(value) && ID_PATTERN.test(value)
    ? `#${value}`
    : JSON.stringify(value);
}

/** Record entries to print: drops `undefined` and hash fields its references imply. */
function printableEntries(
  record: Record<string, unknown>,
  skip?: ReadonlySet<string>
): [string, unknown][] {
  const elided = new Set<string>();
  for (const [referenceKey, hashKey] of Object.entries(REFERENCE_HASH_PAIRS)) {
    if (!(referenceKey in record) || !(hashKey in record)) continue;
    const implied = hashesOfReferences(record[referenceKey]);
    if (implied !== undefined && sameHashes(implied, record[hashKey])) {
      elided.add(hashKey);
    }
  }
  return Object.entries(record).filter(
    ([key, value]) => value !== undefined && !elided.has(key) && !skip?.has(key)
  );
}

/** One value on one line, or `null` when it holds a node literal. */
function inline(
  value: unknown,
  context: PrintContext,
  container?: object,
  key?: string
): string {
  if (
    container &&
    key !== undefined &&
    context.sites.get(container)?.has(key)
  ) {
    if (typeof value === 'string') return printExpression(value);
  }
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return printNumber(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return printString(value, context);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value
      .map((item, index) => inline(item, context, value, String(index)))
      .join(', ')}]`;
  }
  if (isTopologyReference(value)) {
    return `${value.kind}(#${value.producingFeatureId}, ${JSON.stringify(value.lineageName)})`;
  }
  const entries = printableEntries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{ ${entries
    .map(
      ([entryKey, entryValue]) =>
        `${printKey(entryKey)}: ${inline(entryValue, context, value, entryKey)}`
    )
    .join(', ')} }`;
}

function block(
  value: unknown,
  context: PrintContext,
  indent: string,
  container?: object,
  key?: string,
  prefix = 0
): string {
  const single = inline(value, context, container, key);
  if (indent.length + prefix + single.length + 1 <= LINE_WIDTH) return single;
  if (Array.isArray(value)) {
    const inner = indent + INDENT;
    return `[\n${value
      .map(
        (item, index) =>
          `${inner}${block(item, context, inner, value, String(index))},\n`
      )
      .join('')}${indent}]`;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !isTopologyReference(value)
  ) {
    return printRecord(
      printableEntries(value as Record<string, unknown>),
      context,
      indent,
      value
    );
  }
  return single;
}

function printRecord(
  entries: [string, unknown][],
  context: PrintContext,
  indent: string,
  container: object | undefined,
  extra: string[] = []
): string {
  if (entries.length === 0 && extra.length === 0) return '{}';
  const inner = indent + INDENT;
  const lines = entries.map(
    ([key, value]) =>
      `${inner}${printKey(key)}: ${block(value, context, inner, container, key, printKey(key).length + 2)},`
  );
  return `{\n${[...lines, ...extra.map((line) => `${inner}${line}`)].join('\n')}\n${indent}}`;
}

function collectIds(document: ProjectDocument): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(document.nodes)) {
    switch (node.kind) {
      case 'feature':
        ids.add(node.featureId);
        if (node.bodyId) ids.add(node.bodyId);
        break;
      case 'body':
        ids.add(node.bodyId);
        break;
      case 'sketch':
        ids.add(node.sketchId);
        break;
      case 'sketch-object':
        ids.add(node.id);
        break;
      case 'parameter':
        ids.add(node.parameterId);
        break;
      default:
        break;
    }
  }
  return ids;
}

function withSites<T extends DocumentNode>(
  node: T
): { copy: T; sites: ExpressionSites } {
  const copy = structuredClone(node);
  return { copy, sites: expressionSitesOf(copy) };
}

function metadataLine(
  metadata: Record<string, unknown> | undefined,
  context: PrintContext,
  indent: string
): string[] {
  if (!metadata) return [];
  return [
    `@metadata: ${block(metadata, context, indent + INDENT, undefined, undefined, 11)},`
  ];
}

function printSketchExtras(
  document: ProjectDocument,
  feature: FeatureNode,
  ids: ReadonlySet<string>,
  indent: string
): string[] {
  if (feature.data.featureKind !== 'sketch') return [];
  const sketchId = feature.data.sketchId;
  const sketch = Object.values(document.nodes).find(
    (node): node is SketchNode =>
      node.kind === 'sketch' && node.sketchId === sketchId
  );
  if (!sketch) return [];
  const inner = indent + INDENT;
  const { copy, sites } = withSites(sketch);
  const context: PrintContext = { ids, sites };
  const fields = printableEntries(
    copy as unknown as Record<string, unknown>,
    SKETCH_BOOKKEEPING
  );
  if (copy.name !== feature.name) fields.unshift(['name', copy.name]);
  const lines = [`@sketch: ${printRecord(fields, context, inner, copy)},`];
  const objects: string[] = [];
  for (const objectId of sketch.objectIds) {
    const node = document.nodes[objectId];
    if (!node || node.kind !== 'sketch-object') continue;
    const object = withSites(node);
    const objectContext: PrintContext = { ids, sites: object.sites };
    const skip = new Set(
      object.copy.data.objectKind === node.objectKind ? ['objectKind'] : []
    );
    const objectIndent = inner + INDENT;
    objects.push(
      `${objectIndent}${node.objectKind} #${node.id} ${JSON.stringify(node.name)} ${printRecord(
        printableEntries(object.copy.data, skip),
        objectContext,
        objectIndent,
        object.copy.data,
        metadataLine(node.metadata, objectContext, objectIndent)
      )},`
    );
  }
  lines.push(
    objects.length === 0
      ? '@objects: [],'
      : `@objects: [\n${objects.join('\n')}\n${inner}],`
  );
  return lines;
}

function printFeature(
  document: ProjectDocument,
  feature: FeatureNode,
  ids: ReadonlySet<string>
): string {
  const { copy, sites } = withSites(feature);
  const context: PrintContext = { ids, sites };
  const head = `${feature.featureKind} #${feature.featureId} ${JSON.stringify(feature.name)}${
    feature.bodyId !== undefined ? ` -> #${feature.bodyId}` : ''
  }`;
  const entries = printableEntries(
    copy.data,
    new Set(
      copy.data.featureKind === feature.featureKind ? ['featureKind'] : []
    )
  );
  const extra = [
    ...metadataLine(feature.metadata, context, ''),
    ...printSketchExtras(document, feature, ids, '')
  ];
  return `${head} ${printRecord(entries, context, '', copy.data, extra)}`;
}

function printParameters(
  document: ProjectDocument,
  ids: ReadonlySet<string>
): string[] {
  return listParameters(document).map((parameter) => {
    const context: PrintContext = { ids, sites: new Map() };
    const extra: [string, unknown][] = [];
    if (parameter.toggle) extra.push(['toggle', parameter.toggle]);
    if (parameter.exposed !== undefined)
      extra.push(['exposed', parameter.exposed]);
    if (parameter.description !== undefined) {
      extra.push(['description', parameter.description]);
    }
    if (parameter.metadata) extra.push(['@metadata', parameter.metadata]);
    const head = `param #${parameter.parameterId} ${parameter.name}${
      parameter.quantity ? `: ${parameter.quantity}` : ''
    } = ${printExpression(parameter.expression)}`;
    if (extra.length === 0) return head;
    const single = `${head} ${inline(Object.fromEntries(extra), context)}`;
    return single.length <= LINE_WIDTH
      ? single
      : `${head} ${printRecord(extra, context, '', undefined)}`;
  });
}

/**
 * The document's feature history as text: parameters, then every feature in
 * history order, each sketch with its objects. Pure and deterministic; the
 * same document always prints the same text.
 */
export function printHistory(document: ProjectDocument): string {
  const ids = collectIds(document);
  const sections: string[] = [
    `openzcad history ${HISTORY_TEXT_VERSION}\nunits ${document.units}`
  ];
  const parameters = printParameters(document, ids);
  if (parameters.length > 0) sections.push(parameters.join('\n'));
  for (const feature of listFeaturesInOrder(document)) {
    sections.push(printFeature(document, feature, ids));
  }
  const detached = detachedSketches(document);
  if (detached.length > 0) {
    sections.push(
      detached
        .map(
          (sketch) =>
            `// Sketch #${sketch.sketchId} ${JSON.stringify(sketch.name)} belongs to no feature and is not part of the history.`
        )
        .join('\n')
    );
  }
  return `${sections.join('\n\n')}\n`;
}
