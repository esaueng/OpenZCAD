import type { CommandManager } from '@openzcad/command-system';

/** Why editing is off while the workspace leaves a project. */
export const NAVIGATION_EDIT_PAUSE_REASON =
  'Leaving this project — editing is paused';

/** An edit refused because the workspace is leaving its project. */
export class NavigationEditPausedError extends Error {
  constructor() {
    super(`Cannot edit this project: ${NAVIGATION_EDIT_PAUSE_REASON}.`);
    this.name = 'NavigationEditPausedError';
  }
}

/**
 * Pauses edits to the open project while a navigation leaves it.
 *
 * A navigation saves the open project's pending edits first, then awaits
 * the account, a download or a thumbnail before the next project (or the
 * shelf) replaces it. An edit made in that wait would be autosaved after
 * this tab has given the project up, where it can only be refused, so no
 * edit is taken then. The pause is bound to the manager open when the
 * navigation began: it ends when the navigation ends (completes, aborts or
 * fails), when a newer navigation replaces it, or as soon as another
 * manager is the open one.
 */
export class NavigationEditPause {
  private paused: { manager: CommandManager; token: object } | null = null;

  constructor(private readonly onChange: () => void = () => undefined) {}

  /** Pauses edits to `manager`; the returned function ends this pause. */
  begin(manager: CommandManager | null): () => void {
    const token = {};
    this.paused = manager ? { manager, token } : null;
    this.onChange();
    return () => {
      if (this.paused?.token !== token) return;
      this.paused = null;
      this.onChange();
    };
  }

  /** The reason edits to `manager` are paused, or null. */
  reasonFor(manager: CommandManager | null | undefined): string | null {
    return manager && this.paused?.manager === manager
      ? NAVIGATION_EDIT_PAUSE_REASON
      : null;
  }

  /**
   * The manager a navigation in progress is leaving, or null: the project
   * whose refused edit a departure keeps as a recovery copy. It stays the
   * departing one after the next project opens, until the pause ends.
   */
  departing(): CommandManager | null {
    return this.paused?.manager ?? null;
  }

  /**
   * Makes `manager` refuse every edit while paused: the check under all of
   * the workspace's own, for an edit that reaches the manager without one
   * (a shortcut in the same tick as the navigation, a validated commit
   * landing after it began).
   */
  guard(manager: CommandManager): void {
    manager.editGuard = () => {
      if (this.reasonFor(manager)) throw new NavigationEditPausedError();
    };
  }
}

/**
 * A navigation's "is this still the navigation in progress?" check, with
 * the `end` of its edit pause.
 */
export type ProjectNavigation = (() => boolean) & { end(): void };
