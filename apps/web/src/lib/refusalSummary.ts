import type { CommandDiagnostic } from './interaction/machine';
import {
  isDependentReferenceError,
  isStaleSelectionError
} from './interaction/machine';

/**
 * The one line a refused edit shows on its own control, worked out from the
 * refusal's data rather than read out of its sentence.
 *
 * The full sentence is the explanation and stays behind "Why?". This is what
 * the user reads at a glance: whether the solid was built, and the one thing
 * worth trying first. A size the adapter's ladder actually BUILT is offered
 * as a one-click remedy; no other size ever is.
 */
export interface RefusalSummary {
  /** The state, in words: colour is never the only cue. */
  status: 'not-built' | 'selection-changed';
  /** The short line after the status word. */
  headline: string;
  /** The cause in plain words, for the explanation under the headline. */
  cause: string;
  /** A size proved to build here, offered as "Try …". */
  trySize?: number;
  /**
   * Whether picking other geometry is a remedy: the size was not the
   * problem, so another edge or face is the way forward.
   */
  pickAnother: boolean;
}

/**
 * What each command could not do, by the name `commandIdentityFor` gives it.
 * The name is the command's identity, not prose: one table, so a chamfer
 * never says "round".
 */
const COMMAND_HEADLINES: Record<string, string> = {
  Fillet: 'Can’t round this edge here',
  Chamfer: 'Can’t chamfer this edge here',
  'Edit Fillet': 'Can’t change this fillet here',
  'Blend Face': 'Can’t remove this blend here',
  'Offset Face': 'Can’t move this face here',
  'Resize Body': 'Can’t resize this body here',
  'Resize Cylinder': 'Can’t resize this cylinder here',
  'Resize Hole': 'Can’t resize this hole here',
  Extrude: 'Can’t extrude to this value'
};

const BLEND_VERBS = { fillet: 'round', chamfer: 'chamfer' } as const;

/**
 * `operationTitle` is the refused command's name ("Offset Face"); a fillet
 * or chamfer refusal that carries the adapter's verdict names itself.
 */
export function refusalSummary(
  error: CommandDiagnostic,
  operationTitle: string
): RefusalSummary {
  if (isStaleSelectionError(error)) {
    return {
      status: 'selection-changed',
      headline: 'Pick the edge or face again',
      cause: error.message,
      pickAnother: false
    };
  }
  // The user's pick is fine: a later feature stored edges or faces this
  // change reshapes past recognition. Say which, and what to do about it;
  // "Selection changed" would blame the face still under the cursor.
  if (isDependentReferenceError(error)) {
    const name = error.culprit!.featureName;
    return {
      status: 'not-built',
      headline: `“${name}” can’t follow this change`,
      cause: `“${name}” is applied to edges or faces this change reshapes, and it can no longer tell which ones they are on the new shape. Try a smaller change, or edit “${name}” and pick its edges or faces again.`,
      pickAnother: false
    };
  }
  if (error.headline) {
    return {
      status: 'not-built',
      headline: error.headline,
      cause: error.message,
      pickAnother: false
    };
  }
  const advice = error.advice;
  if (advice?.kind === 'smaller-size') {
    return {
      status: 'not-built',
      headline: `${advice.operation === 'fillet' ? 'Radius' : 'Distance'} too large`,
      cause: advice.reason,
      trySize: advice.size,
      pickAnother: false
    };
  }
  if (advice?.kind === 'structural') {
    const verb = BLEND_VERBS[advice.operation];
    const what = advice.edges === 1 ? 'this edge' : 'these edges';
    const headline =
      advice.cause === 'smooth-boundary'
        ? 'These faces already meet smoothly'
        : advice.cause === 'partial-revolve'
          ? `Can’t ${verb} a partial revolve yet`
          : advice.cause === 'shared-corner' || advice.cause === 'edge-groups'
            ? `Can’t ${verb} these edges together`
            : `Can’t ${verb} ${what} here`;
    return {
      status: 'not-built',
      headline,
      cause: advice.reason,
      pickAnother: true
    };
  }
  return {
    status: 'not-built',
    headline:
      COMMAND_HEADLINES[operationTitle] ??
      `${operationTitle} can’t be built here`,
    cause: error.message,
    pickAnother: false
  };
}

/** The status word as it is read. */
export const REFUSAL_STATUS_LABELS: Record<RefusalSummary['status'], string> = {
  'not-built': 'Not built',
  'selection-changed': 'Selection changed'
};
