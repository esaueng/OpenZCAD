/**
 * The compact workspace's one bottom sheet (U12 slice 2): where it stands
 * and the pages drilled into it. Pure, so the rules are testable without a
 * DOM; `BottomSheet` draws it and `useSheet` holds it.
 *
 * Three heights: peek (the tray's one row), half and full. Closed is the
 * sheet with nothing to hold. Whatever the workspace puts in the sheet (a
 * running tool's card, the inspector, a panel) is the root page; pages
 * pushed over it (a menu, a drill-in) form the back stack.
 */

export type SheetDetent = 'closed' | 'peek' | 'half' | 'full';

/** The heights a person can drag or step between, low to high. */
export const SHEET_DETENTS: readonly Exclude<SheetDetent, 'closed'>[] = [
  'peek',
  'half',
  'full'
];

export const SHEET_DETENT_NAMES: Record<SheetDetent, string> = {
  closed: 'Closed',
  peek: 'Peek',
  half: 'Half height',
  full: 'Full height'
};

/**
 * The peek height in CSS pixels: the grabber's row over one tray row of
 * 44 px targets (U12 slice 4), so the tray's verbs, or a running tool's
 * Cancel and Done, stand in reach at the lowest height the sheet rests at.
 */
export const SHEET_PEEK_PX = 104;

/**
 * A page in the back stack, by id only: its title and content are drawn
 * from the workspace's current state each render (`BottomSheet`'s
 * `renderPage`), so a page left open never shows rows as they once were.
 */
export interface SheetPage {
  /** Unique within the stack; pushing a key already there pops back to it. */
  readonly key: string;
}

export interface SheetState {
  readonly detent: SheetDetent;
  readonly stack: readonly SheetPage[];
  /**
   * Where the sheet stood when its first page was pushed, so popping back
   * to the root puts it there again: All tools opened from the tray at peek
   * goes back to peek, not to a full-height modal over an inert stage.
   * Absent while no page is open.
   */
  readonly rootDetent?: SheetDetent;
  /**
   * The height the person chose, under a temporary raise (a disabled
   * verb's reason): where the root goes back to when the raise ends, even
   * if a page was opened and closed meanwhile. Absent when the height is
   * the person's own.
   */
  readonly restDetent?: SheetDetent;
}

export const CLOSED_SHEET: SheetState = { detent: 'closed', stack: [] };

export type SheetAction =
  | { type: 'set-detent'; detent: SheetDetent }
  | { type: 'push'; page: SheetPage; detent?: SheetDetent }
  | { type: 'pop' }
  | { type: 'close' }
  /**
   * The workspace took the sheet for its own content (an edit, a tool or an
   * inspector started from a page): every page goes, so nothing stands over
   * that content, which keeps the height the pages stood at. With `toRoot`
   * (a running command's tray row arriving) it goes back to the root's own
   * height instead, as a pop to the root would: the row comes up at the
   * peek it asks for, the model in view and live to pick on.
   */
  | { type: 'leave'; toRoot?: boolean }
  | { type: 'step-up' }
  | { type: 'step-down' }
  /**
   * The workspace's own content arrived, changed or left. Content that
   * arrives comes up to `at` (half unless said otherwise): a running tool's
   * tray row alone needs only peek, so the model stays in view to pick on.
   */
  | {
      type: 'root';
      present: boolean;
      arrived: boolean;
      at?: Exclude<SheetDetent, 'closed'>;
    }
  /**
   * At least this high: a tool's Options, a refusal or the keypad. A
   * temporary raise (a disabled verb's reason) lifts only the root and is
   * undone by `lower`, back to the height the person chose.
   */
  | {
      type: 'raise';
      detent: Exclude<SheetDetent, 'closed'>;
      temporary?: boolean;
    }
  /** A temporary raise ends: the root goes back to the person's height. */
  | { type: 'lower' }
  /**
   * The workspace's content left and only the tray stays (U12 slice 4): the
   * sheet comes back down to peek, or, under an open page, comes back at
   * peek once the page goes.
   */
  | { type: 'settle' };

/** Where a detent stands, low to high; closed is below them all. */
function rank(detent: SheetDetent): number {
  return SHEET_DETENTS.indexOf(detent as 'peek');
}

/** The detent one step above, or the same at full. */
function above(detent: SheetDetent): SheetDetent {
  return detent === 'closed' || detent === 'peek'
    ? detent === 'closed'
      ? 'peek'
      : 'half'
    : 'full';
}

/**
 * The lowest the sheet may sit: closed when it holds nothing, peek while
 * the workspace has content in it (a running tool's Done must stay in
 * reach).
 */
function floor(state: SheetState, hasRoot: boolean): SheetDetent {
  return hasRoot || state.stack.length > 0 ? 'peek' : 'closed';
}

/** The detent one step below, never under the floor. */
function below(state: SheetState, hasRoot: boolean): SheetDetent {
  const lowest = floor(state, hasRoot);
  const next =
    state.detent === 'full'
      ? 'half'
      : state.detent === 'half'
        ? 'peek'
        : 'closed';
  return lowest === 'peek' && next === 'closed' ? 'peek' : next;
}

export function sheetReducer(
  state: SheetState,
  action: SheetAction,
  hasRoot: boolean
): SheetState {
  if (action.type === 'raise' && action.temporary) {
    // Only the root's own height is lifted; a page over it keeps its own.
    if (!hasRoot || state.stack.length > 0) return state;
    if (rank(action.detent) <= rank(state.detent)) return state;
    return {
      ...state,
      detent: action.detent,
      restDetent: state.restDetent ?? state.detent
    };
  }
  if (action.type === 'lower') {
    const { restDetent, ...rest } = state;
    if (restDetent === undefined) return state;
    if (!hasRoot) return rest;
    const back = restDetent === 'closed' ? 'peek' : restDetent;
    // Under a page, the root comes back at the person's height after it.
    return state.stack.length > 0
      ? { ...rest, rootDetent: back }
      : { ...rest, detent: back };
  }
  const next = reduceSheet(state, action, hasRoot);
  if (state.restDetent === undefined) return next;
  // The person moved the root (or something else asked it for room): the
  // height is theirs now. Pages opening and closing over a raised root
  // keep the height to go back to.
  const atRoot = state.stack.length === 0 && next.stack.length === 0;
  const claimed =
    (atRoot && next.detent !== state.detent) ||
    (action.type === 'raise' && state.stack.length === 0);
  if (claimed) {
    if (next.restDetent === undefined) return next;
    const { restDetent: _claimed, ...rest } = next;
    return rest;
  }
  return next.restDetent === state.restDetent
    ? next
    : { ...next, restDetent: state.restDetent };
}

function reduceSheet(
  state: SheetState,
  action: Exclude<SheetAction, { type: 'lower' }>,
  hasRoot: boolean
): SheetState {
  switch (action.type) {
    case 'set-detent': {
      const detent =
        action.detent === 'closed' && floor(state, hasRoot) === 'peek'
          ? 'peek'
          : action.detent;
      return detent === state.detent ? state : { ...state, detent };
    }
    case 'push': {
      const existing = state.stack.findIndex(
        (page) => page.key === action.page.key
      );
      const stack =
        existing >= 0
          ? [...state.stack.slice(0, existing), action.page]
          : [...state.stack, action.page];
      const wanted = action.detent ?? 'half';
      const detent =
        SHEET_DETENTS.indexOf(wanted as 'peek') >
        SHEET_DETENTS.indexOf(state.detent as 'peek')
          ? wanted
          : state.detent;
      return {
        detent,
        stack,
        rootDetent:
          state.stack.length === 0
            ? state.detent
            : (state.rootDetent ?? state.detent)
      };
    }
    case 'pop': {
      if (state.stack.length === 0) return state;
      const stack = state.stack.slice(0, -1);
      if (stack.length > 0) return { ...state, stack };
      if (!hasRoot) return { detent: 'closed', stack };
      // Back at the root: where it stood before the first page, never under
      // the peek its content needs.
      const back = state.rootDetent ?? state.detent;
      return { detent: back === 'closed' ? 'peek' : back, stack };
    }
    case 'close':
      return {
        stack: [],
        detent: hasRoot ? 'peek' : 'closed'
      };
    case 'leave': {
      if (state.stack.length === 0) return state;
      if (!hasRoot) return { stack: [], detent: 'closed' };
      const back = action.toRoot
        ? (state.rootDetent ?? state.detent)
        : state.detent;
      return { stack: [], detent: back === 'closed' ? 'peek' : back };
    }
    case 'step-up': {
      if (state.detent === 'closed' && !hasRoot && state.stack.length === 0) {
        return state;
      }
      const detent = above(state.detent);
      return detent === state.detent ? state : { ...state, detent };
    }
    case 'step-down': {
      if (state.stack.length > 0)
        return sheetReducer(state, { type: 'pop' }, hasRoot);
      const detent = below(state, hasRoot);
      return detent === state.detent ? state : { ...state, detent };
    }
    case 'raise': {
      if (!hasRoot && state.stack.length === 0) return state;
      return rank(action.detent) > rank(state.detent)
        ? { ...state, detent: action.detent }
        : state;
    }
    case 'settle': {
      if (!hasRoot) return state;
      if (state.stack.length > 0) {
        // Under a page: the tray comes back at peek when the page goes.
        return state.rootDetent === 'peek'
          ? state
          : { ...state, rootDetent: 'peek' };
      }
      return state.detent === 'peek' ? state : { ...state, detent: 'peek' };
    }
    case 'root': {
      if (!action.present) {
        // The workspace took its content back (the tool finished, the
        // selection cleared): a page pushed over it stays.
        return state.stack.length > 0
          ? state
          : state.detent === 'closed'
            ? state
            : { ...state, detent: 'closed' };
      }
      // New content comes up at half, where it can be read and used (a
      // running tool's row alone at peek); a person who raised the sheet
      // higher keeps it there.
      const at = action.at ?? 'half';
      if (action.arrived && state.stack.length > 0) {
        // Under an open page: the root comes back at least that high.
        const base = state.rootDetent ?? 'closed';
        return rank(at) > rank(base) ? { ...state, rootDetent: at } : state;
      }
      if (action.arrived && rank(at) > rank(state.detent)) {
        return { ...state, detent: at };
      }
      return state.detent === 'closed' ? { ...state, detent: 'peek' } : state;
    }
  }
}

/**
 * What Escape does in the sheet, or null when the key is not the sheet's.
 * It steps back a page, down from full, or closes a sheet that holds only
 * its own pages. At half or peek over the workspace's content, the key
 * belongs to that content: Escape cancels a running tool as it does on the
 * regular stage, and the sheet follows the tool away.
 */
export function sheetEscape(
  state: SheetState,
  hasRoot: boolean
): SheetState | null {
  if (state.detent === 'closed') return null;
  if (state.stack.length > 0 || state.detent === 'full' || !hasRoot) {
    const next = sheetReducer(state, { type: 'step-down' }, hasRoot);
    return next === state ? null : next;
  }
  return null;
}

/**
 * The detent nearest a dragged height, with the host's full height for
 * scale. A drag below half the peek row closes a sheet that may close. A
 * side sheet (a phone held landscape) stands the stage's full height at
 * half, and widens rather than grows to full, so a drag only steps between
 * peek and half.
 */
export function nearestDetent(
  heightPx: number,
  hostPx: number,
  canClose: boolean,
  side = false
): SheetDetent {
  if (canClose && heightPx < SHEET_PEEK_PX / 2) return 'closed';
  const heights: [SheetDetent, number][] = side
    ? [
        ['peek', SHEET_PEEK_PX],
        ['half', hostPx]
      ]
    : [
        ['peek', SHEET_PEEK_PX],
        ['half', hostPx / 2],
        ['full', hostPx]
      ];
  let best = heights[0]!;
  for (const candidate of heights) {
    if (Math.abs(candidate[1] - heightPx) < Math.abs(best[1] - heightPx)) {
      best = candidate;
    }
  }
  return best[0];
}
