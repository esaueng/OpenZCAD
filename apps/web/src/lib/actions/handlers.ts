/**
 * What an action does, once, for every route that starts it (U12 slice 1).
 *
 * The workspace builds one handler map per render, keyed by registry id
 * (`registry.ts`). A keyboard shortcut and the command bar's row for the
 * same action both run its entry, so the two cannot drift apart, and the
 * compact workspace's controls will run the same entries. Actions move into
 * the map as their routes are joined; an action not in it is still
 * dispatched where it was.
 */

export type ActionHandler = () => void;

export type ActionHandlers = Readonly<Record<string, ActionHandler>>;

/**
 * The handler for an action id, or undefined when the map has none. Only the
 * map's own keys count, so an id such as `toString` never resolves to an
 * inherited member.
 */
export function actionHandler(
  handlers: ActionHandlers,
  id: string | null | undefined
): ActionHandler | undefined {
  return id != null && Object.hasOwn(handlers, id) ? handlers[id] : undefined;
}
