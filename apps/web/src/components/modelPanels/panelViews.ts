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

/** Every model panel's view state, held once for the workspace. */
export interface ModelPanelViews {
  objects: ObjectsView;
  historyFind: HistoryFind;
}
