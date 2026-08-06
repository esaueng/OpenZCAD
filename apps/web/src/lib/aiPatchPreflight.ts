import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import { createBodyFeatureIds } from '@openzcad/document-core';
import {
  isLocalBodyRef,
  normalizeLocalId,
  type CadPatchOperation,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

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
    const payload = commandRecord(command);
    if (!payload) {
      return [];
    }
    const ids =
      payload.ids && typeof payload.ids === 'object'
        ? (payload.ids as Record<string, unknown>)
        : null;
    const bodyId = ids?.bodyId ?? payload.targetBodyId;
    if (typeof bodyId !== 'string') {
      return [];
    }
    return [
      {
        featureName:
          typeof payload.name === 'string' ? payload.name : command.label,
        resultBodyId: bodyId as BodyId
      }
    ];
  });
}

function newExactWarnings(
  base: ProjectDocument,
  derived: ProjectDocument['derived']
): string[] {
  const existing = new Set(base.derived.warnings);
  return derived.warnings.filter((warning) => !existing.has(warning));
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
    throw new Error(prefixWarnings[0]);
  }
  const exactPrefix = { ...prefixCandidate, derived: prefixDerived };
  const edges = selectedExactEdges(exactPrefix, targetBodyId, staged.operation);
  const ids = createBodyFeatureIds();
  const payload = {
    name: staged.operation.name,
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
  derive: (candidate: ProjectDocument) => Promise<ProjectDocument['derived']>
): Promise<ExactPatchPreflight> {
  const commands = await materializePatchCommands(base, proposal, derive);
  const candidate = new CommandManager(base).runTransaction(
    'Preflight AI patch',
    commands
  );
  const derived = await derive(candidate);
  const warnings = newExactWarnings(base, derived);
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }
  const targets = exactPatchTargets(commands);
  const missing = targets.find(
    (target) => !derived.bodyRepresentations[target.resultBodyId]
  );
  if (missing) {
    throw new Error(
      `${missing.featureName} did not produce its expected exact result body.`
    );
  }
  return {
    commands,
    candidate: { ...candidate, derived },
    targets
  };
}
