/**
 * Isolation is a temporary view over the user's own hidden set: entering it
 * remembers that set, and leaving it puts the set back rather than showing
 * every body, so bodies hidden before isolating stay hidden afterwards.
 *
 * Only the user's own visibility choices persist. While isolation is on, the
 * set saved for this device (and for the account's resume state) is the one
 * from before it began, so a reload never strands bodies isolation hid.
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

/**
 * Where a recorded isolation stands against the view now on screen.
 *
 * - `active`: its body is shown and the hidden set is still the one it
 *   applied. A body made since (a feature created while isolated) is in no
 *   hidden set, so it joins the isolated view instead of ending it: it is
 *   the thing just worked on.
 * - `replaced`: the user's hidden set is no longer the one isolation applied
 *   (a manual Show or Hide, a view reset, a restored view). That choice is
 *   the user's, so the record is dropped and the set left as it is.
 * - `suspended`: a preview stands in for the model and has removed or hidden
 *   the isolated body. A preview is not a change yet, so the record waits.
 * - `ended`: the committed model no longer shows the isolated body (deleted,
 *   consumed by a boolean, undone, or switched off by a parameter). Ending
 *   puts back the hidden set from before isolation began.
 */
export type IsolationState =
  | { readonly kind: 'none' }
  | { readonly kind: 'active'; readonly bodyId: string }
  | { readonly kind: 'replaced' }
  | { readonly kind: 'suspended' }
  | {
      readonly kind: 'ended';
      readonly reason: 'removed' | 'hidden';
      readonly hidden: Set<string>;
    };

export function bodyIsolationState(
  bodyIds: readonly string[],
  hidden: ReadonlySet<string>,
  localHidden: ReadonlySet<string>,
  recorded: BodyIsolation | null,
  previewing: boolean
): IsolationState {
  if (!recorded) return { kind: 'none' };
  if (!sameSet(recorded.appliedHidden, localHidden))
    return { kind: 'replaced' };
  const removed = !bodyIds.includes(recorded.bodyId);
  if (!removed && !hidden.has(recorded.bodyId))
    return { kind: 'active', bodyId: recorded.bodyId };
  if (previewing) return { kind: 'suspended' };
  return {
    kind: 'ended',
    reason: removed ? 'removed' : 'hidden',
    hidden: new Set(recorded.priorHidden)
  };
}

/** The isolated body while its isolation is active, otherwise null. */
export function activeIsolatedBodyId(
  bodyIds: readonly string[],
  hidden: ReadonlySet<string>,
  localHidden: ReadonlySet<string>,
  recorded: BodyIsolation | null
): string | null {
  const state = bodyIsolationState(
    bodyIds,
    hidden,
    localHidden,
    recorded,
    false
  );
  return state.kind === 'active' ? state.bodyId : null;
}

/**
 * The hidden set to save for this device: the user's own, never the one an
 * isolation applied over it.
 */
export function persistedHiddenBodyIds(
  localHidden: ReadonlySet<string>,
  recorded: BodyIsolation | null
): ReadonlySet<string> {
  return recorded && sameSet(recorded.appliedHidden, localHidden)
    ? recorded.priorHidden
    : localHidden;
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
  if (
    isolation &&
    activeIsolatedBodyId(bodyIds, hidden, localHidden, isolation) === bodyId
  ) {
    return {
      hidden: new Set(isolation.priorHidden),
      isolation: null,
      entered: false
    };
  }
  const hiddenNow = new Set(bodyIds.filter((id) => id !== bodyId));
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

/**
 * Hands `bodyIds` to a toggle parameter: the caller drops them from the
 * user's hidden set, so the isolation record drops them too and stays in
 * step with it. Without this, a parameter that switches the isolated body
 * off together with another body changed the user's set out from under the
 * record, which read as `replaced`: isolation was dropped silently and the
 * bodies it hid stayed hidden, through a reload.
 */
export function releaseIsolationToParameter<T extends BodyIsolation>(
  recorded: T | null,
  bodyIds: readonly string[]
): T | null {
  if (!recorded) return recorded;
  const keep = (set: ReadonlySet<string>) =>
    new Set([...set].filter((id) => !bodyIds.includes(id)));
  return {
    ...recorded,
    priorHidden: keep(recorded.priorHidden),
    appliedHidden: keep(recorded.appliedHidden)
  };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
