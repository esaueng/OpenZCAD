import { deleteFeature, listFeaturesInOrder } from '@openzcad/document-core';
import type {
  DocumentNode,
  FeatureNode,
  FeatureWarning,
  ProjectDocument
} from '@openzcad/shared';
import {
  DIRECT_EDIT_FIXTURE_FORMAT,
  DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
  type DirectEditFixture
} from './directEditFixture';
import { splitRefusal } from './featureValidation';
import { createProjectDiagnosticBundle } from './projectDiagnostics';

/**
 * "Save reproduction": a refused feature build as a corpus fixture.
 *
 * The user asks for it, from a refusal's details, and gets a local file —
 * nothing uploads. The file is an `openzcad-direct-edit-fixture` with the
 * `feature-build` op, so it can be dropped into
 * `test/direct-edit-corpus/fixtures/` and replayed unchanged.
 *
 * What it keeps is what a rebuild reads: feature history up to and including
 * the refused feature, parameters (their names are expression identifiers)
 * and sketch geometry. What it strips on top of the project diagnostic
 * sanitizer: every feature after the refused one, the command log, the
 * project name, every project/part/body/feature/sketch name (replaced by
 * neutral labels, so the refusal text names nothing of the user's),
 * parameter descriptions and branch provenance.
 */
export const REPRODUCTION_DOCUMENT_NAME = 'Reproduction';

export interface RefusalReproductionInput {
  /** The candidate document whose rebuild refused; contains the feature. */
  document: ProjectDocument;
  warning: FeatureWarning;
  kernel: { adapter: 'remus'; packageVersion: string; sourceCommit: string };
  capturedAt?: string;
}

function findFeature(
  document: ProjectDocument,
  featureId: string
): FeatureNode | undefined {
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature' && node.featureId === featureId) return node;
  }
  return undefined;
}

/**
 * Removes every feature after `featureId`, last first, so nothing deleted is
 * still depended on. A delete the document refuses stops the trim there: a
 * longer prefix still reproduces, a broken document would not.
 */
export function trimAfterFeature(
  document: ProjectDocument,
  featureId: string
): ProjectDocument {
  const ordered = listFeaturesInOrder(document);
  const index = ordered.findIndex((feature) => feature.featureId === featureId);
  if (index < 0) return document;
  let trimmed = document;
  for (const later of ordered.slice(index + 1).reverse()) {
    try {
      trimmed = deleteFeature(trimmed, { featureId: later.featureId });
    } catch {
      break;
    }
  }
  return trimmed;
}

/** Neutral, unique replacement names, keyed by node id. */
function neutralNames(document: ProjectDocument): Map<string, string> {
  const names = new Map<string, string>();
  const counters = new Map<string, number>();
  const next = (label: string) => {
    const count = (counters.get(label) ?? 0) + 1;
    counters.set(label, count);
    return `${label} ${count}`;
  };
  const byKind = (kind: DocumentNode['kind']) =>
    Object.values(document.nodes).filter((node) => node.kind === kind);
  for (const feature of listFeaturesInOrder(document))
    names.set(feature.id, next(feature.data.featureKind));
  for (const node of byKind('feature'))
    if (!names.has(node.id) && node.kind === 'feature')
      names.set(node.id, next(node.data.featureKind));
  const bodies = byKind('body');
  const bodyRank = (node: DocumentNode) => {
    const rank =
      node.kind === 'body'
        ? document.bodyOrder.indexOf(node.bodyId)
        : Number.MAX_SAFE_INTEGER;
    return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
  };
  for (const body of [...bodies].sort((a, b) => bodyRank(a) - bodyRank(b)))
    names.set(body.id, next('Body'));
  for (const node of byKind('sketch')) names.set(node.id, next('Sketch'));
  for (const node of byKind('sketch-object'))
    names.set(node.id, next('Sketch object'));
  for (const node of byKind('part')) names.set(node.id, next('Part'));
  for (const node of byKind('assembly')) names.set(node.id, next('Assembly'));
  for (const node of byKind('project'))
    names.set(node.id, REPRODUCTION_DOCUMENT_NAME);
  return names;
}

/** Replace names literally, longest first, without reprocessing neutral labels. */
function renameInText(
  text: string,
  renames: ReadonlyArray<readonly [string, string]>
): string {
  const replacements = new Map<string, string>();
  for (const [name, neutral] of renames)
    if (name.length > 0 && !replacements.has(name))
      replacements.set(name, neutral);
  const names = [...replacements.keys()].sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const pattern = new RegExp(
    names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g'
  );
  return text.replace(pattern, (name) => replacements.get(name)!);
}

function sanitizedReproductionDocument(
  candidate: ProjectDocument,
  featureId: string,
  kernel: RefusalReproductionInput['kernel']
): {
  document: ProjectDocument;
  renames: Array<readonly [string, string]>;
} | null {
  if (candidate.shaprImportOrder.length > 0) return null;
  const trimmed = trimAfterFeature(candidate, featureId);
  let sanitized: ProjectDocument;
  try {
    sanitized = createProjectDiagnosticBundle(trimmed, {
      remusVersion: kernel.packageVersion,
      remusCommit: kernel.sourceCommit
    }).document;
  } catch {
    // Imported STEP/mesh source metadata is not sanitized here.
    return null;
  }
  const names = neutralNames(sanitized);
  const renames: Array<readonly [string, string]> = [];
  const nodes: Record<string, DocumentNode> = {};
  for (const [id, node] of Object.entries(sanitized.nodes)) {
    const name = names.get(id);
    const renamed = { ...node };
    if (name !== undefined) {
      renames.push([node.name, name]);
      renamed.name = name;
    }
    if (renamed.kind === 'parameter') delete renamed.description;
    nodes[id] = renamed;
  }
  renames.push([candidate.name, REPRODUCTION_DOCUMENT_NAME]);
  // Longest first, so a name that contains another is replaced whole.
  renames.sort((a, b) => b[0].length - a[0].length);
  const document: ProjectDocument = {
    ...sanitized,
    name: REPRODUCTION_DOCUMENT_NAME,
    nodes,
    commandLog: [],
    shaprImports: {},
    shaprImportOrder: []
  };
  delete document.branchedFrom;
  return { document, renames };
}

/** `2026-09-01T12:34:56.789Z` -> `20260901123456789`. */
function timestampSlug(capturedAt: string): string {
  const digits = capturedAt.replace(/\D/g, '');
  return digits.length > 0 ? digits : String(Date.now());
}

function lineageOf(feature: FeatureNode): 'semantic' | 'hash-only' {
  const data = feature.data;
  if (data.featureKind === 'direct-edit') {
    const operation = data.operation as {
      faceHash?: unknown;
      faceReference?: unknown;
    };
    return operation.faceHash === undefined || operation.faceReference
      ? 'semantic'
      : 'hash-only';
  }
  if (data.featureKind === 'fillet' || data.featureKind === 'chamfer') {
    const references = (data as { edgeReferences?: unknown[] }).edgeReferences;
    return references && references.length > 0 ? 'semantic' : 'hash-only';
  }
  return 'semantic';
}

/**
 * Pure. Throws only when the warning names no feature in the document; an
 * imported document still produces a fixture, with its document omitted.
 */
export function buildRefusalReproduction(
  input: RefusalReproductionInput
): DirectEditFixture {
  const { warning, kernel } = input;
  const feature = findFeature(input.document, warning.featureId);
  if (!feature) {
    throw new Error('The refused feature is not in this document.');
  }
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const sanitized = sanitizedReproductionDocument(
    input.document,
    warning.featureId,
    kernel
  );
  const reason =
    warning.message.replace(/^Feature "[^"]+":\s*/, '').trim() ||
    'This operation does not produce valid geometry.';
  // Include trimmed features and omitted imported models: their names can
  // still occur in the refusing feature's sentence or kernel details.
  const names = neutralNames(input.document);
  const renames: Array<readonly [string, string]> = [
    ...(sanitized?.renames ?? []),
    ...Object.values(input.document.nodes).flatMap((node) => {
      const neutral = names.get(node.id);
      return neutral === undefined ? [] : [[node.name, neutral] as const];
    })
  ];
  renames.push([input.document.name, REPRODUCTION_DOCUMENT_NAME]);
  const plain = splitRefusal(
    renameInText(reason, renames),
    warning.kernelRefusal?.category
  );
  const upstream = listFeaturesInOrder(input.document);
  const position = upstream.findIndex(
    (entry) => entry.featureId === warning.featureId
  );
  const data = feature.data;
  const targetBodyId =
    'targetBodyId' in data && typeof data.targetBodyId === 'string'
      ? data.targetBodyId
      : (feature.bodyId ?? '');
  const featureKind = data.featureKind;
  return {
    format: DIRECT_EDIT_FIXTURE_FORMAT,
    formatVersion: DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
    name: `feature-build-refused-${featureKind}-${timestampSlug(capturedAt)}`,
    capturedAt,
    origin: 'captured',
    kernel: { ...kernel },
    ...(sanitized
      ? { document: sanitized.document }
      : { document: null, documentOmitted: 'imported-source' as const }),
    edit: {
      op: 'feature-build',
      targetBodyId,
      value: 0,
      featureId: warning.featureId,
      featureKind,
      ...(data.featureKind === 'direct-edit'
        ? { operationKind: data.operation.kind }
        : {})
    },
    observed: {
      outcome: 'refused',
      message: plain.message,
      ...(plain.detail ? { detail: plain.detail } : {}),
      lineage: lineageOf(feature),
      producingFeatureKind: featureKind,
      upstreamFeatureKinds: upstream
        .slice(0, position < 0 ? 0 : position)
        .map((entry) => entry.data.featureKind),
      documentVersion: input.document.version,
      warningKind: warning.kind,
      ...(warning.kernelRefusal
        ? { kernelRefusal: { ...warning.kernelRefusal } }
        : {})
    }
  };
}

/** The file a reproduction downloads as; the corpus needs stem === name. */
export function reproductionFileName(fixture: DirectEditFixture): string {
  return `${fixture.name}.json`;
}
