import type { EditAnalysisRequest } from '@openzcad/shared';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  listFeaturesInOrder,
  numberedFeatureName
} from '@openzcad/document-core';
import {
  isLocalBodyRef,
  normalizeLocalId,
  type CadPatchOperation,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import type {
  BodyId,
  BodyRepresentation,
  FeatureId,
  ProjectDocument
} from '@openzcad/shared';
import { isFeatureSuppressed } from '@openzcad/shared';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { validatedFeatureRejection } from './featureValidation';
import { exactWarningBaseline, newExactWarnings } from './exactWarnings';

export interface ExactPatchTarget {
  featureName: string;
  resultBodyId: BodyId;
}

export interface ExactPatchPreflight {
  commands: AnyCommand[];
  candidate: ProjectDocument;
  targets: ExactPatchTarget[];
}

function commandRecord(command: AnyCommand): Record<string, unknown> | null {
  return command.payload && typeof command.payload === 'object'
    ? (command.payload as unknown as Record<string, unknown>)
    : null;
}

/** Result bodies whose survival must be proved by exact preflight. */
export function exactPatchTargets(
  commands: readonly AnyCommand[]
): ExactPatchTarget[] {
  return commands.flatMap((command) => {
    if (command.commands) return exactPatchTargets(command.commands);
    const payload = commandRecord(command);
    if (!payload) {
      return [];
    }
    const ids =
      payload.ids && typeof payload.ids === 'object'
        ? (payload.ids as Record<string, unknown>)
        : null;
    const featureName =
      typeof payload.name === 'string' ? payload.name : command.label;
    // A split mints two result bodies; both halves must survive the build.
    return [ids?.bodyId ?? payload.targetBodyId, ids?.secondBodyId].flatMap(
      (bodyId) =>
        typeof bodyId === 'string'
          ? [{ featureName, resultBodyId: bodyId as BodyId }]
          : []
    );
  });
}

/** Datums explicitly authored by this patch, including an unchanged update. */
function authoredDatumIds(
  commands: readonly AnyCommand[],
  candidate: ProjectDocument
): Set<FeatureId> {
  const datums = new Set(
    listFeaturesInOrder(candidate)
      .filter(
        (feature) =>
          feature.data.featureKind === 'datum-plane' ||
          feature.data.featureKind === 'datum-axis'
      )
      .map((feature) => feature.featureId)
  );
  const authored = new Set<FeatureId>();
  for (const command of commands) {
    if (command.commands) {
      for (const id of authoredDatumIds(command.commands, candidate))
        authored.add(id);
      continue;
    }
    const payload = commandRecord(command);
    const ids = payload?.ids as { featureId?: unknown } | undefined;
    const id =
      command.kind === 'feature.update'
        ? payload?.featureId
        : command.kind === 'feature.datum-plane' ||
            command.kind === 'feature.datum-axis'
          ? ids?.featureId
          : undefined;
    if (typeof id === 'string' && datums.has(id as FeatureId))
      authored.add(id as FeatureId);
  }
  return authored;
}

/**
 * A datum has no result body. Its own published frame/axis must prove the
 * operation succeeded, even when its exact failure already existed before
 * this proposal. Preserve previously resolved active downstream datums as
 * well, using the candidate graph so deliberately removed consumers do not
 * become expected results.
 */
async function datumPatchTargets(
  base: ProjectDocument,
  candidate: ProjectDocument,
  derived: ProjectDocument['derived'],
  commands: readonly AnyCommand[]
): Promise<ExactPatchTarget[]> {
  const authored = authoredDatumIds(commands, candidate);
  const before = new Set(
    listFeaturesInOrder(base).map((feature) => feature.featureId)
  );
  const active = listFeaturesInOrder(candidate).filter(
    (feature) =>
      (feature.data.featureKind === 'datum-plane' ||
        feature.data.featureKind === 'datum-axis') &&
      !isFeatureSuppressed(feature)
  );
  for (const feature of active)
    if (!before.has(feature.featureId)) authored.add(feature.featureId);
  if (authored.size === 0) return [];
  const { downstreamDatumIds, requireResolvedDatum } =
    await import('./datumPlanes');
  const required = new Set(authored);
  for (const id of authored)
    for (const downstream of downstreamDatumIds(candidate, id))
      if (
        base.derived.datumFrames?.[downstream] ||
        base.derived.datumAxes?.[downstream]
      )
        required.add(downstream);
  for (const feature of active.filter((item) => required.has(item.featureId)))
    requireResolvedDatum(
      derived,
      feature.featureId,
      feature.name,
      feature.data.featureKind === 'datum-axis' ? 'datum-axis' : 'datum-plane'
    );

  const targets = [...authored].flatMap((id) =>
    affectedFeatureTargets(candidate, id)
  );
  const seen = new Set<string>();
  return targets.flatMap((target) => {
    const key = `${target.featureId}:${target.resultBodyId}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const rejection = validatedFeatureRejection({
      featureName: target.featureName,
      featureId: target.featureId,
      bodyPresent: Boolean(derived.bodyRepresentations[target.resultBodyId]),
      warnings: derived.warnings,
      ...(derived.featureWarnings
        ? { featureWarnings: derived.featureWarnings }
        : {}),
      documentMoved: false
    });
    if (rejection)
      throw new Error(`Feature "${target.featureName}": ${rejection.message}`);
    return [
      { featureName: target.featureName, resultBodyId: target.resultBodyId }
    ];
  });
}

function exactWarningsError(warnings: readonly string[]): Error {
  return new Error(
    warnings.length === 1
      ? warnings[0]
      : `Exact geometry preflight failed:\n${warnings
          .map((warning) => `- ${warning}`)
          .join('\n')}`
  );
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/**
 * The body's exact identity: its ADR-011 face and edge fingerprints, ordered
 * so the answer does not depend on the order the kernel happened to publish
 * them in. Each hash covers the surface or curve kind, its analytic
 * parameters and its quantized position, so two bodies that agree here agree
 * on every exact surface they carry.
 *
 * Null for a body that publishes no exact topology — an imported mesh, whose
 * stored triangles are the geometry rather than a projection of it.
 */
function exactIdentity(body: BodyRepresentation): string | null {
  if (!body.topology) {
    return null;
  }
  const hashes = (values: readonly { hash: number }[]) =>
    values.map((entry) => entry.hash).sort((left, right) => left - right);
  return JSON.stringify({
    faces: hashes(body.topology.faces),
    edges: hashes(body.topology.edges)
  });
}

function assertPreservedGeometry(
  base: ProjectDocument['derived'],
  candidate: ProjectDocument['derived']
): void {
  const baseIds = sortedStrings(Object.keys(base.bodyRepresentations));
  const candidateIds = sortedStrings(
    Object.keys(candidate.bodyRepresentations)
  );
  if (
    baseIds.length !== candidateIds.length ||
    baseIds.some((bodyId, index) => bodyId !== candidateIds[index])
  ) {
    throw new Error(
      'Auto-parameterization changed the exact body inventory; nothing was applied.'
    );
  }
  const baseExportable = sortedStrings(base.exportableBodyIds);
  const candidateExportable = sortedStrings(candidate.exportableBodyIds);
  if (
    baseExportable.length !== candidateExportable.length ||
    baseExportable.some(
      (bodyId, index) => bodyId !== candidateExportable[index]
    )
  ) {
    throw new Error(
      'Auto-parameterization changed which bodies are exportable; nothing was applied.'
    );
  }

  for (const bodyId of baseIds) {
    const before = base.bodyRepresentations[bodyId as BodyId]!;
    const after = candidate.bodyRepresentations[bodyId as BodyId]!;
    const span = Math.max(
      before.bbox.max.x - before.bbox.min.x,
      before.bbox.max.y - before.bbox.min.y,
      before.bbox.max.z - before.bbox.min.z,
      1
    );
    const linearTolerance = span * 1e-9;
    const volumeTolerance = Math.max(Math.abs(before.volume), 1) * 1e-9;
    const close = (left: number, right: number, tolerance: number) =>
      Math.abs(left - right) <= tolerance;
    const bboxBefore = [
      before.bbox.min.x,
      before.bbox.min.y,
      before.bbox.min.z,
      before.bbox.max.x,
      before.bbox.max.y,
      before.bbox.max.z
    ];
    const bboxAfter = [
      after.bbox.min.x,
      after.bbox.min.y,
      after.bbox.min.z,
      after.bbox.max.x,
      after.bbox.max.y,
      after.bbox.max.z
    ];
    const beforeIdentity = exactIdentity(before);
    const afterIdentity = exactIdentity(after);
    // The display mesh is a disposable projection, not geometry, and it is
    // not a function of the solid alone: the same B-Rep tessellates to the
    // same faces, the same face order and the same triangle counts, but with
    // the triangle vertices arranged differently, depending on whether the
    // kernel replayed the body from a history checkpoint or rebuilt the whole
    // document. Comparing those buffers float by float therefore failed every
    // parameterization proposed right after a direct edit — the base was the
    // replayed build and the candidate a full rebuild — while the identical
    // document reloaded from storage passed. Preservation is proved from the
    // exact quantities instead. The mesh still stands in for a body with no
    // exact topology to compare, where the stored triangles ARE the geometry.
    const meshChanged =
      beforeIdentity !== null || afterIdentity !== null
        ? false
        : before.mesh.vertices.length !== after.mesh.vertices.length ||
          before.mesh.indices.length !== after.mesh.indices.length ||
          before.mesh.vertices.some(
            (value, index) =>
              !close(value, after.mesh.vertices[index]!, linearTolerance)
          ) ||
          before.mesh.indices.some(
            (value, index) => value !== after.mesh.indices[index]
          );
    if (
      before.consumed !== after.consumed ||
      before.faceCount !== after.faceCount ||
      beforeIdentity !== afterIdentity ||
      !close(before.volume, after.volume, volumeTolerance) ||
      bboxBefore.some(
        (value, index) => !close(value, bboxAfter[index]!, linearTolerance)
      ) ||
      meshChanged
    ) {
      throw new Error(
        `Auto-parameterization changed the exact geometry of ${before.name}; nothing was applied.`
      );
    }
  }
}

type StagedEdgeModifier = Extract<
  CadPatchOperation,
  { kind: 'add_edge_modifier' }
> & { edgeSelector: 'all-feature-edges' | 'circular-rims' };

function stagedEdgeModifier(
  proposal: CadPatchProposal
): { index: number; operation: StagedEdgeModifier } | null {
  const staged = proposal.operations.flatMap((operation, index) =>
    operation.kind === 'add_edge_modifier' && operation.edgeSelector
      ? [{ index, operation: operation as StagedEdgeModifier }]
      : []
  );
  if (staged.length === 0) {
    return null;
  }
  if (
    staged.length > 1 ||
    staged[0]!.index !== proposal.operations.length - 1
  ) {
    throw new Error(
      "An exact staged edge modifier must be the proposal's single final operation."
    );
  }
  return staged[0]!;
}

function declaredResultBodyId(
  proposal: CadPatchProposal,
  commands: readonly AnyCommand[],
  reference: string
): BodyId {
  if (!isLocalBodyRef(reference)) {
    throw new Error('An exact staged edge selector requires a local body.');
  }
  const alias = normalizeLocalId(reference);
  const declarationIndex = proposal.operations.findIndex((operation) => {
    const localId = 'localId' in operation ? operation.localId : null;
    return typeof localId === 'string' && normalizeLocalId(localId) === alias;
  });
  const payload =
    declarationIndex >= 0 ? commandRecord(commands[declarationIndex]!) : null;
  const ids =
    payload?.ids && typeof payload.ids === 'object'
      ? (payload.ids as Record<string, unknown>)
      : null;
  if (typeof ids?.bodyId !== 'string') {
    throw new Error(
      `The staged edge target ${reference} does not name an earlier result body.`
    );
  }
  return ids.bodyId as BodyId;
}

function selectedExactEdges(
  candidate: ProjectDocument,
  bodyId: BodyId,
  operation: StagedEdgeModifier
) {
  const body = candidate.derived.bodyRepresentations[bodyId];
  if (body?.consumed) {
    throw new Error(
      `${operation.name} cannot modify a body consumed by the staged prefix.`
    );
  }
  if (!body?.topology) {
    throw new Error(
      `${operation.name} could not inspect exact topology for its staged target body.`
    );
  }
  const selected = body.topology.edges.filter((edge) => {
    if (edge.displayRole === 'seam' || !edge.reference) {
      return false;
    }
    return operation.edgeSelector === 'all-feature-edges'
      ? true
      : edge.curve?.type === 'CIRCLE' &&
          edge.vertexIds?.length === 2 &&
          edge.vertexIds?.[0] === edge.vertexIds?.[1];
  });
  if (selected.length === 0) {
    throw new Error(
      operation.edgeSelector === 'circular-rims'
        ? `${operation.name} found no exact closed circular rim edges on its staged target.`
        : `${operation.name} found no exact physical feature edges on its staged target.`
    );
  }
  if (
    new Set(selected.map((edge) => edge.hash)).size !== selected.length ||
    new Set(
      selected.map(
        (edge) =>
          `${edge.reference!.producingFeatureId}:${edge.reference!.lineageName}`
      )
    ).size !== selected.length
  ) {
    throw new Error(
      `${operation.name} did not resolve its staged edges to unique exact lineage.`
    );
  }
  return selected;
}

async function materializePatchCommands(
  base: ProjectDocument,
  proposal: CadPatchProposal,
  derive: (candidate: ProjectDocument) => Promise<ProjectDocument['derived']>
): Promise<AnyCommand[]> {
  const staged = stagedEdgeModifier(proposal);
  if (!staged) {
    return commandsForCadPatch(base, proposal);
  }
  const prefixProposal: CadPatchProposal = {
    ...proposal,
    operations: proposal.operations.slice(0, staged.index)
  };
  const prefixCommands = commandsForCadPatch(base, prefixProposal);
  const targetBodyId = declaredResultBodyId(
    prefixProposal,
    prefixCommands,
    staged.operation.targetBodyId
  );
  const prefixCandidate = new CommandManager(base).runTransaction(
    'Materialize AI patch topology',
    prefixCommands
  );
  const prefixDerived = await derive(prefixCandidate);
  const prefixWarnings = newExactWarnings(base, prefixDerived);
  if (prefixWarnings.length > 0) {
    throw exactWarningsError(prefixWarnings);
  }
  const exactPrefix = { ...prefixCandidate, derived: prefixDerived };
  const edges = selectedExactEdges(exactPrefix, targetBodyId, staged.operation);
  const ids = createBodyFeatureIds();
  const payload = {
    // Numbered past the prefix's features, as commandsForCadPatch numbers
    // every other feature a patch adds.
    name: numberedFeatureName(prefixCandidate, staged.operation.name),
    targetBodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.map((edge) => edge.reference!),
    size: staged.operation.size,
    ids
  };
  return [
    ...prefixCommands,
    staged.operation.modifier === 'fillet'
      ? commandFactories.filletEdges(payload)
      : commandFactories.chamferEdges(payload)
  ];
}

/**
 * The sole AI preview/Apply preflight. It builds one deterministic transaction,
 * runs the exact worker projection, and rejects warnings or missing results.
 */
export async function preflightCadPatch(
  base: ProjectDocument,
  proposal: CadPatchProposal,
  derive: (
    candidate: ProjectDocument,
    analysis?: EditAnalysisRequest
  ) => Promise<ProjectDocument['derived']>
): Promise<ExactPatchPreflight> {
  const analyses = proposal.operations.flatMap((op) =>
    op.kind === 'use_edit_candidate' && op.analysis ? [op.analysis] : []
  );
  const uniqueAnalyses = [
    ...new Map(
      analyses.map((analysis) => [JSON.stringify(analysis), analysis])
    ).values()
  ];
  if (uniqueAnalyses.length > 1)
    throw new Error('Analyze and bind one selected region at a time.');
  if (uniqueAnalyses[0])
    base = { ...base, derived: await derive(base, uniqueAnalyses[0]) };
  else base = await exactWarningBaseline(base, derive);
  const { expandEditCandidateProposal } =
    await import('@openzcad/ai-contracts');
  proposal = expandEditCandidateProposal(base, proposal);
  const commands = await materializePatchCommands(base, proposal, derive);
  const candidate = new CommandManager(base).runTransaction(
    'Preflight AI patch',
    commands
  );
  const derived = await derive(candidate);
  const warnings = newExactWarnings(base, derived);
  if (warnings.length > 0) {
    throw exactWarningsError(warnings);
  }
  const targets = [
    ...exactPatchTargets(commands),
    ...(await datumPatchTargets(base, candidate, derived, commands))
  ];
  const missing = targets.find(
    (target) => !derived.bodyRepresentations[target.resultBodyId]
  );
  if (missing) {
    throw new Error(
      `${missing.featureName} did not produce its expected exact result body.`
    );
  }
  if (proposal.preserveGeometry) {
    assertPreservedGeometry(base.derived, derived);
  }
  return {
    commands,
    candidate: { ...candidate, derived },
    targets
  };
}
