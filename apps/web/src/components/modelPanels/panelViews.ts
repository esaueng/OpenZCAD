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

/** An unapplied History-as-text edit and the version it was printed from. */
export interface HistoryTextDraft {
  text: string;
  baseVersion: number;
}

/**
 * History as text: whether the dialog is open, and its unapplied edit. Held
 * above the panel, and the dialog drawn once outside the dock and the phone
 * lane, because crossing the phone breakpoint unmounts one History panel and
 * mounts the other: kept in the panel, the dialog closed and its edit was
 * lost without a word.
 */
export interface HistoryTextView {
  open: boolean;
  toggle(): void;
  close(): void;
  /** The unapplied edit, or null while the text is unedited. */
  draft: HistoryTextDraft | null;
  setDraft: Dispatch<SetStateAction<HistoryTextDraft | null>>;
}

export function useHistoryText(scope: unknown = null): HistoryTextView {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<HistoryTextDraft | null>(null);
  // Another project's history is other text: an edit printed from this one
  // never carries over, as it did not when the workspace unmounted.
  const [shownScope, setShownScope] = useState(scope);
  if (shownScope !== scope) {
    setShownScope(scope);
    setOpen(false);
    setDraft(null);
  }
  return {
    open,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
    draft,
    setDraft
  };
}

/** Every model panel's view state, held once for the workspace. */
export interface ModelPanelViews {
  objects: ObjectsView;
  historyFind: HistoryFind;
  historyText: HistoryTextView;
}
