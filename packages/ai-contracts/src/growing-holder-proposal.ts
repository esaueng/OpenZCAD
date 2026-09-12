import type {
  BodyId,
  ProjectDocument,
  RecognizedOpening
} from '@openzcad/shared';
import type { CadPatchProposal, CadSelectionContext } from './index';

export const GROWING_HOLDER_PARAMETER = 'opening_width';
export const GROWING_HOLDER_HEIGHT_PARAMETER = 'holder_height';

export interface GrowingHolderProposalTarget {
  bodyId: BodyId;
  name: string;
  opening: RecognizedOpening;
}

/**
 * The imported body whose opening the app has measured: the selected body
 * when one is selected, otherwise the only live body carrying a recognized
 * opening. Two eligible bodies without a selection is a question for the
 * user, not a guess.
 */
export function growingHolderProposalTarget(
  document: ProjectDocument,
  selection: Pick<CadSelectionContext, 'bodyIds'>
): GrowingHolderProposalTarget | null {
  const eligible = document.bodyOrder.flatMap((bodyId) => {
    const body = document.derived.bodyRepresentations[bodyId];
    const recognition = body?.topology?.recognizedOpening;
    if (
      !body ||
      body.consumed ||
      body.source !== 'imported-step' ||
      !recognition ||
      recognition.status !== 'recognized'
    )
      return [];
    return [{ bodyId, name: body.name, opening: recognition.opening }];
  });
  if (selection.bodyIds.length === 1) {
    return eligible.find((body) => body.bodyId === selection.bodyIds[0]) ?? null;
  }
  return selection.bodyIds.length === 0 && eligible.length === 1
    ? eligible[0]!
    : null;
}

const millimetres = (value: number, units: ProjectDocument['units']) =>
  `${Math.round(value * 100) / 100} ${units}`;

/**
 * A verified proposal that grows the measured opening of an imported body.
 * Every geometric value is the app's own measurement copied verbatim, so the
 * proposal binds to the digest exactly like an assistant-authored one and
 * passes the same exact preflight before it can be applied.
 */
export function createGrowingHolderProposal(
  document: ProjectDocument,
  selection: Pick<CadSelectionContext, 'bodyIds'>
): CadPatchProposal | null {
  const target = growingHolderProposalTarget(document, selection);
  if (!target) return null;
  const { opening } = target;
  const sectionLength = opening.cuts[1] - opening.cuts[0];
  const units = document.units;
  return {
    proposalId: `verified_growing_holder_${target.bodyId}`,
    summary: `The ${millimetres(opening.sourceOpening, units)} opening of ${target.name} will become the editable parameter ${GROWING_HOLDER_PARAMETER}. Both ends keep their exact geometry and move apart symmetrically about ${opening.axis} = ${millimetres(opening.center, units)}; the ${millimetres(sectionLength, units)} straight section between them is rebuilt at the new length, so the overall size follows the opening.`,
    assumptions: [
      ...(opening.height
        ? [
            `The arms are ${millimetres(opening.height.sourceHeight, units)} tall along ${opening.height.axis} and become the editable parameter ${GROWING_HOLDER_HEIGHT_PARAMETER}: each arm grows in its straight section between ${opening.height.axis} = ${millimetres(opening.height.cuts[0], units)} and ${millimetres(opening.height.cuts[1], units)}, which on a lettered arm is the widest gap between two letters, so that gap widens with the height. Everything above moves up rigidly; the smallest supported height is ${millimetres(opening.height.minimumHeight, units)}.`
          ]
        : []),
      `The opening was measured between the two inner faces along ${opening.axis} at ${millimetres(opening.sourceOpening, units)}.`,
      `The section between ${opening.axis} = ${millimetres(opening.cuts[0], units)} and ${millimetres(opening.cuts[1], units)} is straight; everything outside it, including holes and blends, moves rigidly with its end.`,
      `The smallest supported opening is ${millimetres(opening.minimumOpening, units)}, where the two ends would meet.`
    ],
    operations: [
      {
        kind: 'add_growing_holder_recipe',
        name: `${target.name} opening`,
        localId: 'holder',
        targetBodyId: target.bodyId,
        parameter: GROWING_HOLDER_PARAMETER,
        heightParameter: opening.height ? GROWING_HOLDER_HEIGHT_PARAMETER : null,
        opening
      }
    ]
  };
}
