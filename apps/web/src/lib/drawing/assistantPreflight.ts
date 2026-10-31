import {
  CommandManager,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import type { CadPatchProposal } from '@openzcad/ai-contracts';
import { findDrawingSheet } from '@openzcad/document-core';
import type { DrawingSheet, ProjectDocument } from '@openzcad/shared';
import {
  drawingProposalProblems,
  groundDrawingProposal,
  type DrawingAssistantSource
} from './assistantContext';

export interface DrawingPatchPreflight {
  commands: AnyCommand[];
  /** The sheet as the proposal would leave it. */
  sheet: DrawingSheet;
}

/**
 * D06 slice E: a drawing-sheet proposal checked against the sheet on
 * screen. It needs no geometry rebuild — sheet edits leave the model alone
 * — but every annotation it adds must resolve against the model the sheet
 * draws, or it is refused before anyone sees it.
 */
export function preflightDrawingPatch(
  base: ProjectDocument,
  proposal: CadPatchProposal,
  source: DrawingAssistantSource | null
): DrawingPatchPreflight {
  if (!source)
    throw new Error('Open the sheet in Draw to review a drawing proposal.');
  if (
    proposal.operations.some(
      (operation) =>
        'sheetId' in operation && operation.sheetId !== source.sheetId
    )
  )
    throw new Error('The proposal is for another sheet than the one open.');
  if (!source.ready)
    throw new Error(
      'The sheet is not drawn from the current model. Update it, then ask again.'
    );
  const grounded = groundDrawingProposal(proposal, source.bodies);
  const commands = commandsForCadPatch(base, grounded);
  const candidate = new CommandManager(base).runTransaction(
    'Preflight AI drawing edit',
    commands
  );
  const before = findDrawingSheet(base, source.sheetId);
  const sheet = findDrawingSheet(candidate, source.sheetId);
  if (!before || !sheet) throw new Error('The sheet is no longer there.');
  const problems = drawingProposalProblems({
    before,
    after: sheet,
    bodies: source.bodies,
    units: base.units
  });
  // Seam for D06 slices A and C: the dimension check (and later the
  // generator's repair) runs here, on the sheet as proposed.
  if (problems.length > 0)
    throw new Error(
      `The proposed annotations do not all measure the drawn model.\n\n${problems.join('\n')}`
    );
  return { commands, sheet };
}
