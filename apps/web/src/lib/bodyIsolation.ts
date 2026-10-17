/**
 * Isolation is a temporary view over the user's own hidden set: entering it
 * remembers that set, and leaving it puts the set back rather than showing
 * every body, so bodies hidden before isolating stay hidden afterwards.
 */
export interface BodyIsolation {
  readonly bodyId: string;
  /** The hidden set as it was before isolation began. */
  readonly priorHidden: ReadonlySet<string>;
}

export interface IsolationStep {
  readonly hidden: Set<string>;
  readonly isolation: BodyIsolation | null;
  readonly entered: boolean;
}

/**
 * Isolate `bodyId`, or leave isolation when it is already the only visible
 * body. `hidden` is the effective hidden set (it decides whether the body is
 * already alone); `localHidden` is the user-owned set being replaced.
 */
export function toggleBodyIsolation(
  bodyIds: readonly string[],
  bodyId: string,
  hidden: ReadonlySet<string>,
  localHidden: ReadonlySet<string>,
  isolation: BodyIsolation | null
): IsolationStep {
  const others = bodyIds.filter((id) => id !== bodyId);
  const alreadyAlone =
    !hidden.has(bodyId) && others.every((id) => hidden.has(id));
  if (alreadyAlone) {
    return {
      hidden: new Set(isolation?.priorHidden ?? []),
      isolation: null,
      entered: false
    };
  }
  return {
    hidden: new Set(others),
    // Isolating a second body keeps the set from before the first.
    isolation: {
      bodyId,
      priorHidden: new Set(isolation?.priorHidden ?? localHidden)
    },
    entered: true
  };
}
