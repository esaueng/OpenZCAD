import type { ToolId } from './tools';

/**
 * One lifecycle for every feature's edit card (F19, 1 October 2026 design
 * review). It opens already editable, closes after a successful Apply the way
 * a create card does, stays open with its message when Apply is refused, and
 * Escape cancels it without touching history.
 *
 * Two hosts draw edit cards: the Inspector draws the forms it owns (Box,
 * Extrude, Move, Fillet, Pattern …) while no tool is running, and the
 * modeling card draws the creation form of the operation it reopens (Hole,
 * Shell, Loft …) while that operation's tool is running. This names the
 * feature whichever host is showing, so a late Apply can tell whether its
 * card is still the one on screen.
 */
export function editCardFeatureId(input: {
  tool: ToolId | null;
  /** The feature the Inspector resolved for the current selection. */
  inspectorFeatureId: string | null;
  /** The feature the modeling card reopened, if it is editing one. */
  modelingEditFeatureId: string | null;
}): string | null {
  return input.tool === null
    ? input.inspectorFeatureId
    : input.modelingEditFeatureId;
}

export interface EditCardSession {
  featureId: string | null;
  tool: ToolId | null;
  generation: number;
}

/** A reopened card is a new session even when it edits the same feature. */
export function advanceEditCardSession(
  previous: EditCardSession | null,
  input: Parameters<typeof editCardFeatureId>[0]
): EditCardSession {
  const featureId = editCardFeatureId(input);
  if (previous?.featureId === featureId && previous.tool === input.tool) {
    return previous;
  }
  return {
    featureId,
    tool: input.tool,
    generation: (previous?.generation ?? 0) + 1
  };
}

/** Only the card that started an Apply may close when that Apply succeeds. */
export function editCardSessionMatches(
  current: EditCardSession | null,
  started: EditCardSession | null,
  featureId: string
): boolean {
  return Boolean(
    current &&
    started &&
    started.featureId === featureId &&
    current.featureId === featureId &&
    current.tool === started.tool &&
    current.generation === started.generation
  );
}
