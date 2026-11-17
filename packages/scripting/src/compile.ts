import type {
  CadPatchOperation,
  CadPatchProposal
} from '@openzcad/ai-contracts';
import type { FeatureId, ProjectDocument, SketchId } from '@openzcad/shared';
import {
  historyModelOf,
  type HistoryFeature,
  type HistoryModel,
  type HistoryParameter
} from './model';
import { readHistoryText } from './read';
import type { HistoryTextDiagnostic, TextSpan } from './syntax';

/** The patch's own bound: more changes than this apply in parts. */
const MAX_OPERATIONS = 60;

export interface HistoryEditResult {
  /**
   * The edit as a patch proposal, or `null` when the text has errors or
   * changes nothing. It still has to pass exact preflight before it applies.
   */
  proposal: CadPatchProposal | null;
  diagnostics: HistoryTextDiagnostic[];
  /** One line per operation, for a summary before Apply. */
  summary: string[];
}

const PRIMITIVE_DIMENSIONS = [
  'width',
  'height',
  'depth',
  'radius',
  'bottomRadius',
  'topRadius',
  'majorRadius',
  'minorRadius'
] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  return JSON.stringify(value);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

class Compiler {
  readonly diagnostics: HistoryTextDiagnostic[] = [];
  readonly summary: string[] = [];
  private readonly renames: CadPatchOperation[] = [];
  private readonly parameterSets: CadPatchOperation[] = [];
  private readonly featureEdits: CadPatchOperation[] = [];
  private readonly featureDeletes: CadPatchOperation[] = [];
  private readonly reorders: CadPatchOperation[] = [];
  private readonly additions: CadPatchOperation[] = [];
  private readonly parameterDeletes: CadPatchOperation[] = [];

  constructor(
    private readonly spans: ReadonlyMap<string, TextSpan>,
    private readonly fallback: TextSpan
  ) {}

  private refuse(id: string, message: string): void {
    this.diagnostics.push({
      severity: 'error',
      message,
      span: this.spans.get(id) ?? this.fallback
    });
  }

  compile(base: HistoryModel, text: HistoryModel): CadPatchOperation[] {
    this.parameters(base.parameters, text.parameters);
    this.features(base.features, text.features);
    return [
      ...this.renames,
      ...this.parameterSets,
      ...this.featureEdits,
      ...this.featureDeletes,
      ...this.reorders,
      ...this.additions,
      ...this.parameterDeletes
    ];
  }

  private parameters(
    base: readonly HistoryParameter[],
    text: readonly HistoryParameter[]
  ): void {
    const before = new Map(base.map((parameter) => [parameter.id, parameter]));
    const after = new Map(text.map((parameter) => [parameter.id, parameter]));
    const namesBefore = new Map(
      base.map((parameter) => [parameter.name, parameter.id])
    );
    for (const parameter of text) {
      const stored = before.get(parameter.id);
      if (!stored) {
        const owner = namesBefore.get(parameter.name);
        if (owner !== undefined && after.has(owner)) {
          this.refuse(
            parameter.id,
            `A parameter named ${parameter.name} already exists.`
          );
          continue;
        }
        if (Object.keys(parameter.extra).length > 0) {
          this.refuse(
            parameter.id,
            'A new parameter takes only a name, a quantity and an expression here; set its other fields in the Parameters panel.'
          );
          continue;
        }
        this.parameterSets.push({
          kind: 'set_parameter',
          name: parameter.name,
          expression: parameter.expression,
          ...(parameter.quantity ? { quantity: parameter.quantity } : {})
        });
        this.summary.push(
          `Add parameter ${parameter.name} = ${parameter.expression}`
        );
        continue;
      }
      if (!same(stored.extra, parameter.extra)) {
        this.refuse(
          parameter.id,
          `Change ${parameter.name}'s visibility, description, toggle or metadata in the Parameters panel; the text edits its name, quantity and expression.`
        );
        continue;
      }
      if (stored.name !== parameter.name) {
        this.renames.push({
          kind: 'rename_parameter',
          name: stored.name,
          newName: parameter.name
        });
        this.summary.push(
          `Rename parameter ${stored.name} to ${parameter.name}`
        );
      }
      if (
        stored.expression !== parameter.expression ||
        (stored.quantity ?? null) !== (parameter.quantity ?? null)
      ) {
        this.parameterSets.push({
          kind: 'set_parameter',
          name: parameter.name,
          expression: parameter.expression,
          ...((stored.quantity ?? null) !== (parameter.quantity ?? null)
            ? { quantity: parameter.quantity ?? null }
            : {})
        });
        this.summary.push(
          `Set parameter ${parameter.name} = ${parameter.expression}`
        );
      }
    }
    for (const stored of base) {
      if (after.has(stored.id)) continue;
      this.parameterDeletes.push({
        kind: 'delete_parameter',
        name: stored.name
      });
      this.summary.push(`Delete parameter ${stored.name}`);
    }
  }

  private features(
    base: readonly HistoryFeature[],
    text: readonly HistoryFeature[]
  ): void {
    const before = new Map(base.map((feature) => [feature.featureId, feature]));
    const after = new Map(text.map((feature) => [feature.featureId, feature]));
    let sawNew = false;
    for (const feature of text) {
      const stored = before.get(feature.featureId);
      if (!stored) {
        sawNew = true;
        this.addFeature(feature);
        continue;
      }
      if (sawNew) {
        this.refuse(
          feature.featureId,
          'New steps go at the end of the history; move a new step once it exists.'
        );
      }
      this.editFeature(stored, feature);
    }
    const deleted = base.filter((feature) => !after.has(feature.featureId));
    for (const feature of deleted) {
      this.featureDeletes.push({
        kind: 'delete_feature',
        featureId: feature.featureId as FeatureId
      });
      this.summary.push(`Delete ${feature.name}`);
    }
    // Moves, applied after the deletes: walk the wanted order and move each
    // step that is out of place to its index, as feature.reorder counts.
    const current = base
      .filter((feature) => after.has(feature.featureId))
      .map((feature) => feature.featureId);
    const wanted = text
      .filter((feature) => before.has(feature.featureId))
      .map((feature) => feature.featureId);
    wanted.forEach((featureId, index) => {
      if (current[index] === featureId) return;
      const from = current.indexOf(featureId);
      current.splice(from, 1);
      current.splice(index, 0, featureId);
      this.reorders.push({
        kind: 'reorder_feature',
        featureId: featureId as FeatureId,
        toIndex: index
      });
      this.summary.push(
        `Move ${after.get(featureId)!.name} to step ${index + 1}`
      );
    });
  }

  private addFeature(feature: HistoryFeature): void {
    if (feature.featureKind !== 'primitive') {
      this.refuse(
        feature.featureId,
        `Create a ${feature.featureKind} step in the app, then edit it here; the text adds primitives.`
      );
      return;
    }
    const data = feature.data as Extract<
      HistoryFeature['data'],
      { featureKind: 'primitive' }
    >;
    if (feature.metadata) {
      this.refuse(feature.featureId, 'A new step takes no @metadata.');
      return;
    }
    const unknown = Object.keys(data.dimensions ?? {}).filter(
      (key) => !(PRIMITIVE_DIMENSIONS as readonly string[]).includes(key)
    );
    if (unknown.length > 0) {
      this.refuse(
        feature.featureId,
        `A primitive has no dimension ${unknown.join(', ')}.`
      );
      return;
    }
    const dimensions = Object.fromEntries(
      PRIMITIVE_DIMENSIONS.map((key) => [key, data.dimensions?.[key] ?? null])
    ) as Extract<CadPatchOperation, { kind: 'add_primitive' }>['dimensions'];
    this.additions.push({
      kind: 'add_primitive',
      name: feature.name,
      primitiveKind: data.primitiveKind,
      dimensions
    });
    this.summary.push(`Add ${data.primitiveKind} ${feature.name}`);
  }

  private editFeature(stored: HistoryFeature, feature: HistoryFeature): void {
    const id = feature.featureId;
    if (stored.featureKind !== feature.featureKind) {
      this.refuse(
        id,
        `${stored.name} is a ${stored.featureKind}; a step's kind cannot change. Delete it and create the other kind.`
      );
      return;
    }
    if ((stored.bodyId ?? null) !== (feature.bodyId ?? null)) {
      this.refuse(id, `${stored.name}'s result body (after ->) cannot change.`);
      return;
    }
    if (!same(stored.metadata, feature.metadata)) {
      this.refuse(
        id,
        `Suppress, colour or tag ${stored.name} from the History list; the text does not change @metadata.`
      );
      return;
    }
    if (stored.name !== feature.name) {
      this.featureEdits.push({
        kind: 'rename_feature',
        featureId: id as FeatureId,
        name: feature.name
      });
      this.summary.push(`Rename ${stored.name} to ${feature.name}`);
    }
    this.editData(stored, feature);
    if (stored.featureKind === 'sketch') this.editSketch(stored, feature);
  }

  private editData(stored: HistoryFeature, feature: HistoryFeature): void {
    const before = stored.data as unknown as Record<string, unknown>;
    const after = feature.data as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const clearData: string[] = [];
    for (const [key, value] of Object.entries(after)) {
      if (key === 'featureKind') continue;
      if (!same(before[key], value)) data[key] = value;
    }
    for (const key of Object.keys(before)) {
      if (
        key !== 'featureKind' &&
        !(key in after) &&
        before[key] !== undefined
      ) {
        clearData.push(key);
      }
    }
    // A primitive's dimensions merge key by key, so one cannot be removed.
    if (
      'dimensions' in data &&
      before.dimensions &&
      typeof before.dimensions === 'object'
    ) {
      const removed = Object.keys(before.dimensions).filter(
        (key) => !(key in (data.dimensions as Record<string, unknown>))
      );
      if (removed.length > 0) {
        this.refuse(
          feature.featureId,
          `${feature.name} keeps its ${removed.join(', ')}; a dimension can be changed but not removed.`
        );
        return;
      }
    }
    if (Object.keys(data).length === 0 && clearData.length === 0) return;
    this.featureEdits.push({
      kind: 'update_feature',
      featureId: feature.featureId as FeatureId,
      data,
      clearData
    });
    this.summary.push(
      `Edit ${feature.name}: ${[...Object.keys(data), ...clearData.map((key) => `no ${key}`)].join(', ')}`
    );
  }

  private editSketch(stored: HistoryFeature, feature: HistoryFeature): void {
    if (!same(stored.sketch, feature.sketch)) {
      this.refuse(
        feature.featureId,
        `Change ${feature.name}'s plane, constraints or dimensions in the sketch; the text edits its objects' values.`
      );
      return;
    }
    const before = stored.objects ?? [];
    const after = feature.objects ?? [];
    if (
      before.length !== after.length ||
      before.some((object, index) => object.id !== after[index]!.id)
    ) {
      this.refuse(
        feature.featureId,
        `Draw, delete or reorder ${feature.name}'s objects in the sketch; the text edits their values.`
      );
      return;
    }
    const sketchId = (feature.data as { sketchId: SketchId }).sketchId;
    after.forEach((object, index) => {
      const original = before[index]!;
      if (
        original.name !== object.name ||
        original.objectKind !== object.objectKind ||
        !same(original.metadata, object.metadata)
      ) {
        this.refuse(
          object.id,
          'A sketch object keeps its kind, name and metadata here; change its values.'
        );
        return;
      }
      if (same(original.data, object.data)) return;
      this.featureEdits.push({
        kind: 'update_sketch_object',
        sketchId,
        objectId: object.id,
        data: object.data
      });
      this.summary.push(`Edit ${object.name} in ${feature.name}`);
    });
  }
}

/**
 * Compiles an edited history text into the patch proposal that makes the
 * document say it (L15). The proposal uses the same vocabulary, validation,
 * exact preflight and single undo step as the assistant and the agent API;
 * nothing here writes the document. Unchanged text compiles to no proposal.
 */
export function compileHistoryEdit(
  document: ProjectDocument,
  source: string
): HistoryEditResult {
  const read = readHistoryText(source, document);
  const errors = read.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error'
  );
  if (!read.model || errors.length > 0) {
    return { proposal: null, diagnostics: read.diagnostics, summary: [] };
  }
  const start = { line: 1, column: 1, offset: 0 };
  const compiler = new Compiler(read.spans, { start, end: start });
  const operations = compiler.compile(historyModelOf(document), read.model);
  const diagnostics = [...read.diagnostics, ...compiler.diagnostics].sort(
    (left, right) => left.span.start.offset - right.span.start.offset
  );
  if (compiler.diagnostics.length > 0) {
    return { proposal: null, diagnostics, summary: [] };
  }
  if (operations.length > MAX_OPERATIONS) {
    return {
      proposal: null,
      diagnostics: [
        ...diagnostics,
        {
          severity: 'error',
          message: `This edit makes ${operations.length} changes; apply at most ${MAX_OPERATIONS} at once.`,
          span: { start, end: start }
        }
      ],
      summary: []
    };
  }
  if (operations.length === 0) {
    return { proposal: null, diagnostics, summary: [] };
  }
  return {
    proposal: {
      proposalId: `history-text-${document.projectId}-${document.version}`,
      summary: 'Edit history text',
      assumptions: [],
      operations
    },
    diagnostics,
    summary: compiler.summary
  };
}
