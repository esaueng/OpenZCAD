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

/** One body of the frozen model. */
export interface FrozenShareBody {
  name: string;
  /** The body alone, as STEP text. */
  stepText: string;
  /** A colour someone chose for it; null when it is drawn in the default. */
  color: string | null;
  opacity: number | null;
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

/** A visitor's own copy is an ordinary project: the mark stays behind. */
export function withoutSharedHistoryMark(
  document: ProjectDocument
): ProjectDocument {
  const root = document.nodes[document.rootNodeId];
  if (!root || !isSharedWithoutHistory(document)) return document;
  const { [SHARED_WITHOUT_HISTORY_METADATA_KEY]: _mark, ...metadata } =
    root.metadata ?? {};
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
  BODY_OPACITY_METADATA_KEY
]);

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
        !onlyKeys(node.metadata ?? {}, BODY_METADATA_KEYS)
      )
        return 'It holds a body other than an imported solid.';
    }
  }
  if (features === 0 || features !== document.featureOrder.length)
    return 'It has no solid body.';
  return null;
}
