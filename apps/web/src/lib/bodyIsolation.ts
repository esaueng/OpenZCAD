/**
 * Isolation is a temporary view over the user's own hidden set: entering it
 * remembers that set, and leaving it puts the set back rather than showing
 * every body, so bodies hidden before isolating stay hidden afterwards.
 */
export interface BodyIsolation {
  readonly bodyId: string;
  /** The hidden set as it was before isolation began. */
  readonly priorHidden: ReadonlySet<string>;
  /** The hidden set isolation itself applied. */
  readonly appliedHidden: ReadonlySet<string>;
}

export interface IsolationStep {
  readonly hidden: Set<string>;
  readonly isolation: BodyIsolation | null;
  readonly entered: boolean;
}

/** An isolation remains active only while its body is alone in its own view. */
export function activeIsolatedBodyId(
  bodyIds: readonly string[],
  hidden: ReadonlySet<string>,
  localHidden: ReadonlySet<string>,
  recorded: BodyIsolation | null
): string | null {
  if (
    !recorded ||
    !sameSet(recorded.appliedHidden, localHidden) ||
    !bodyIds.includes(recorded.bodyId) ||
    hidden.has(recorded.bodyId) ||
    bodyIds.some((id) => id !== recorded.bodyId && !hidden.has(id))
  )
    return null;
  return recorded.bodyId;
}

/**
 * Isolate `bodyId`, or leave its recorded isolation when it is alone.
 * `hidden` is the effective hidden set (it decides whether the body is
 * already alone); `localHidden` is the user-owned set being replaced.
 */
export function toggleBodyIsolation(
  bodyIds: readonly string[],
  bodyId: string,
  hidden: ReadonlySet<string>,
  localHidden: ReadonlySet<string>,
  recorded: BodyIsolation | null
): IsolationStep {
  // A snapshot belongs only to the hidden set it applied. Anything else that
  // replaced that set since (a manual toggle, a view reset, a restored view)
  // ends the isolation session, so its stale prior set is never resurrected.
  const isolation =
    recorded && sameSet(recorded.appliedHidden, localHidden) ? recorded : null;
  const others = bodyIds.filter((id) => id !== bodyId);
  const alreadyAlone =
    !hidden.has(bodyId) && others.every((id) => hidden.has(id));
  if (alreadyAlone && isolation?.bodyId === bodyId) {
    return {
      hidden: new Set(isolation?.priorHidden ?? []),
      isolation: null,
      entered: false
    };
  }
  const hiddenNow = new Set(others);
  return {
    hidden: hiddenNow,
    // Isolating a second body keeps the set from before the first.
    isolation: {
      bodyId,
      priorHidden: new Set(isolation?.priorHidden ?? localHidden),
      appliedHidden: hiddenNow
    },
    entered: true
  };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
