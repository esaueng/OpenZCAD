/**
 * How the command bar finds and orders commands (U05, research audit
 * ZC-203): typed words match a command's name, its initials ("lp" finds
 * Linear Pattern) or its keywords; an empty search lists what was run
 * recently, then what can run now on the current pick.
 *
 * Recent commands are a device convenience kept beside the other workspace
 * preferences, never in a document: a project would otherwise change each
 * time someone ran a command from the bar.
 */
export const RECENT_COMMANDS_STORAGE_KEY = 'openzcad-recent-commands:v1';
export const MAX_RECENT_COMMANDS = 5;

export interface SearchableCommand {
  id: string;
  label: string;
  group: string;
  keywords?: string[];
  /** Non-null: the command cannot run now, and says why. */
  disabledReason?: string | null;
  /**
   * The command does not act on the current pick (a body tool while a face
   * is picked). It still runs and still answers a typed search; an empty
   * search leaves it out, and a typed one ranks it below the commands that
   * do act on the pick.
   */
  offPick?: boolean;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The ids run from the bar, most recent first. */
export function loadRecentCommands(
  storage: StorageLike | null = defaultStorage()
): string[] {
  try {
    const raw = storage?.getItem(RECENT_COMMANDS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed
          .filter((id): id is string => typeof id === 'string' && id !== '')
          .slice(0, MAX_RECENT_COMMANDS)
      : [];
  } catch {
    return [];
  }
}

/** Moves `id` to the front, keeps the newest few, and returns the list. */
export function recordRecentCommand(
  id: string,
  storage: StorageLike | null = defaultStorage()
): string[] {
  const next = [
    id,
    ...loadRecentCommands(storage).filter((recent) => recent !== id)
  ].slice(0, MAX_RECENT_COMMANDS);
  try {
    storage?.setItem(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage only loses the recency order.
  }
  return next;
}

const WORD_BREAK = /[\s\-–—/:()]+/;

function words(value: string): string[] {
  return value.split(WORD_BREAK).filter(Boolean);
}

function wordStartsWith(value: string, token: string): boolean {
  return words(value).some((word) => word.startsWith(token));
}

/**
 * "lp" is Linear Pattern and "ntsf" Normal To Selected Face: two letters or
 * more that begin the initials of a name of two words or more.
 */
function matchesInitials(label: string, token: string): boolean {
  const labelWords = words(label);
  if (token.length < 2 || labelWords.length < 2) {
    return false;
  }
  return labelWords
    .map((word) => word[0])
    .join('')
    .startsWith(token);
}

export function tokenScore(command: SearchableCommand, token: string): number {
  const label = command.label.toLowerCase();
  if (label.startsWith(token)) {
    return 4;
  }
  if (wordStartsWith(label, token) || matchesInitials(label, token)) {
    return 3;
  }
  if (label.includes(token)) {
    return 2;
  }
  // Declared on commands long before anything read them: "laser" never
  // found the DXF outline export its keywords name.
  if (
    command.keywords?.some((keyword) => keyword.toLowerCase().startsWith(token))
  ) {
    return 2;
  }
  return wordStartsWith(command.group.toLowerCase(), token) ? 1 : 0;
}

/**
 * Typed words: every word must match; the best total wins, and between
 * equals a command for the current pick, then a recent one, then the
 * host's order. When any command matches by name, commands matched only by
 * their group drop out.
 */
export function rankedCommands<T extends SearchableCommand>(
  commands: readonly T[],
  query: string,
  recentIds: readonly string[] = []
): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [...commands];
  }
  const recency = (id: string) => {
    const index = recentIds.indexOf(id);
    return index < 0 ? recentIds.length : index;
  };

  const ranked = commands.flatMap((command, sourceIndex) => {
    const scores = tokens.map((token) => tokenScore(command, token));
    return scores.every((score) => score > 0)
      ? [
          {
            command,
            hasLabelMatch: scores.some((score) => score > 1),
            score: scores.reduce((sum, score) => sum + score, 0),
            offPick: command.offPick ? 1 : 0,
            recency: recency(command.id),
            sourceIndex
          }
        ]
      : [];
  });
  const hasLabelMatch = ranked.some((entry) => entry.hasLabelMatch);

  return ranked
    .filter((entry) => !hasLabelMatch || entry.hasLabelMatch)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.offPick - right.offPick ||
        left.recency - right.recency ||
        left.sourceIndex - right.sourceIndex
    )
    .map(({ command }) => command);
}

export interface BrowseEntry<T> {
  command: T;
  recent: boolean;
}

/**
 * Nothing typed: the commands run most recently first, then every other
 * command in the host's order — only those that can run now (no
 * `disabledReason`, so the current mode allows them) and act on the
 * current pick. A typed search still reaches the rest and says why one
 * cannot run.
 */
export function browseCommands<T extends SearchableCommand>(
  commands: readonly T[],
  recentIds: readonly string[] = []
): BrowseEntry<T>[] {
  const valid = (command: T) => !command.disabledReason && !command.offPick;
  const byId = new Map(commands.map((command) => [command.id, command]));
  const recent = recentIds.flatMap((id) => {
    const command = byId.get(id);
    return command && valid(command) ? [command] : [];
  });
  const recentSet = new Set(recent.map((command) => command.id));
  return [
    ...recent.map((command) => ({ command, recent: true })),
    ...commands
      .filter((command) => valid(command) && !recentSet.has(command.id))
      .map((command) => ({ command, recent: false }))
  ];
}
