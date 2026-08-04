import {
  CommandManager,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
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

/**
 * The sole AI preview/Apply preflight. It builds one deterministic transaction,
 * runs the exact worker projection, and rejects warnings or missing results.
 */
export async function preflightCadPatch(
  base: ProjectDocument,
  proposal: CadPatchProposal,
  derive: (candidate: ProjectDocument) => Promise<ProjectDocument['derived']>
): Promise<ExactPatchPreflight> {
  const commands = commandsForCadPatch(base, proposal);
  const candidate = new CommandManager(base).runTransaction(
    'Preflight AI patch',
    commands
  );
  const derived = await derive(candidate);
  const targets = exactPatchTargets(commands);
  const missing = targets.find(
    (target) => !derived.bodyRepresentations[target.resultBodyId]
  );
  if (missing) {
    throw new Error(
      `${missing.featureName} did not produce its expected exact result body.`
    );
  }
  const warnings = newExactWarnings(base, derived);
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }
  return {
    commands,
    candidate: { ...candidate, derived },
    targets
  };
}
