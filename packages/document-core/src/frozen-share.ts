import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  toArtifactId,
  type ProjectDocument
} from '@openzcad/shared';
import { createProjectDocument, importStepBody } from './index';
import { sharedProjectSnapshotDocument } from './shared-snapshot';

/**
 * A share link without history (L08) serves a document of its own: the
 * model as it stood when the owner made (or last updated) the link, each
 * body one imported exact solid, and nothing of how it was built. No
 * feature, sketch, parameter, save state or import source of the owner's
 * project is in it, so none of them can reach a visitor.
 *
 * The owner's browser builds it (`frozenShareDocument`) from one STEP per
 * shown body; the Worker stores and serves only a document that passes
 * `frozenShareDocumentProblem`, so a client that sent the real project by
 * mistake is refused rather than published.
 */

/** On the project node: this document is a model shared without history. */
export const SHARED_WITHOUT_HISTORY_METADATA_KEY =
  'sharedWithoutHistory' as const;

/**
 * On the project node, beside {@link SHARED_WITHOUT_HISTORY_METADATA_KEY}:
 * the model is shared with its parameters, for a visitor to tweak, rather
 * than as imported solids (`tweakableShareDocument`).
 */
export const SHARED_PARAMETERS_METADATA_KEY = 'sharedParameters' as const;

/**
 * On a body of a frozen model: the owner had it hidden when sharing, so a
 * visitor's view (and the first view of their copy) starts with it hidden.
 * Visibility is otherwise this device's view state, never the document's;
 * the mark is only where that view starts.
 */
export const BODY_INITIALLY_HIDDEN_METADATA_KEY = 'initiallyHidden' as const;

/** One body of the frozen model. */
export interface FrozenShareBody {
  name: string;
  /** The body alone, as STEP text. */
  stepText: string;
  /** A colour someone chose for it; null when it is drawn in the default. */
  color: string | null;
  opacity: number | null;
  /** The owner had it hidden: it is shared, but starts hidden. */
  hidden?: boolean;
}

/** The document a link without history serves for `source`. */
export function frozenShareDocument(
  source: Pick<ProjectDocument, 'projectId' | 'name' | 'units' | 'ownerUserId'>,
  bodies: readonly FrozenShareBody[]
): ProjectDocument {
  if (bodies.length === 0)
    throw new Error('This project has no solid body to share.');
  let document = createProjectDocument(
    source.name,
    source.ownerUserId,
    source.units
  );
  // A link serves its own project's id; the visitor checks the two agree.
  document.projectId = source.projectId;
  const root = document.nodes[document.rootNodeId];
  if (root?.kind !== 'project') throw new Error('The project node is missing.');
  root.projectId = source.projectId;
  root.metadata = { [SHARED_WITHOUT_HISTORY_METADATA_KEY]: true };
  bodies.forEach((body, index) => {
    const imported = importStepBody(document, {
      name: body.name,
      artifactId: toArtifactId(`artifact_local_frozen_${index + 1}`),
      sourceName: `${body.name}.step`,
      stepText: body.stepText
    });
    document = imported.document;
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'body' && entry.bodyId === imported.bodyId
    );
    if (!node) return;
    const metadata = { ...node.metadata };
    if (body.color !== null) {
      metadata[BODY_COLOR_METADATA_KEY] = body.color;
      metadata[BODY_COLOR_CHOSEN_METADATA_KEY] = true;
    }
    if (body.opacity !== null)
      metadata[BODY_OPACITY_METADATA_KEY] = body.opacity;
    if (body.hidden) metadata[BODY_INITIALLY_HIDDEN_METADATA_KEY] = true;
    node.metadata = metadata;
  });
  return sharedProjectSnapshotDocument(document);
}

/** Whether `document` is a model shared without its history. */
export function isSharedWithoutHistory(
  document: Pick<ProjectDocument, 'nodes' | 'rootNodeId'>
): boolean {
  return (
    document.nodes[document.rootNodeId]?.metadata?.[
      SHARED_WITHOUT_HISTORY_METADATA_KEY
    ] === true
  );
}

/** The bodies `document` asks a first view to start with hidden. */
export function initiallyHiddenBodyIds(
  document: Pick<ProjectDocument, 'nodes'>
): string[] {
  return Object.values(document.nodes).flatMap((node) =>
    node.kind === 'body' &&
    node.metadata?.[BODY_INITIALLY_HIDDEN_METADATA_KEY] === true
      ? [node.bodyId]
      : []
  );
}

/** A visitor's own copy is an ordinary project: the mark stays behind. */
export function withoutSharedHistoryMark(
  document: ProjectDocument
): ProjectDocument {
  const root = document.nodes[document.rootNodeId];
  if (!root || !isSharedWithoutHistory(document)) return document;
  const {
    [SHARED_WITHOUT_HISTORY_METADATA_KEY]: _mark,
    [SHARED_PARAMETERS_METADATA_KEY]: _parameters,
    ...metadata
  } = root.metadata ?? {};
  const { metadata: _metadata, ...bare } = root;
  return {
    ...document,
    nodes: {
      ...document.nodes,
      [root.id]: Object.keys(metadata).length ? { ...bare, metadata } : bare
    }
  };
}

const DOCUMENT_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'ownerUserId',
  'rootNodeId',
  'rootAssemblyId',
  'activePartId',
  'name',
  'units',
  'version',
  'nodes',
  'featureOrder',
  'bodyOrder',
  'sketchOrder',
  'parameterOrder',
  'revisions',
  'checkpoints',
  'commandLog',
  'assets',
  'shaprImports',
  'shaprImportOrder',
  'derived'
]);
const BASE_NODE_KEYS = ['id', 'kind', 'name', 'parentId', 'revisionId'];
const NODE_KEYS: Record<string, ReadonlySet<string>> = {
  project: new Set([
    ...BASE_NODE_KEYS,
    'metadata',
    'projectId',
    'units',
    'activePartId'
  ]),
  assembly: new Set([...BASE_NODE_KEYS, 'childIds']),
  part: new Set([...BASE_NODE_KEYS, 'childIds']),
  feature: new Set([
    ...BASE_NODE_KEYS,
    'featureId',
    'bodyId',
    'featureKind',
    'data'
  ]),
  body: new Set([
    ...BASE_NODE_KEYS,
    'metadata',
    'bodyId',
    'featureId',
    'bodyType',
    'representationSource',
    'exportableStep'
  ])
};
const FEATURE_DATA_KEYS = new Set([
  'featureKind',
  'artifactId',
  'sourceName',
  'stepText'
]);
const BODY_METADATA_KEYS = new Set<string>([
  BODY_COLOR_METADATA_KEY,
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_OPACITY_METADATA_KEY,
  BODY_INITIALLY_HIDDEN_METADATA_KEY
]);

/** Absent, or exactly `true`: a hidden mark never carries a value. */
function hiddenMarkOnly(metadata: object | undefined): boolean {
  const mark: unknown = (metadata as Record<string, unknown> | undefined)?.[
    BODY_INITIALLY_HIDDEN_METADATA_KEY
  ];
  return mark === undefined || mark === true;
}

function onlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function emptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function emptyRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * Why `document` may not be served by a link without history, or null when
 * it holds imported solids and nothing else. An allowlist on purpose: a
 * field this build does not know is refused, never passed through.
 */
export function frozenShareDocumentProblem(
  document: ProjectDocument
): string | null {
  if (isTweakableWithoutHistory(document))
    return tweakableShareDocumentProblem(document);
  if (!onlyKeys(document, DOCUMENT_KEYS))
    return 'It carries more than the finished model.';
  if (!isSharedWithoutHistory(document))
    return 'It is not marked as shared without history.';
  if (
    !emptyList(document.sketchOrder) ||
    !emptyList(document.parameterOrder) ||
    !emptyList(document.revisions) ||
    !emptyList(document.checkpoints) ||
    !emptyList(document.commandLog) ||
    !emptyList(document.shaprImportOrder) ||
    !emptyRecord(document.assets) ||
    !emptyRecord(document.shaprImports)
  )
    return 'It carries sketches, parameters or history.';
  let features = 0;
  for (const node of Object.values(document.nodes)) {
    const allowed = NODE_KEYS[node.kind];
    if (!allowed || !onlyKeys(node, allowed))
      return 'It holds something other than imported solids.';
    if (node.kind === 'project') {
      if (
        !onlyKeys(
          node.metadata ?? {},
          new Set([SHARED_WITHOUT_HISTORY_METADATA_KEY])
        )
      )
        return 'It holds something other than imported solids.';
    } else if (node.kind === 'feature') {
      const data = node.data as unknown as Record<string, unknown>;
      if (
        node.featureKind !== 'imported-step' ||
        data.featureKind !== 'imported-step' ||
        typeof data.stepText !== 'string' ||
        !onlyKeys(data, FEATURE_DATA_KEYS)
      )
        return 'It holds a feature other than an imported solid.';
      features += 1;
    } else if (node.kind === 'body') {
      if (
        node.bodyType !== 'solid' ||
        node.representationSource !== 'step-import' ||
        !onlyKeys(node.metadata ?? {}, BODY_METADATA_KEYS) ||
        // A mark, never a value that could carry anything else.
        !hiddenMarkOnly(node.metadata)
      )
        return 'It holds a body other than an imported solid.';
    }
  }
  if (features === 0 || features !== document.featureOrder.length)
    return 'It has no solid body.';
  return null;
}

/**
 * A link without history that may be tweaked serves the model's recipe, as
 * a tweak needs it rebuilt in the visitor's browser: its features, sketches
 * and parameters, but no save state, undo history or command log (the share
 * projection already drops those), no import source, drawing or reference
 * picture, and no name a feature or sketch was given. The visitor sees the
 * parameters and the bodies, never the feature list, and a copy they make
 * keeps the solids only (`frozenShareDocument`).
 *
 * Unlike the imported solids of a view-only link, the recipe is in the
 * visitor's browser: this hides how the model was built from the page, it
 * does not keep it from someone who reads the document itself.
 */
export function tweakableShareDocument(
  source: ProjectDocument,
  /** The bodies the owner hid: shared, but starting hidden. */
  hiddenBodyIds: ReadonlySet<string> = new Set()
): ProjectDocument {
  const {
    drawings: _drawings,
    shareLinkSheetIds: _sheets,
    ...shared
  } = sharedProjectSnapshotDocument(source);
  const document: ProjectDocument = structuredClone({
    ...shared,
    shaprImports: {},
    shaprImportOrder: []
  });
  if (document.featureOrder.length === 0)
    throw new Error('This model has no feature to share.');
  // An imported file is its own source: its text names the file, its
  // author and the system that wrote it, and a stored one is not served to
  // such a link at all. A model built on one shares view only.
  if (
    !emptyRecord(document.assets) ||
    carriesStoredSource(document.nodes) ||
    Object.values(document.nodes).some(isImportedFeature)
  )
    throw new Error(
      'This model uses an imported file, which a link without history cannot carry with its parameters. Share it view only, or include history.'
    );
  // Rebuild warnings name features as the owner named them, and the time
  // says when the owner last worked on it: the visitor's rebuild says its own.
  document.derived = {
    bodyRepresentations: {},
    exportableBodyIds: [],
    warnings: [],
    updatedAt: new Date(0).toISOString()
  };
  const root = document.nodes[document.rootNodeId];
  if (root?.kind !== 'project') throw new Error('The project node is missing.');
  root.metadata = {
    ...root.metadata,
    [SHARED_WITHOUT_HISTORY_METADATA_KEY]: true,
    [SHARED_PARAMETERS_METADATA_KEY]: true
  };
  // The names an owner gave say how the model was built; the visitor gets
  // numbered ones, in model order.
  document.featureOrder.forEach((featureId, index) => {
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'feature' && entry.featureId === featureId
    );
    if (node?.kind === 'feature') node.name = `Feature ${index + 1}`;
  });
  for (const node of Object.values(document.nodes))
    if (node.kind === 'body') {
      const { [BODY_INITIALLY_HIDDEN_METADATA_KEY]: _mark, ...metadata } =
        node.metadata ?? {};
      if (hiddenBodyIds.has(node.bodyId))
        metadata[BODY_INITIALLY_HIDDEN_METADATA_KEY] = true;
      if (Object.keys(metadata).length) node.metadata = metadata;
      else delete node.metadata;
    }
  document.sketchOrder.forEach((sketchId, index) => {
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'sketch' && entry.sketchId === sketchId
    );
    if (node) node.name = `Sketch ${index + 1}`;
  });
  return document;
}

/** Whether `document` is a model shared without history, for tweaking. */
export function isTweakableWithoutHistory(
  document: Pick<ProjectDocument, 'nodes' | 'rootNodeId'>
): boolean {
  const metadata = document.nodes[document.rootNodeId]?.metadata;
  return (
    metadata?.[SHARED_WITHOUT_HISTORY_METADATA_KEY] === true &&
    metadata[SHARED_PARAMETERS_METADATA_KEY] === true
  );
}

const TWEAKABLE_DOCUMENT_KEYS = new Set([
  ...DOCUMENT_KEYS,
  'objectFolders',
  'pmi',
  'assembly',
  'printClearance',
  'configurations',
  'displayUnits'
]);

function isImportedFeature(node: ProjectDocument['nodes'][string]): boolean {
  return node.kind === 'feature' && node.featureKind.startsWith('imported-');
}

const DERIVED_KEYS = new Set([
  'bodyRepresentations',
  'exportableBodyIds',
  'warnings',
  'updatedAt'
]);

function carriesStoredSource(nodes: ProjectDocument['nodes']): boolean {
  const text = JSON.stringify(nodes);
  return text.includes('"stepSourceRef"') || text.includes('"meshPayloadRef"');
}

/**
 * Why `document` may not be served by a tweakable link without history, or
 * null when it is a recipe `tweakableShareDocument` could have built: no
 * history, owner, import source or owner-given feature or sketch name.
 */
export function tweakableShareDocumentProblem(
  document: ProjectDocument
): string | null {
  if (!onlyKeys(document, TWEAKABLE_DOCUMENT_KEYS))
    return 'It carries more than the model and its parameters.';
  if (!isTweakableWithoutHistory(document))
    return 'It is not marked as shared without history.';
  if (document.ownerUserId !== 'user_shared') return 'It names its owner.';
  if (
    !emptyList(document.revisions) ||
    !emptyList(document.checkpoints) ||
    !emptyList(document.commandLog) ||
    !emptyList(document.shaprImportOrder) ||
    !emptyRecord(document.shaprImports)
  )
    return 'It carries history.';
  if (!emptyRecord(document.assets) || carriesStoredSource(document.nodes))
    return 'It carries an import source.';
  if (
    !onlyKeys(document.derived, DERIVED_KEYS) ||
    !emptyRecord(document.derived.bodyRepresentations) ||
    !emptyList(document.derived.exportableBodyIds) ||
    !emptyList(document.derived.warnings)
  )
    return 'It carries the owner\u2019s rebuild results.';
  if (document.featureOrder.length === 0) return 'It has no feature.';
  for (const node of Object.values(document.nodes)) {
    if (isImportedFeature(node)) return 'It carries an imported file.';
    if (node.kind === 'feature' && !/^Feature \d+$/.test(node.name))
      return 'It names how the model was built.';
    if (node.kind === 'sketch' && !/^Sketch \d+$/.test(node.name))
      return 'It names how the model was built.';
  }
  return null;
}
