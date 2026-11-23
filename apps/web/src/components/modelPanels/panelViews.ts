import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react';

// The panels' own view state lives above wherever they are drawn: moving a
// panel between the dock, the unpinned slot and the phone lane remounts it,
// and a filter, a search or an open Find field should outlive the move. It
// belongs to one project, though: `scope` (the open project's id) changing
// starts it afresh, as the drawer's state did when the workspace unmounted.

/**
 * The Objects list's type filter, name search and source-body disclosure,
 * held by the panel's frame around the list.
 */
export interface ObjectsView {
  filter: string;
  setFilter(filter: string): void;
  query: string;
  setQuery(query: string): void;
  showConsumed: boolean;
  setShowConsumed: Dispatch<SetStateAction<boolean>>;
}

export function useObjectsView(scope: unknown = null): ObjectsView {
  const [showConsumed, setShowConsumed] = useState(false);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  // Reset during render, not in an effect, so a new project never draws one
  // frame through the last project's filter.
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setShowConsumed(false);
    setFilter('all');
    setQuery('');
  }
  return { filter, setFilter, query, setQuery, showConsumed, setShowConsumed };
}

/**
 * The History step search: whether the field is open, and the header toggle
 * that opens it. The panel's frame holds it, because the toggle sits in the
 * header rather than the body.
 */
export interface HistoryFind {
  open: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  toggle(): void;
  close(): void;
}

export function useHistoryFind(scope: unknown = null): HistoryFind {
  const [findOpen, setFindOpen] = useState(false);
  const findToggleRef = useRef<HTMLButtonElement>(null);
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setFindOpen(false);
  }
  return {
    open: findOpen,
    toggleRef: findToggleRef,
    toggle: () => setFindOpen((open) => !open),
    close: () => {
      setFindOpen(false);
      // The field unmounts with focus in it; hand focus back to the
      // toggle that opened it rather than dropping it on the page.
      findToggleRef.current?.focus();
    }
  };
}

/**
 * An unapplied History-as-text edit and what it was written against: the
 * document version and the exact text printed from it. The version alone
 * was not enough: a cloud copy taken in a sync conflict can carry the same
 * number with other content, and the whole old text then compiled against
 * it wrote that copy's changes back.
 */
export interface HistoryTextDraft {
  text: string;
  baseVersion: number;
  /** The history printed from the document the edit began on. */
  baseText: string;
}

/**
 * Whether `draft` was written against something other than the document
 * that printed `printed` now: an undo or redo, a restored checkpoint, a
 * collaborator's edit or an adopted cloud copy all change one or the other.
 */
export function historyTextDraftStale(
  draft: HistoryTextDraft,
  version: number,
  printed: string
): boolean {
  return draft.baseVersion !== version || draft.baseText !== printed;
}

/**
 * History as text's edit and any Apply of it in flight. Held by the
 * workspace (HistoryTextView) so both outlive the dialog closing or
 * remounting; a dialog drawn on its own holds them itself.
 */
export interface HistoryTextSession {
  /** The unapplied edit, or null while the text is unedited. */
  draft: HistoryTextDraft | null;
  setDraft: Dispatch<SetStateAction<HistoryTextDraft | null>>;
  /** An Apply is being checked against exact geometry. */
  applying: boolean;
  /**
   * The dialog's status line: what Check found, or how the last Apply
   * ended. Held here so a dialog opened again while an Apply ran shows how
   * it ended, which the closed one could not.
   */
  status: string;
  setStatus(status: string): void;
  /**
   * Marks an Apply of `text` in flight. The returned call ends it and shows
   * `outcome`; once applied it clears the draft only while that still reads
   * `text`, so an edit made after the Apply began is kept. An Apply
   * superseded, or started for another project, ends without a word.
   */
  startApply(text: string): (applied: boolean, outcome: string) => void;
}

/**
 * History as text: whether the dialog is open, its unapplied edit and any
 * Apply in flight. Held above the panel, and the dialog drawn once outside
 * the dock and the phone lane, because crossing the phone breakpoint
 * unmounts one History panel and mounts the other: kept in the panel, the
 * dialog closed and its edit was lost without a word.
 */
export interface HistoryTextView extends HistoryTextSession {
  open: boolean;
  toggle(): void;
  close(): void;
}

export function useHistoryTextSession(
  scope: unknown = null
): HistoryTextSession {
  const [draft, setDraft] = useState<HistoryTextDraft | null>(null);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState('');
  // The Apply in flight, by token: one started for another project, or
  // superseded, ends without touching the current one.
  const running = useRef<number | null>(null);
  const nextToken = useRef(0);
  // Another project's history is other text: an edit printed from this one
  // never carries over, as it did not when the workspace unmounted.
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setDraft(null);
    setApplying(false);
    setStatus('');
    running.current = null;
  }
  return {
    draft,
    setDraft,
    applying,
    status,
    setStatus,
    startApply(text) {
      nextToken.current += 1;
      const token = nextToken.current;
      running.current = token;
      setApplying(true);
      return (applied, outcome) => {
        if (running.current !== token) return;
        running.current = null;
        setApplying(false);
        setStatus(outcome);
        if (applied) {
          setDraft((held) => (held?.text === text ? null : held));
        }
      };
    }
  };
}

export function useHistoryText(scope: unknown = null): HistoryTextView {
  const [open, setOpen] = useState(false);
  const session = useHistoryTextSession(scope);
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setOpen(false);
  }
  return {
    ...session,
    open,
    toggle: () => setOpen((current) => !current),
    // A status belongs to the dialog that showed it; an Apply still running
    // writes its outcome for the next one.
    close: () => {
      setOpen(false);
      session.setStatus('');
    }
  };
}

/** Every model panel's view state, held once for the workspace. */
export interface ModelPanelViews {
  objects: ObjectsView;
  historyFind: HistoryFind;
  historyText: HistoryTextView;
}
