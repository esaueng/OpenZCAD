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
 * feature whichever host is showing.
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

/** One opening of an edit card: the same feature opened twice is two. */
export interface EditCardSession {
  readonly featureId: string;
  readonly generation: number;
}

/**
 * Tells a late Apply whether the card it was pressed on is still open.
 *
 * An exact Apply can validate for seconds. A feature ID alone cannot say
 * whether its card is the same one: closing the card and reopening the same
 * feature meanwhile shows a new card, with new input, under the same ID, and
 * the old Apply's success must not close it. So every time the card on
 * screen changes — to another feature, to none, or back again — it becomes a
 * new session, and an Apply closes only the session it started in.
 */
export class EditCardSessions {
  private generation = 0;
  private current: EditCardSession | null = null;

  /**
   * Reports the feature whose edit card is on screen now (null when none
   * is) and returns its session. Idempotent for an unchanged card, so it is
   * safe to call on every render.
   */
  observe(featureId: string | null): EditCardSession | null {
    if (featureId !== (this.current?.featureId ?? null)) {
      this.generation += 1;
      this.current =
        featureId === null ? null : { featureId, generation: this.generation };
    }
    return this.current;
  }

  /** True while `session` is still the card on screen. */
  isOpen(session: EditCardSession | null): boolean {
    return session !== null && session === this.current;
  }
}
