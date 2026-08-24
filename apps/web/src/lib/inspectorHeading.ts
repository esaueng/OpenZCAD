import type { CommandSession } from './interaction/machine';

/** How the inspector's feature selection was made. */
export type FeatureSelectionSource = 'pinned' | 'inferred';

export interface InspectorHeadingInput {
  /** Display name of the feature the inspector resolved. */
  featureName: string;
  /** Feature-kind eyebrow used when the feature is the panel's subject. */
  featureKindLabel: string;
  featureSelectionSource: FeatureSelectionSource | null;
  commandSession: Pick<CommandSession, 'title'> | null;
}

export interface InspectorHeading {
  eyebrow: string;
  title: string;
  /**
   * The feature is context for a running command rather than the panel's
   * subject, so its form and its destructive action must say which feature
   * they mean.
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
 * armed. Titling the panel with that inferred feature is how a fillet in
 * progress used to be labelled with an unrelated earlier offset.
 */
export function inspectorHeadingForFeature(
  input: InspectorHeadingInput
): InspectorHeading {
  const demoted =
    input.featureSelectionSource === 'inferred' &&
    input.commandSession !== null;
  return demoted
    ? {
        eyebrow: 'Active command',
        title: input.commandSession?.title ?? '',
        demoted: true
      }
    : {
        eyebrow: input.featureKindLabel,
        title: input.featureName,
        demoted: false
      };
}
