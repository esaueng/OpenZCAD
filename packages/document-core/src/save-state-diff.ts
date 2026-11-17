import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  type DocumentNode,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * L03: what changed between two save states, in the terms the model is
 * edited in — features, sketches, parameters, bodies and drawing sheets —
 * rather than as a text diff of the stored document.
 *
 * Pure and local: it reads two decrypted documents in the browser and sends
 * nothing anywhere, so it is as safe on an encrypted project as opening
 * either save (ADR-024). It compares canonical content only: save points,
 * revisions, the command log, undo history and derived meshes are the record
 * of how a model got somewhere, not part of what it is.
 */

export interface SaveStateDiffItem {
  id: string;
  name: string;
}

export interface SaveStateChangedItem extends SaveStateDiffItem {
  /** Short phrases: "renamed from “Pad”", "suppressed", "edited". */
  changes: string[];
}

export interface SaveStateDiffGroup {
  added: SaveStateDiffItem[];
  removed: SaveStateDiffItem[];
  changed: SaveStateChangedItem[];
}

export interface SaveStateParameterChange {
  name: string;
  before: string | null;
  after: string | null;
}

export interface SaveStateDiff {
  features: SaveStateDiffGroup & {
    /** The features both have now run in a different order. */
    reordered: boolean;
  };
  sketches: SaveStateDiffGroup;
  bodies: SaveStateDiffGroup;
  /** Added, removed or re-expressed parameters, by name. */
  parameters: SaveStateParameterChange[];
  drawingSheets: SaveStateDiffGroup;
  /** Project-level fields: its name and units. */
  properties: { field: 'name' | 'units'; before: string; after: string }[];
  /** Nothing in the model differs. */
  identical: boolean;
}

/** JSON with object keys sorted, so equal values compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0
          )
        )
      : inner
  );
}

/** A node as the model reads it: without bookkeeping that every save moves. */
function modelContent(node: DocumentNode): unknown {
  const { revisionId: _revision, name: _name, metadata, ...rest } = node;
  const { [FEATURE_SUPPRESSED_METADATA_KEY]: _suppressed, ...kept } =
    metadata ?? {};
  return { ...rest, metadata: kept };
}

function suppressed(node: DocumentNode): boolean {
  return node.metadata?.[FEATURE_SUPPRESSED_METADATA_KEY] === true;
}

function nodesOfKind<K extends DocumentNode['kind']>(
  document: ProjectDocument,
  kind: K,
  order: readonly string[] | null
): Extract<DocumentNode, { kind: K }>[] {
  const all = Object.values(document.nodes).filter(
    (node): node is Extract<DocumentNode, { kind: K }> => node.kind === kind
  );
  if (!order) return all;
  const rank = new Map(order.map((id, index) => [id, index]));
  return all.sort(
    (left, right) =>
      (rank.get(idOf(left)) ?? Infinity) - (rank.get(idOf(right)) ?? Infinity)
  );
}

function idOf(node: DocumentNode): string {
  switch (node.kind) {
    case 'feature':
      return node.featureId;
    case 'sketch':
      return node.sketchId;
    case 'body':
      return node.bodyId;
    case 'parameter':
      return node.parameterId;
    default:
      return node.id;
  }
}

/** The sketch with its objects, which live in nodes of their own. */
function sketchContent(
  document: ProjectDocument,
  node: Extract<DocumentNode, { kind: 'sketch' }>
): string {
  return stable({
    sketch: modelContent(node),
    objects: node.objectIds.map((id) => {
      const object = document.nodes[id];
      return object ? modelContent(object) : null;
    })
  });
}

function group<T extends DocumentNode>(
  before: readonly T[],
  after: readonly T[],
  content: (node: T, side: 'before' | 'after') => string,
  extra?: (previous: T, next: T) => string[]
): SaveStateDiffGroup {
  const earlier = new Map(before.map((node) => [idOf(node), node]));
  const later = new Map(after.map((node) => [idOf(node), node]));
  const item = (node: T): SaveStateDiffItem => ({
    id: idOf(node),
    name: node.name
  });
  const changed: SaveStateChangedItem[] = [];
  for (const next of after) {
    const previous = earlier.get(idOf(next));
    if (!previous) continue;
    const changes: string[] = [];
    if (previous.name !== next.name)
      changes.push(`renamed from “${previous.name}”`);
    changes.push(...(extra?.(previous, next) ?? []));
    if (content(previous, 'before') !== content(next, 'after'))
      changes.push('edited');
    if (changes.length) changed.push({ ...item(next), changes });
  }
  return {
    added: after.filter((node) => !earlier.has(idOf(node))).map(item),
    removed: before.filter((node) => !later.has(idOf(node))).map(item),
    changed
  };
}

/** What changed from `before` to `after`. */
export function diffSaveStates(
  before: ProjectDocument,
  after: ProjectDocument
): SaveStateDiff {
  const beforeFeatures = nodesOfKind(before, 'feature', before.featureOrder);
  const afterFeatures = nodesOfKind(after, 'feature', after.featureOrder);
  const features = group(
    beforeFeatures,
    afterFeatures,
    (node) => stable(modelContent(node)),
    (previous, next) =>
      suppressed(previous) === suppressed(next)
        ? []
        : [suppressed(next) ? 'suppressed' : 'unsuppressed']
  );
  const shared = (order: readonly string[], other: ReadonlySet<string>) =>
    order.filter((id) => other.has(id));
  const reordered =
    shared(before.featureOrder, new Set(after.featureOrder)).join(' ') !==
    shared(after.featureOrder, new Set(before.featureOrder)).join(' ');

  const sketches = group(
    nodesOfKind(before, 'sketch', before.sketchOrder),
    nodesOfKind(after, 'sketch', after.sketchOrder),
    (node, side) => sketchContent(side === 'before' ? before : after, node)
  );
  const bodies = group(
    nodesOfKind(before, 'body', before.bodyOrder),
    nodesOfKind(after, 'body', after.bodyOrder),
    (node) => stable(modelContent(node))
  );

  const expressions = (document: ProjectDocument) =>
    new Map(
      nodesOfKind(document, 'parameter', document.parameterOrder).map(
        (node) => [node.name, node.expression]
      )
    );
  const earlierParameters = expressions(before);
  const laterParameters = expressions(after);
  const parameters: SaveStateParameterChange[] = [];
  for (const [name, expression] of laterParameters) {
    const previous = earlierParameters.get(name);
    if (previous !== expression)
      parameters.push({ name, before: previous ?? null, after: expression });
  }
  for (const [name, expression] of earlierParameters)
    if (!laterParameters.has(name))
      parameters.push({ name, before: expression, after: null });

  const sheets = (document: ProjectDocument) =>
    (document.drawings?.sheets ?? []).map((sheet) => ({
      id: sheet.sheetId,
      name: sheet.name,
      content: stable({ ...sheet, name: undefined })
    }));
  const earlierSheets = sheets(before);
  const laterSheets = sheets(after);
  const earlierById = new Map(earlierSheets.map((sheet) => [sheet.id, sheet]));
  const laterIds = new Set(laterSheets.map((sheet) => sheet.id));
  const drawingSheets: SaveStateDiffGroup = {
    added: laterSheets
      .filter((sheet) => !earlierById.has(sheet.id))
      .map(({ id, name }) => ({ id, name })),
    removed: earlierSheets
      .filter((sheet) => !laterIds.has(sheet.id))
      .map(({ id, name }) => ({ id, name })),
    changed: laterSheets.flatMap((sheet) => {
      const previous = earlierById.get(sheet.id);
      if (!previous) return [];
      const changes = [
        ...(previous.name !== sheet.name
          ? [`renamed from “${previous.name}”`]
          : []),
        ...(previous.content !== sheet.content ? ['edited'] : [])
      ];
      return changes.length
        ? [{ id: sheet.id, name: sheet.name, changes }]
        : [];
    })
  };

  const properties: SaveStateDiff['properties'] = [];
  if (before.name !== after.name)
    properties.push({ field: 'name', before: before.name, after: after.name });
  if (before.units !== after.units)
    properties.push({
      field: 'units',
      before: String(before.units),
      after: String(after.units)
    });

  const empty = (entry: SaveStateDiffGroup) =>
    !entry.added.length && !entry.removed.length && !entry.changed.length;
  return {
    features: { ...features, reordered },
    sketches,
    bodies,
    parameters,
    drawingSheets,
    properties,
    identical:
      empty(features) &&
      !reordered &&
      empty(sketches) &&
      empty(bodies) &&
      parameters.length === 0 &&
      empty(drawingSheets) &&
      properties.length === 0
  };
}
