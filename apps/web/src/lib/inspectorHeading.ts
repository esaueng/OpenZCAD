import type { CommandSession } from './interaction/machine';
import { CARD_EYEBROWS } from './cardEyebrows';

/** How the inspector's feature selection was made. */
export type FeatureSelectionSource = 'pinned' | 'inferred';

export interface InspectorHeadingInput {
  /** Display name of the feature the inspector resolved. */
  featureName: string;
  /** The feature's kind, named for a demoted panel with no body to name. */
  featureKindLabel: string;
  /**
   * A direct edit (a face offset) rather than a history feature with a
   * creation form: its panel says "Direct edit", as the Move card does.
   */
  directEdit?: boolean;
  /** D5 topology label for the selected viewport object. */
  selectionLabel?: string;
  /** Body that owns the selected viewport object. */
  selectionBodyName?: string;
  featureSelectionSource: FeatureSelectionSource | null;
  commandSession: Pick<CommandSession, 'title'> | null;
}

export interface InspectorHeading {
  eyebrow: string;
  title: string;
  /**
   * The feature is provenance for a selected object. Its form and destructive
   * actions become available only after an explicit Edit or history pick.
   */
  demoted: boolean;
}

/**
 * Names the inspector panel.
 *
 * Two different questions can put a feature here. A history-tree click asks
 * "show me this feature" — the user named it, so it names the panel. A
 * viewport pick asks "what is this shape", and the answer is the feature that
 * currently defines the picked body, which is not the command the pick just
 * armed. The object keeps its topology name while the defining feature is
 * demoted to provenance that can be pinned explicitly for editing.
 */
export function inspectorHeadingForFeature(
  input: InspectorHeadingInput
): InspectorHeading {
  const demoted = input.featureSelectionSource === 'inferred';
  return demoted
    ? {
        eyebrow: input.selectionBodyName ?? input.featureKindLabel,
        title: input.selectionLabel ?? input.featureName,
        demoted: true
      }
    : {
        eyebrow: input.directEdit ? CARD_EYEBROWS.direct : CARD_EYEBROWS.edit,
        title: input.featureName,
        demoted: false
      };
}
