import {
  evaluateExpression,
  evaluateFieldExpression,
  findFeature,
  getParameterScope,
  listParameters,
  type ExpressionFieldDimension
} from '@openzcad/document-core';
import type {
  DocumentNode,
  FeatureData,
  FeatureId,
  FeatureNode,
  ParameterKind,
  ProjectDocument,
  SketchNode,
  SketchObjectData,
  TopologyReferenceV5
} from '@openzcad/shared';
import {
  expressionSitesOf,
  hashesOfReferences,
  HISTORY_TEXT_VERSION,
  HISTORY_PRIMITIVE_DIMENSIONS,
  HISTORY_PRIMITIVE_KINDS,
  isHistoryFeatureKind,
  isHistorySketchObjectKind,
  isTopologyReference,
  REFERENCE_HASH_PAIRS,
  HISTORY_PARAMETER_QUANTITIES,
  type HistoryFeature,
  type HistoryModel,
  type HistoryParameter,
  type HistorySketchFields,
  type HistorySketchObject
} from './model';
import { compileScript } from './script';
import {
  HistoryTextSyntaxError,
  parseHistoryText,
  type FeatureStatement,
  type HistoryTextDiagnostic,
  type ObjectNode,
  type ParameterStatement,
  type RecordNode,
  type ReferenceNode,
  type TextSpan,
  type ValueNode
} from './syntax';

export interface HistoryTextReadResult {
  /** The text's content, or `null` when it does not parse. */
  model: HistoryModel | null;
  /** Where each statement and sketch object is, by its id. */
  spans: ReadonlyMap<string, TextSpan>;
  /** Errors block an edit; warnings describe what the document already holds. */
  diagnostics: HistoryTextDiagnostic[];
}

type Path = (string | number)[];

/** A converted record or list, with the syntax node each member came from. */
type SourceMap = WeakMap<object, Map<string, ValueNode>>;

interface PendingReference {
  container: Record<string, unknown> | unknown[];
  key: string | number;
  node: ReferenceNode;
  path: Path;
}

interface Conversion {
  sources: SourceMap;
  references: PendingReference[];
  /** Expression literals, so a literal outside an expression field is caught. */
  expressions: { container: object; key: string; node: ValueNode }[];
  ids: { value: string; span: TextSpan }[];
}

const STATEMENT_KEYS = new Set(['@metadata', '@sketch', '@objects']);

function convert(
  node: ValueNode,
  path: Path,
  conversion: Conversion,
  container?: object,
  key?: string
): unknown {
  switch (node.type) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'expression':
      if (container && key !== undefined) {
        conversion.expressions.push({ container, key, node });
      }
      return node.value;
    case 'id':
      conversion.ids.push({ value: node.value, span: node.span });
      return node.value;
    case 'list': {
      const list: unknown[] = [];
      const sources = new Map<string, ValueNode>();
      conversion.sources.set(list, sources);
      node.items.forEach((item, index) => {
        sources.set(String(index), item);
        if (item.type === 'reference') {
          conversion.references.push({
            container: list,
            key: index,
            node: item,
            path: [...path, index]
          });
          list.push(null);
        } else {
          list.push(
            convert(item, [...path, index], conversion, list, String(index))
          );
        }
      });
      return list;
    }
    case 'record':
      return convertRecord(node, path, conversion);
    case 'reference':
      // Reached only for a reference outside a record or list.
      return null;
    case 'node':
      return convertRecord(node.body, path, conversion);
    default:
      node satisfies never;
      return null;
  }
}

function convertRecord(
  node: RecordNode,
  path: Path,
  conversion: Conversion,
  skip?: ReadonlySet<string>
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  const sources = new Map<string, ValueNode>();
  conversion.sources.set(record, sources);
  for (const entry of node.entries) {
    if (skip?.has(entry.key)) continue;
    sources.set(entry.key, entry.value);
    if (entry.value.type === 'reference') {
      conversion.references.push({
        container: record,
        key: entry.key,
        node: entry.value,
        path: [...path, entry.key]
      });
      record[entry.key] = null;
    } else {
      record[entry.key] = convert(
        entry.value,
        [...path, entry.key],
        conversion,
        record,
        entry.key
      );
    }
  }
  return record;
}

type ValueKind = 'number' | 'string' | 'boolean' | 'null' | 'list' | 'record';

function textValueKind(node: ValueNode): ValueKind {
  switch (node.type) {
    case 'number':
      return 'number';
    case 'string':
    case 'expression':
    case 'id':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'list':
      return 'list';
    default:
      return 'record';
  }
}

function storedValueKind(value: unknown): ValueKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    default:
      return 'record';
  }
}

function article(kind: ValueKind): string {
  return {
    number: 'a number',
    string: 'text',
    boolean: 'true or false',
    null: 'null',
    list: 'a list',
    record: 'a record'
  }[kind];
}

function plural(kind: ValueKind): string {
  return {
    number: 'numbers',
    string: 'text values',
    boolean: 'true or false values',
    null: 'nulls',
    list: 'lists',
    record: 'records'
  }[kind];
}

function valueAt(root: unknown, path: Path): unknown {
  let value = root;
  for (const step of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string | number, unknown>)[step];
  }
  return value;
}

function entryOf(record: RecordNode, key: string) {
  return record.entries.find((entry) => entry.key === key);
}

/** Every V5 reference the document stores, by kind, producer and lineage. */
function storedReferences(
  document: ProjectDocument
): Map<string, TopologyReferenceV5[]> {
  const index = new Map<string, TopologyReferenceV5[]>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (isTopologyReference(value)) {
      const key = referenceKey(
        value.kind,
        value.producingFeatureId,
        value.lineageName
      );
      const list = index.get(key) ?? [];
      if (
        !list.some((stored) => JSON.stringify(stored) === JSON.stringify(value))
      ) {
        list.push(value);
      }
      index.set(key, list);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const node of Object.values(document.nodes)) {
    if (
      node.kind === 'feature' ||
      node.kind === 'sketch' ||
      node.kind === 'sketch-object'
    ) {
      visit(node);
    }
  }
  return index;
}

function referenceKey(kind: string, feature: string, lineage: string): string {
  return `${kind}\u0000${feature}\u0000${lineage}`;
}

class Reader {
  readonly diagnostics: HistoryTextDiagnostic[] = [];
  readonly spans = new Map<string, TextSpan>();
  private readonly knownIds = new Set<string>();
  private referenceIndex: Map<string, TopologyReferenceV5[]> | null = null;
  private scope: Record<string, number> = {};

  constructor(private readonly document: ProjectDocument) {
    for (const node of Object.values(document.nodes)) {
      switch (node.kind) {
        case 'feature':
          this.knownIds.add(node.featureId);
          if (node.bodyId) this.knownIds.add(node.bodyId);
          break;
        case 'body':
          this.knownIds.add(node.bodyId);
          break;
        case 'sketch':
          this.knownIds.add(node.sketchId);
          break;
        case 'sketch-object':
          this.knownIds.add(node.id);
          break;
        case 'parameter':
          this.knownIds.add(node.parameterId);
          break;
        default:
          break;
      }
    }
  }

  error(message: string, span: TextSpan): void {
    this.diagnostics.push({ severity: 'error', message, span });
  }

  warning(message: string, span: TextSpan): void {
    this.diagnostics.push({ severity: 'warning', message, span });
  }

  read(source: string): HistoryModel | null {
    let tree;
    try {
      tree = parseHistoryText(source);
    } catch (error) {
      if (error instanceof HistoryTextSyntaxError) {
        this.diagnostics.push(error.diagnostic);
        return null;
      }
      throw error;
    }
    if (tree.version !== HISTORY_TEXT_VERSION) {
      this.error(
        `This is history text version ${tree.version}; this release reads version ${HISTORY_TEXT_VERSION}.`,
        tree.versionSpan
      );
      return null;
    }
    if (tree.units !== this.document.units) {
      this.error(
        `The text is in ${tree.units} but the document is in ${this.document.units}. Change the document's units in the app, not in the text.`,
        tree.unitsSpan
      );
    }
    // Ids declared by the text count as known, so a new statement can be
    // referenced by a later one.
    for (const statement of tree.statements) {
      this.knownIds.add(statement.id);
      if (statement.type === 'feature') {
        if (statement.bodyId) this.knownIds.add(statement.bodyId);
        const sketch = entryOf(statement.body, '@sketch')?.value;
        if (sketch?.type === 'record') {
          const sketchId = entryOf(statement.body, 'sketchId')?.value;
          if (sketchId?.type === 'id') this.knownIds.add(sketchId.value);
        }
        const objects = entryOf(statement.body, '@objects')?.value;
        if (objects?.type === 'list') {
          for (const item of objects.items) {
            if (item.type === 'node') this.knownIds.add(item.id);
          }
        }
      }
    }

    const declared = new Map<string, TextSpan>();
    const parameters: HistoryParameter[] = [];
    const features: HistoryFeature[] = [];
    for (const statement of tree.statements) {
      const span =
        statement.type === 'feature' ? statement.idSpan : statement.span;
      if (declared.has(statement.id)) {
        this.error(`#${statement.id} is declared twice.`, span);
        continue;
      }
      declared.set(statement.id, span);
      this.spans.set(statement.id, statement.span);
      if (statement.type === 'param') {
        const parameter = this.readParameter(statement);
        if (parameter) parameters.push(parameter);
      }
    }
    this.scope = this.parameterScope(parameters, tree.statements);
    for (const statement of tree.statements) {
      if (statement.type !== 'feature') continue;
      const feature = this.readFeature(statement);
      if (feature) features.push(feature);
    }
    return {
      version: tree.version,
      units: tree.units,
      parameters,
      features
    };
  }

  private readParameter(
    statement: ParameterStatement
  ): HistoryParameter | null {
    let quantity: ParameterKind | undefined;
    if (statement.quantity !== null) {
      if (!Object.hasOwn(HISTORY_PARAMETER_QUANTITIES, statement.quantity)) {
        this.error(
          `\`${statement.quantity}\` is not a parameter quantity; use length, angle or number.`,
          statement.quantitySpan!
        );
        return null;
      }
      quantity = statement.quantity as ParameterKind;
    }
    let expression: string;
    if (statement.value.type === 'expression')
      expression = statement.value.value;
    else if (statement.value.type === 'number')
      expression = String(statement.value.value);
    else {
      this.error(
        'A parameter takes a number or an expression in backticks (`…`).',
        statement.value.span
      );
      return null;
    }
    const extra: HistoryParameter['extra'] = {};
    const conversion = this.newConversion();
    if (statement.extra) {
      for (const entry of statement.extra.entries) {
        const value = convert(entry.value, [entry.key], conversion);
        switch (entry.key) {
          case 'toggle':
            extra.toggle = value as HistoryParameter['extra']['toggle'];
            break;
          case 'exposed':
            if (typeof value !== 'boolean') {
              this.error('`exposed` is true or false.', entry.value.span);
            } else extra.exposed = value;
            break;
          case 'description':
            if (typeof value !== 'string') {
              this.error('`description` is quoted text.', entry.value.span);
            } else extra.description = value;
            break;
          case '@metadata':
            extra.metadata = value as HistoryParameter['extra']['metadata'];
            break;
          default:
            this.error(
              `A parameter has no field \`${entry.key}\`; it takes toggle, exposed, description and @metadata.`,
              entry.keySpan
            );
        }
      }
    }
    this.checkIds(conversion);
    return {
      id: statement.id,
      name: statement.name,
      ...(quantity ? { quantity } : {}),
      expression,
      extra
    };
  }

  /** Evaluates the text's parameters the way the document evaluates its own. */
  private parameterScope(
    parameters: HistoryParameter[],
    statements: readonly (ParameterStatement | FeatureStatement)[]
  ): Record<string, number> {
    const candidate: ProjectDocument = {
      ...this.document,
      nodes: { ...this.document.nodes }
    };
    for (const node of Object.values(candidate.nodes)) {
      if (node.kind === 'parameter') delete candidate.nodes[node.id];
    }
    candidate.parameterOrder = [];
    for (const parameter of parameters) {
      const nodeId = `text-parameter:${parameter.id}`;
      candidate.nodes[nodeId] = {
        id: nodeId,
        kind: 'parameter',
        name: parameter.name,
        parentId: null,
        revisionId: null,
        parameterId: parameter.id,
        expression: parameter.expression,
        value: 0,
        ...(parameter.quantity ? { quantity: parameter.quantity } : {})
      } as DocumentNode;
      candidate.parameterOrder.push(
        parameter.id as ProjectDocument['parameterOrder'][number]
      );
    }
    const { scope, errors } = getParameterScope(candidate);
    const stored = new Map(
      listParameters(this.document).map((parameter) => [
        parameter.name,
        parameter
      ])
    );
    for (const message of errors) {
      const name = /^Parameter "([^"]+)"/.exec(message)?.[1];
      const statement = statements.find(
        (candidateStatement): candidateStatement is ParameterStatement =>
          candidateStatement.type === 'param' &&
          candidateStatement.name === name
      );
      if (!statement) continue;
      const before = name ? stored.get(name) : undefined;
      const unchanged =
        before !== undefined &&
        before.expression ===
          parameters.find((parameter) => parameter.name === name)?.expression;
      // A parameter the document already cannot evaluate is reported, not
      // blamed on the text.
      if (unchanged) this.warning(message, statement.value.span);
      else this.error(message, statement.value.span);
    }
    return scope;
  }

  private newConversion(): Conversion {
    return { sources: new WeakMap(), references: [], expressions: [], ids: [] };
  }

  private checkIds(conversion: Conversion): void {
    for (const id of conversion.ids) {
      if (!this.knownIds.has(id.value)) {
        this.error(
          `#${id.value} is not a feature, sketch, body, sketch object or parameter in this document.`,
          id.span
        );
      }
    }
  }

  private readFeature(statement: FeatureStatement): HistoryFeature | null {
    if (!isHistoryFeatureKind(statement.kind)) {
      this.error(
        `\`${statement.kind}\` is not a feature kind.`,
        statement.kindSpan
      );
      return null;
    }
    for (const entry of statement.body.entries) {
      if (entry.key.startsWith('@') && !STATEMENT_KEYS.has(entry.key)) {
        this.error(
          `\`${entry.key}\` is not a statement field; use @metadata, @sketch or @objects.`,
          entry.keySpan
        );
      }
    }
    const kindEntry = entryOf(statement.body, 'featureKind');
    if (
      kindEntry &&
      !(
        kindEntry.value.type === 'string' &&
        kindEntry.value.value === statement.kind
      )
    ) {
      this.error(
        'The feature kind is written once, before the id.',
        kindEntry.keySpan
      );
    }
    const stored = findFeature(this.document, statement.id as FeatureId);
    if (stored && stored.featureKind !== statement.kind) {
      this.error(
        `${stored.name} is a ${stored.featureKind}; a step's kind cannot change. Delete it and create the other kind.`,
        statement.kindSpan
      );
      return null;
    }
    if (stored) {
      const custom = stored.data.featureKind === 'custom-feature';
      // A custom feature's inputs are the script's to name: an input the
      // instance did not set before may be set now, so only values are typed.
      this.checkAgainstStored(
        statement.body,
        stored.data,
        custom ? new Set([...STATEMENT_KEYS, 'inputs']) : STATEMENT_KEYS
      );
      if (custom) {
        const inputs = entryOf(statement.body, 'inputs');
        if (inputs) this.checkInputValues(inputs.value);
        const script = entryOf(statement.body, 'script');
        if (script?.value.type === 'record')
          this.checkScriptRecord(script.value);
      }
    } else if (!this.checkNewFeature(statement)) {
      // A kind the text cannot create: its fields are not worth typing.
      return null;
    }
    const conversion = this.newConversion();
    const data = convertRecord(statement.body, [], conversion, STATEMENT_KEYS);
    // The kind leads the record, as every builder writes it.
    if (!kindEntry) prependKey(data, 'featureKind', statement.kind);
    const ordered = data;
    this.resolveReferences(conversion, stored?.data);
    restoreHashes(ordered, stored?.data, conversion.sources);

    const metadataEntry = entryOf(statement.body, '@metadata');
    const metadata = metadataEntry
      ? (convert(
          metadataEntry.value,
          ['@metadata'],
          conversion
        ) as HistoryFeature['metadata'])
      : undefined;
    this.checkIds(conversion);

    const node = {
      id: 'text',
      kind: 'feature',
      name: statement.name,
      parentId: null,
      revisionId: null,
      featureId: statement.id,
      featureKind: statement.kind,
      data: ordered
    } as unknown as FeatureNode;
    this.checkExpressions(node, conversion, stored?.data, statement.span);

    const feature: HistoryFeature = {
      featureId: statement.id,
      featureKind: statement.kind,
      name: statement.name,
      ...(statement.bodyId !== null ? { bodyId: statement.bodyId } : {}),
      data: ordered as FeatureData,
      ...(metadata ? { metadata } : {})
    };

    const sketchEntry = entryOf(statement.body, '@sketch');
    const objectsEntry = entryOf(statement.body, '@objects');
    if (statement.kind === 'sketch') {
      this.readSketch(
        statement,
        feature,
        sketchEntry?.value,
        objectsEntry?.value
      );
    } else if (sketchEntry || objectsEntry) {
      this.error(
        'Only a sketch feature holds @sketch and @objects.',
        (sketchEntry ?? objectsEntry)!.keySpan
      );
    }
    return feature;
  }

  private storedSketch(sketchId: unknown): SketchNode | undefined {
    if (typeof sketchId !== 'string') return undefined;
    return Object.values(this.document.nodes).find(
      (node): node is SketchNode =>
        node.kind === 'sketch' && node.sketchId === sketchId
    );
  }

  private readSketch(
    statement: FeatureStatement,
    feature: HistoryFeature,
    sketchValue: ValueNode | undefined,
    objectsValue: ValueNode | undefined
  ): void {
    const sketchId = (feature.data as { sketchId?: unknown }).sketchId;
    const stored = this.storedSketch(sketchId);
    if (!sketchValue || sketchValue.type !== 'record') {
      this.error(
        'A sketch feature needs `@sketch: { … }` with its plane.',
        statement.idSpan
      );
      return;
    }
    if (stored) this.checkAgainstStored(sketchValue, stored, new Set(['name']));
    const conversion = this.newConversion();
    const fields = convertRecord(sketchValue, [], conversion);
    this.resolveReferences(conversion, stored);
    restoreHashes(fields, stored, conversion.sources);
    this.checkIds(conversion);
    // Checked as a sketch node: the walker reads `offset` on the node itself,
    // so the bookkeeping is added to the converted record and removed again.
    const hadName = 'name' in fields;
    const bookkeeping = {
      id: 'text',
      kind: 'sketch',
      parentId: null,
      revisionId: null,
      sketchId,
      objectIds: [],
      name: typeof fields.name === 'string' ? fields.name : statement.name
    };
    Object.assign(fields, bookkeeping);
    this.checkExpressions(
      fields as unknown as SketchNode,
      conversion,
      stored,
      sketchValue.span
    );
    for (const key of Object.keys(bookkeeping)) {
      if (key !== 'name' || !hadName) delete fields[key];
    }
    feature.sketch = fields as HistorySketchFields;

    const objects: HistorySketchObject[] = [];
    if (objectsValue && objectsValue.type !== 'list') {
      this.error('`@objects` is a list of sketch objects.', objectsValue.span);
    } else {
      for (const item of objectsValue?.items ?? []) {
        if (item.type !== 'node') {
          this.error(
            'A sketch object is written `kind #id "name" { … }`.',
            item.span
          );
          continue;
        }
        this.spans.set(item.id, item.span);
        const object = this.readSketchObject(item);
        if (object) objects.push(object);
      }
    }
    feature.objects = objects;
  }

  private readSketchObject(item: ObjectNode): HistorySketchObject | null {
    if (!isHistorySketchObjectKind(item.head)) {
      this.error(
        `\`${item.head}\` is not a sketch object kind.`,
        item.headSpan
      );
      return null;
    }
    const storedNode = this.document.nodes[item.id];
    const stored =
      storedNode?.kind === 'sketch-object' ? storedNode.data : undefined;
    if (stored) {
      this.checkAgainstStored(
        item.body,
        stored,
        new Set(['@metadata', 'objectKind'])
      );
    } else {
      this.error(
        `#${item.id} is not an object of this sketch; draw new sketch objects in the app.`,
        item.span
      );
    }
    const conversion = this.newConversion();
    const data = convertRecord(
      item.body,
      [],
      conversion,
      new Set(['@metadata'])
    );
    if (!('objectKind' in data)) prependKey(data, 'objectKind', item.head);
    const ordered = data;
    this.resolveReferences(conversion, stored);
    restoreHashes(ordered, stored, conversion.sources);
    const metadataEntry = entryOf(item.body, '@metadata');
    const metadata = metadataEntry
      ? (convert(
          metadataEntry.value,
          ['@metadata'],
          conversion
        ) as HistorySketchObject['metadata'])
      : undefined;
    this.checkIds(conversion);
    const node = {
      id: item.id,
      kind: 'sketch-object',
      name: item.name,
      parentId: null,
      revisionId: null,
      objectKind: item.head,
      data: ordered
    } as unknown as DocumentNode;
    this.checkExpressions(node, conversion, stored, item.span);
    return {
      id: item.id,
      name: item.name,
      objectKind: item.head,
      data: ordered as unknown as SketchObjectData,
      ...(metadata ? { metadata } : {})
    };
  }

  /**
   * Types an existing statement against what the document stores for it:
   * every field the text writes must be one the node holds, with a value of
   * the same kind (a number or an expression where it holds either). The
   * stored node is the schema for all 28 feature kinds; new optional
   * settings are set in the app.
   */
  private checkAgainstStored(
    node: ValueNode,
    stored: unknown,
    skip: ReadonlySet<string> = new Set(),
    key = ''
  ): void {
    if (stored === null || stored === undefined) return;
    const textKind = textValueKind(node);
    const storedKind = storedValueKind(stored);
    const compatible =
      textKind === storedKind ||
      // A number and an expression stand for each other in a value field;
      // the expression check below decides whether the field takes one.
      (storedKind === 'number' && node.type === 'expression') ||
      (storedKind === 'string' && textKind === 'number');
    if (!compatible) {
      this.error(
        `${key ? `\`${key}\`` : 'This'} holds ${article(storedKind)} here, not ${article(textKind)}.`,
        node.span
      );
      return;
    }
    if (node.type === 'record' && storedKind === 'record') {
      const record = stored as Record<string, unknown>;
      for (const entry of node.entries) {
        // `@` keys are statement fields, reported on their own.
        if (skip.has(entry.key) || entry.key.startsWith('@')) continue;
        if (
          !Object.hasOwn(record, entry.key) ||
          record[entry.key] === undefined
        ) {
          this.error(
            `\`${entry.key}\` is not a field this step stores; set new options in the app, then edit them here.`,
            entry.keySpan
          );
          continue;
        }
        this.checkAgainstStored(
          entry.value,
          record[entry.key],
          undefined,
          entry.key
        );
      }
    } else if (node.type === 'list' && Array.isArray(stored)) {
      node.items.forEach((item, index) => {
        if (index < stored.length) {
          this.checkAgainstStored(item, stored[index], undefined, key);
          return;
        }
        // An added item is held to the kind of value the list already
        // holds; a list the document keeps empty is filled in the app.
        const template: unknown = (stored as unknown[]).find(
          (value) => value !== null
        );
        if (template === undefined) {
          this.error(
            `\`${key}\` is empty in the document; add its items in the app.`,
            item.span
          );
        } else if (textValueKind(item) !== storedValueKind(template)) {
          this.error(
            `\`${key}\` is a list of ${plural(storedValueKind(template))}, not ${article(textValueKind(item))}.`,
            item.span
          );
        }
      });
    }
  }

  /**
   * A statement the document does not hold yet. Only a primitive can be
   * created from text, so only a primitive is accepted, field by field.
   */
  private checkNewFeature(statement: FeatureStatement): boolean {
    if (statement.kind === 'custom-feature')
      return this.checkNewCustomFeature(statement);
    if (statement.kind !== 'primitive') {
      this.error(
        `#${statement.id} is not a step of this document. Create a ${statement.kind} step in the app, then edit it here; the text adds primitives and custom features.`,
        statement.idSpan
      );
      return false;
    }
    const kind = entryOf(statement.body, 'primitiveKind');
    if (
      !kind ||
      kind.value.type !== 'string' ||
      !Object.hasOwn(HISTORY_PRIMITIVE_KINDS, kind.value.value)
    ) {
      this.error(
        `A new primitive needs \`primitiveKind\`: ${Object.keys(
          HISTORY_PRIMITIVE_KINDS
        )
          .map((name) => `"${name}"`)
          .join(', ')}.`,
        kind?.value.span ?? statement.idSpan
      );
    }
    const dimensions = entryOf(statement.body, 'dimensions');
    if (!dimensions || dimensions.value.type !== 'record') {
      this.error(
        'A new primitive needs `dimensions: { … }`.',
        dimensions?.value.span ?? statement.idSpan
      );
    } else {
      for (const entry of dimensions.value.entries) {
        if (
          !(HISTORY_PRIMITIVE_DIMENSIONS as readonly string[]).includes(
            entry.key
          )
        ) {
          this.error(
            `A primitive has no dimension \`${entry.key}\`.`,
            entry.keySpan
          );
        } else if (
          entry.value.type !== 'number' &&
          entry.value.type !== 'expression'
        ) {
          this.error(
            `\`${entry.key}\` takes a number or an expression in backticks.`,
            entry.value.span
          );
        }
      }
    }
    for (const entry of statement.body.entries) {
      if (
        entry.key !== 'primitiveKind' &&
        entry.key !== 'dimensions' &&
        !STATEMENT_KEYS.has(entry.key)
      ) {
        this.error(
          `A new primitive takes \`primitiveKind\` and \`dimensions\`; set \`${entry.key}\` in the app.`,
          entry.keySpan
        );
      }
    }
    return true;
  }

  /** A new custom feature: a target, a script that compiles, and inputs. */
  private checkNewCustomFeature(statement: FeatureStatement): boolean {
    let ok = true;
    for (const entry of statement.body.entries) {
      if (STATEMENT_KEYS.has(entry.key)) continue;
      if (!['targetBodyId', 'script', 'inputs'].includes(entry.key)) {
        this.error(
          `A custom feature takes \`targetBodyId\`, \`script\` and \`inputs\`, not \`${entry.key}\`.`,
          entry.keySpan
        );
        ok = false;
      }
    }
    const target = entryOf(statement.body, 'targetBodyId');
    if (!target || target.value.type !== 'id') {
      this.error(
        'A custom feature needs `targetBodyId: #body`.',
        target?.value.span ?? statement.idSpan
      );
      ok = false;
    }
    const inputs = entryOf(statement.body, 'inputs');
    if (inputs) {
      const before = this.diagnostics.length;
      this.checkInputValues(inputs.value);
      if (this.diagnostics.length > before) ok = false;
    }
    const script = entryOf(statement.body, 'script');
    if (!script || script.value.type !== 'record') {
      this.error(
        'A custom feature needs `script: { id, version, source }`.',
        script?.value.span ?? statement.idSpan
      );
      return false;
    }
    return this.checkScriptRecord(script.value) && ok;
  }

  /** A custom feature's inputs: a record of numbers and expressions. */
  private checkInputValues(node: ValueNode): void {
    if (node.type !== 'record') {
      this.error('`inputs` is a record of values.', node.span);
      return;
    }
    for (const entry of node.entries) {
      if (entry.value.type !== 'number' && entry.value.type !== 'expression') {
        this.error(
          `Input \`${entry.key}\` takes a number or an expression in backticks.`,
          entry.value.span
        );
      }
    }
  }

  /** A script record's fields, and its source compiled to the diagnostics' lines. */
  checkScriptRecord(record: RecordNode): boolean {
    let ok = true;
    for (const entry of record.entries) {
      if (!['id', 'version', 'api', 'source', 'digest'].includes(entry.key)) {
        this.error(`A script has no field \`${entry.key}\`.`, entry.keySpan);
        ok = false;
      }
    }
    const source = entryOf(record, 'source');
    if (!source || source.value.type !== 'string') {
      this.error(
        'A script needs its `source` as text.',
        source?.value.span ?? record.span
      );
      return false;
    }
    const compiled = compileScript(source.value.value);
    for (const diagnostic of compiled.diagnostics) {
      if (diagnostic.severity !== 'error') continue;
      this.error(
        `Script line ${diagnostic.span.start.line}, column ${diagnostic.span.start.column}: ${diagnostic.message}`,
        source.value.span
      );
      ok = false;
    }
    if (!compiled.script) return false;
    for (const key of ['id', 'version'] as const) {
      const entry = entryOf(record, key);
      if (
        entry &&
        !(
          entry.value.type === 'string' &&
          entry.value.value === compiled.script[key]
        )
      ) {
        this.error(
          `The script's ${key} is ${JSON.stringify(compiled.script[key])}, as its source says.`,
          entry.value.span
        );
        ok = false;
      }
    }
    return ok;
  }

  /**
   * Turns `face(#f, "name")` back into the stored V5 reference: the one at the
   * same place in the stored node, else the document's only reference with
   * that kind, producer and lineage. Anything else is refused: the witness
   * comes from the exact build, never from the text.
   */
  private resolveReferences(conversion: Conversion, storedRoot: unknown): void {
    for (const pending of conversion.references) {
      const { node } = pending;
      const here = valueAt(storedRoot, pending.path);
      let resolved: TopologyReferenceV5 | undefined;
      if (
        isTopologyReference(here) &&
        here.kind === node.referenceKind &&
        here.producingFeatureId === node.feature &&
        here.lineageName === node.lineage
      ) {
        resolved = here;
      } else {
        this.referenceIndex ??= storedReferences(this.document);
        const matches =
          this.referenceIndex.get(
            referenceKey(node.referenceKind, node.feature, node.lineage)
          ) ?? [];
        if (matches.length === 1) resolved = matches[0];
        else if (matches.length > 1) {
          this.error(
            `${node.referenceKind}(#${node.feature}, ${JSON.stringify(node.lineage)}) names more than one stored ${node.referenceKind}; pick it in the app.`,
            node.span
          );
        }
      }
      if (!resolved) {
        if (
          !this.diagnostics.some((diagnostic) => diagnostic.span === node.span)
        ) {
          this.error(
            `${node.referenceKind}(#${node.feature}, ${JSON.stringify(node.lineage)}) is not a ${node.referenceKind} this document has picked; pick it in the app.`,
            node.span
          );
        }
        continue;
      }
      (pending.container as Record<string | number, unknown>)[pending.key] =
        structuredClone(resolved);
    }
  }

  /**
   * Checks the text against document-core's own expression fields: an
   * expression literal must sit in one, a quoted string must not, and each
   * expression must evaluate to its field's quantity. A field the document
   * already holds unchanged is only warned about.
   */
  private checkExpressions(
    node: DocumentNode,
    conversion: Conversion,
    storedRoot: unknown,
    statementSpan: TextSpan
  ): void {
    let sites: ReturnType<typeof expressionSitesOf>;
    try {
      sites = expressionSitesOf(node);
    } catch (error) {
      this.error(
        `This statement does not have the shape its kind needs (${error instanceof Error ? error.message : 'unreadable'}).`,
        statementSpan
      );
      return;
    }
    for (const literal of conversion.expressions) {
      if (!sites.get(literal.container)?.has(literal.key)) {
        this.error(
          `\`${literal.key}\` is not an expression field; write its value as a literal.`,
          literal.node.span
        );
      }
    }
    for (const [container, keys] of sites) {
      const sources = conversion.sources.get(container);
      for (const [key, dimension] of keys) {
        const source = sources?.get(key);
        if (!source) continue;
        if (source.type === 'string') {
          this.error(
            `\`${key}\` is an expression field: write \`${source.value}\` in backticks, or a number.`,
            source.span
          );
          continue;
        }
        if (source.type !== 'expression') continue;
        const unchanged = isStoredUnchanged(
          storedRoot,
          node,
          container,
          key,
          source.value
        );
        try {
          evaluateAt(source.value, this.scope, this.document, dimension);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Expression failed.';
          if (unchanged) this.warning(message, source.span);
          else this.error(message, source.span);
        }
      }
    }
  }
}

function evaluateAt(
  expression: string,
  scope: Record<string, number>,
  document: ProjectDocument,
  dimension: ExpressionFieldDimension
): number {
  return dimension === null
    ? evaluateExpression(expression, scope, { documentUnits: document.units })
    : evaluateFieldExpression(expression, scope, {
        documentUnits: document.units,
        dimension
      });
}

/** Whether `container[key]` already holds `value` at the same place in the stored node. */
function isStoredUnchanged(
  storedRoot: unknown,
  node: DocumentNode,
  container: object,
  key: string,
  value: string
): boolean {
  if (storedRoot === undefined) return false;
  const root =
    node.kind === 'feature' || node.kind === 'sketch-object'
      ? (node as { data: unknown }).data
      : node;
  const path = pathTo(root, container);
  if (!path) return false;
  return valueAt(storedRoot, [...path, key]) === value;
}

function pathTo(root: unknown, target: object, path: Path = []): Path | null {
  if (root === target) return path;
  if (typeof root !== 'object' || root === null) return null;
  for (const [key, child] of Object.entries(root)) {
    const found = pathTo(child, target, [
      ...path,
      Array.isArray(root) ? Number(key) : key
    ]);
    if (found) return found;
  }
  return null;
}

/**
 * Puts back each hash field the printer left out because its references
 * implied it. A field is restored where the stored node has it, or, for a
 * new or reshaped node, wherever its reference partner is present.
 */
function restoreHashes(
  root: Record<string, unknown>,
  storedRoot: unknown,
  sources: SourceMap,
  path: Path = []
): void {
  const visit = (value: unknown, at: Path): void => {
    if (
      typeof value !== 'object' ||
      value === null ||
      isTopologyReference(value)
    )
      return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...at, index]));
      return;
    }
    const record = value as Record<string, unknown>;
    const fromText = sources.get(record);
    for (const [referenceKey, hashKey] of Object.entries(
      REFERENCE_HASH_PAIRS
    )) {
      if (!(referenceKey in record) || hashKey in record) continue;
      if (fromText && fromText.has(hashKey)) continue;
      const implied = hashesOfReferences(record[referenceKey]);
      if (implied === undefined) continue;
      const storedHere = valueAt(storedRoot, at);
      const storedHasHash =
        typeof storedHere === 'object' &&
        storedHere !== null &&
        hashKey in storedHere;
      if (storedHere !== undefined && !storedHasHash) continue;
      insertBefore(record, referenceKey, hashKey, implied);
    }
    for (const [key, child] of Object.entries(record))
      visit(child, [...at, key]);
  };
  visit(root, path);
}

/** Adds `key` as the record's first key, keeping the record's identity. */
function prependKey(
  record: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  const entries = Object.entries(record);
  for (const existing of Object.keys(record)) delete record[existing];
  record[key] = value;
  for (const [entryKey, entryValue] of entries) record[entryKey] = entryValue;
}

/** Adds `key` just before `before`, keeping the record's other keys in order. */
function insertBefore(
  record: Record<string, unknown>,
  before: string,
  key: string,
  value: unknown
): void {
  const entries = Object.entries(record);
  for (const existing of Object.keys(record)) delete record[existing];
  for (const [entryKey, entryValue] of entries) {
    if (entryKey === before) record[key] = value;
    record[entryKey] = entryValue;
  }
}

/**
 * Reads a history text against the document it describes: parses it, types
 * every statement and resolves ids and topology references. Never throws on
 * bad text; every problem is a diagnostic with a line and column.
 */
export function readHistoryText(
  source: string,
  document: ProjectDocument
): HistoryTextReadResult {
  const reader = new Reader(document);
  const model = reader.read(source);
  const diagnostics = reader.diagnostics.sort(
    (left, right) => left.span.start.offset - right.span.start.offset
  );
  return { model, spans: reader.spans, diagnostics };
}
