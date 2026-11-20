import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  type AnyCommand
} from '@openzcad/command-system';
import type {
  CadAutoDimensionDrawingOperation,
  CadPatchProposal
} from '@openzcad/ai-contracts';
import { findDrawingSheet } from '@openzcad/document-core';
import {
  DRAWING_VIEW_LABELS,
  type DrawingAnnotation,
  type DrawingSheet,
  type ProjectDocument
} from '@openzcad/shared';
import {
  drawingProposalProblems,
  groundDrawingProposal,
  type DrawingAssistantSource
} from './assistantContext';

export interface DrawingPatchPreflight {
  commands: AnyCommand[];
  /** The sheet as the proposal would leave it. */
  sheet: DrawingSheet;
  /**
   * What an auto-dimension request leaves out, worded for the reviewer:
   * dimensions its scope excludes and what the generator cannot place.
   * Empty for a proposal that names its own annotations.
   */
  leftOut: string[];
}

const KIND_NAMES: Record<string, [string, string]> = {
  linear: ['linear dimension', 'linear dimensions'],
  diameter: ['diameter', 'diameters'],
  radius: ['radius', 'radii'],
  chamfer: ['chamfer dimension', 'chamfer dimensions'],
  angle: ['angle', 'angles']
};

const counted = (count: number, kind: string) => {
  const [one, many] = KIND_NAMES[kind] ?? [kind, `${kind}s`];
  return `${count} ${count === 1 ? one : many}`;
};

/**
 * D06 slice E: the generator's plan for the sheet, cut to the request's
 * scope. The generator places each dimension in the one view that suits it
 * best, so a view scope keeps the dimensions planned there and reports the
 * rest by the view they belong in, never moving them.
 */
export function scopedAutoDimensions(
  operation: CadAutoDimensionDrawingOperation,
  source: DrawingAssistantSource,
  viewName: (viewId: string) => string
): { annotations: DrawingAnnotation[]; leftOut: string[] } {
  if (!source.autoDimension)
    throw new Error('Wait for every view to be drawn, then ask again.');
  const plan = source.autoDimension();
  const views = operation.viewIds ? new Set(operation.viewIds) : null;
  const kinds = operation.dimensionKinds
    ? new Set<string>(operation.dimensionKinds)
    : null;
  const annotations: DrawingAnnotation[] = [];
  const byKind = new Map<string, number>();
  const byView = new Map<string, number>();
  for (const annotation of plan.annotations) {
    // A Ø span (a bolt circle's pitch, a turned part's side-view diameter)
    // is stored as a linear dimension but states a diameter.
    const kind =
      annotation.kind === 'linear' && annotation.diameter === true
        ? 'diameter'
        : annotation.kind;
    if (kinds && !kinds.has(kind)) {
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
      continue;
    }
    // The generator's dimensions all belong to a view; a paper note would
    // not, and no view scope excludes it.
    const viewId = annotation.viewId;
    if (views && viewId !== undefined && !views.has(viewId)) {
      byView.set(viewId, (byView.get(viewId) ?? 0) + 1);
      continue;
    }
    annotations.push(annotation);
  }
  const leftOut = [
    ...[...byKind].map(
      ([kind, count]) => `${counted(count, kind)}, by request`
    ),
    ...[...byView].map(
      ([viewId, count]) =>
        `${count} ${count === 1 ? 'dimension' : 'dimensions'} that belong in ${viewName(viewId)}`
    ),
    ...plan.skipped.map((skip) => skip.message),
    ...(plan.sectionAdvice ? [plan.sectionAdvice] : [])
  ];
  return { annotations, leftOut };
}

/** What an auto-dimension preview planned, kept for its Apply. */
export interface AutoDimensionPreview {
  /** The proposal object itself: provider ids need not be unique. */
  proposal: CadPatchProposal;
  document: ProjectDocument;
  commands: AnyCommand[];
}

/**
 * The commands to apply for an auto-dimension request: exactly the ones
 * its preview planned. The generator is never run again on Apply — a view
 * dragged, a dimension drawn or the model changed since would plan
 * dimensions the user never saw — so Apply refuses unless the very
 * proposal was previewed on the very document now open. Null for any
 * other proposal, which compiles the same way every time.
 */
export function previewedAutoDimensionCommands(
  proposal: CadPatchProposal,
  previewed: AutoDimensionPreview | null,
  current: ProjectDocument
): AnyCommand[] | null {
  if (
    !proposal.operations.some(
      (operation) => operation.kind === 'auto_dimension_drawing'
    )
  )
    return null;
  if (
    !previewed ||
    previewed.proposal !== proposal ||
    previewed.document !== current
  )
    throw new Error(
      'The drawing changed since these dimensions were previewed. Preview them again, or ask again to dimension the sheet as it is now.'
    );
  return previewed.commands;
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
  const auto = proposal.operations.find(
    (operation): operation is CadAutoDimensionDrawingOperation =>
      operation.kind === 'auto_dimension_drawing'
  );
  let leftOut: string[] = [];
  let commands: AnyCommand[];
  if (auto) {
    if (proposal.operations.length > 1)
      throw new Error('An auto-dimension request is proposed alone.');
    const current = findDrawingSheet(base, source.sheetId);
    const names = new Map(
      (current?.views ?? []).map((view) => [
        view.viewId as string,
        `the ${DRAWING_VIEW_LABELS[view.orientation]} view`
      ])
    );
    const scoped = scopedAutoDimensions(
      auto,
      source,
      (viewId) => names.get(viewId) ?? `view ${viewId}`
    );
    leftOut = scoped.leftOut;
    if (scoped.annotations.length === 0)
      throw new Error(
        `Auto-dimension has nothing to add${leftOut.length ? `. Left out: ${leftOut.join('; ')}.` : ': the dimension check finds nothing missing.'}`
      );
    commands = scoped.annotations.map((annotation) =>
      commandFactories.addDrawingAnnotation({
        sheetId: source.sheetId,
        annotation
      })
    );
  } else {
    const grounded = groundDrawingProposal(proposal, source.bodies);
    commands = commandsForCadPatch(base, grounded);
  }
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
  // The generator's own plan passes by construction; the check stays as
  // the gate for it too, so the two can never disagree silently.
  if (problems.length > 0)
    throw new Error(
      `The proposed sheet does not pass the drawing check.\n\n${problems.join('\n')}`
    );
  return { commands, sheet, leftOut };
}
