import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Ellipsis, Plus } from 'lucide-react';
import {
  DRAWING_PAPER_LABELS,
  MAX_DRAWING_TEXT_LENGTH,
  formatDrawingScale,
  type DrawingSheet,
  type DrawingSheetId
} from '@openzcad/shared';
import { useMenuKeyboard } from '../lib/useMenuKeyboard';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

export interface DrawingSheetTabsProps {
  sheets: readonly DrawingSheet[];
  activeId: DrawingSheetId;
  onSelect(sheetId: DrawingSheetId): void;
  onCreate(): void;
  createDisabled: boolean;
  createTitle: string;
  /**
   * Sheet edits from a tab's menu (right-click, Shift+F10, or the Sheet
   * actions button) and by dragging a tab (review I62). Without them the
   * strip only selects.
   */
  onRename?(sheetId: DrawingSheetId, name: string): void;
  onDuplicate?(sheetId: DrawingSheetId): void;
  onMove?(sheetId: DrawingSheetId, index: number): void;
  onDelete?(sheetId: DrawingSheetId): void;
  /** Why the sheet edits are unavailable, or null when they are. */
  editDisabledReason?: string | null;
}

interface TabMenu {
  sheetId: DrawingSheetId;
  x: number;
  y: number;
}

function sheetMenuItems(
  index: number,
  count: number,
  props: DrawingSheetTabsProps,
  editable: boolean
): ContextMenuItem[] {
  const why = props.editDisabledReason ?? undefined;
  const item = (
    id: string,
    label: string,
    available: boolean,
    extra: Partial<ContextMenuItem> = {}
  ): ContextMenuItem => ({
    id,
    label,
    disabled: !editable || !available,
    ...(!editable && why ? { detail: why } : {}),
    ...extra
  });
  return [
    item('rename', 'Rename', Boolean(props.onRename), { shortcut: 'F2' }),
    item('duplicate', 'Duplicate', Boolean(props.onDuplicate)),
    item('move-left', 'Move left', Boolean(props.onMove) && index > 0, {
      section: true
    }),
    item(
      'move-right',
      'Move right',
      Boolean(props.onMove) && index < count - 1
    ),
    item('delete', 'Delete sheet', Boolean(props.onDelete), {
      danger: true,
      section: true
    })
  ];
}

/** A tab's name edited in place: Enter or leaving saves, Escape keeps it. */
function SheetNameField({
  name,
  onDone
}: {
  name: string;
  onDone(name: string | null): void;
}) {
  const [draft, setDraft] = useState(name);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      className="drawing-sheet-tab-rename"
      aria-label={`Rename ${name}`}
      value={draft}
      maxLength={MAX_DRAWING_TEXT_LENGTH}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(draft.trim() || null)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(draft.trim() || null);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

/** The short paper name a tab and the list show: "A3", "ANSI B". */
export function sheetPaperTag(sheet: DrawingSheet): string {
  return DRAWING_PAPER_LABELS[sheet.paper.size].split(' (')[0]!;
}

/**
 * The sheet tabs: one row that scrolls sideways instead of wrapping, so
 * seventeen sheets cost the stage the same height as two. The row fades at
 * an edge that hides tabs, keeps the active tab in view, and once it
 * overflows gains an "All sheets" list that reaches any sheet in one pick.
 * The paper tag shows only when the sheets differ in paper: on a set of A3
 * sheets it would repeat "A3" on every tab and tell nobody anything.
 */
export function DrawingSheetTabs(props: DrawingSheetTabsProps) {
  const { sheets, activeId, onSelect } = props;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const listButtonRef = useRef<HTMLButtonElement | null>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const [listOpen, setListOpen] = useState(false);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [renaming, setRenaming] = useState<DrawingSheetId | null>(null);
  const [dragging, setDragging] = useState<DrawingSheetId | null>(null);
  const [dropTarget, setDropTarget] = useState<DrawingSheetId | null>(null);
  const editable =
    Boolean(props.onRename || props.onMove || props.onDelete) &&
    !props.editDisabledReason;
  const mixedPaper = new Set(sheets.map((entry) => entry.paper.size)).size > 1;
  const overflowing = edges.before || edges.after;

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const before = strip.scrollLeft > 1;
    const after = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setEdges((current) =>
      current.before === before && current.after === after
        ? current
        : { before, after }
    );
  }, []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [measure, sheets.length, mixedPaper]);

  // The active tab stays in view: picked from the list, created at the end,
  // or reached with the arrow keys.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab) return;
    const left =
      tab.getBoundingClientRect().left -
      strip.getBoundingClientRect().left +
      strip.scrollLeft;
    const right = left + tab.offsetWidth;
    // Clear of the edge fade, with a little of the neighbour showing so the
    // edge still reads as "more".
    const margin = 48;
    if (left < strip.scrollLeft) {
      strip.scrollLeft = Math.max(0, left - margin);
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth + margin;
    }
    measure();
  }, [activeId, sheets.length, measure]);

  // A plain wheel scrolls the row sideways; a trackpad's own sideways swipe
  // already does.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        strip.scrollWidth <= strip.clientWidth
      ) {
        return;
      }
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  // Arrow keys move between tabs, as a tablist promises.
  const tabElement = (sheetId: DrawingSheetId) =>
    stripRef.current?.querySelector<HTMLElement>(
      `[data-sheet-id="${sheetId}"]`
    ) ?? null;

  const openMenuAt = (sheetId: DrawingSheetId, anchor: HTMLElement | null) => {
    const rect = anchor?.getBoundingClientRect();
    setMenu({
      sheetId,
      x: rect ? rect.left : 0,
      y: rect ? rect.bottom + 2 : 0
    });
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const index = sheets.findIndex((entry) => entry.sheetId === activeId);
    if (
      event.key === 'ContextMenu' ||
      (event.key === 'F10' && event.shiftKey)
    ) {
      event.preventDefault();
      openMenuAt(activeId, tabElement(activeId));
      return;
    }
    if (event.key === 'F2' && editable && props.onRename) {
      event.preventDefault();
      setRenaming(activeId);
      return;
    }
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % sheets.length;
    else if (event.key === 'ArrowLeft')
      next = (index - 1 + sheets.length) % sheets.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sheets.length - 1;
    if (next === null || next === index) return;
    event.preventDefault();
    const target = sheets[next]!;
    onSelect(target.sheetId);
    requestAnimationFrame(() =>
      stripRef.current
        ?.querySelector<HTMLElement>(`[data-sheet-id="${target.sheetId}"]`)
        ?.focus({ preventScroll: true })
    );
  };

  return (
    <div
      className={`drawing-sheet-strip${edges.before ? ' has-before' : ''}${edges.after ? ' has-after' : ''}`}
    >
      <div
        ref={stripRef}
        className="drawing-sheet-tabs"
        role="tablist"
        aria-label="Drawing sheets"
        onScroll={measure}
        onKeyDown={onTabKeyDown}
      >
        {sheets.map((entry, index) => {
          const active = entry.sheetId === activeId;
          if (renaming === entry.sheetId)
            return (
              <SheetNameField
                key={entry.sheetId}
                name={entry.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name !== null && name !== entry.name)
                    props.onRename?.(entry.sheetId, name);
                  requestAnimationFrame(() =>
                    tabElement(entry.sheetId)?.focus({ preventScroll: true })
                  );
                }}
              />
            );
          return (
            <button
              key={entry.sheetId}
              type="button"
              role="tab"
              data-sheet-id={entry.sheetId}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`drawing-sheet-tab${active ? ' active' : ''}${
                dropTarget === entry.sheetId && dragging !== entry.sheetId
                  ? ' is-drop-target'
                  : ''
              }`}
              title={
                editable
                  ? `${entry.name} · right-click or Shift+F10 for sheet actions; drag to reorder`
                  : entry.name
              }
              draggable={editable && Boolean(props.onMove)}
              onClick={() => onSelect(entry.sheetId)}
              onDoubleClick={() => {
                if (editable && props.onRename) setRenaming(entry.sheetId);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                onSelect(entry.sheetId);
                setMenu({
                  sheetId: entry.sheetId,
                  x: event.clientX,
                  y: event.clientY
                });
              }}
              onDragStart={(event) => {
                setDragging(entry.sheetId);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', entry.name);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTarget(entry.sheetId);
              }}
              onDragLeave={() =>
                setDropTarget((current) =>
                  current === entry.sheetId ? null : current
                )
              }
              onDrop={(event) => {
                event.preventDefault();
                if (dragging && dragging !== entry.sheetId)
                  props.onMove?.(dragging, index);
                setDragging(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
            >
              <span className="drawing-sheet-tab-name">{entry.name}</span>
              {mixedPaper && (
                <span className="drawing-sheet-tab-paper" aria-hidden="true">
                  {sheetPaperTag(entry)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {overflowing && (
        <button
          ref={listButtonRef}
          type="button"
          className={`drawing-sheet-list-button${listOpen ? ' active' : ''}`}
          aria-haspopup="menu"
          aria-expanded={listOpen}
          aria-label={`All sheets (${sheets.length})`}
          title="All sheets"
          onClick={() => setListOpen((current) => !current)}
        >
          <span className="drawing-sheet-count">{sheets.length}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
      {props.onRename || props.onDuplicate || props.onMove || props.onDelete ? (
        <button
          type="button"
          className="drawing-sheet-new drawing-sheet-actions"
          aria-label="Sheet actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          title="Rename, duplicate, move or delete this sheet"
          onClick={(event) => openMenuAt(activeId, event.currentTarget)}
        >
          <Ellipsis size={14} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className="drawing-sheet-new"
        aria-label="New sheet"
        onClick={props.onCreate}
        disabled={props.createDisabled}
        title={props.createTitle}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      {menu ? (
        <ContextMenu
          menu={{
            x: menu.x,
            y: menu.y,
            heading:
              sheets.find((entry) => entry.sheetId === menu.sheetId)?.name ??
              'Sheet',
            items: sheetMenuItems(
              sheets.findIndex((entry) => entry.sheetId === menu.sheetId),
              sheets.length,
              props,
              editable
            )
          }}
          onSelect={(itemId) => {
            const sheetId = menu.sheetId;
            const index = sheets.findIndex(
              (entry) => entry.sheetId === sheetId
            );
            setMenu(null);
            if (itemId === 'rename') setRenaming(sheetId);
            else if (itemId === 'duplicate') props.onDuplicate?.(sheetId);
            else if (itemId === 'move-left') props.onMove?.(sheetId, index - 1);
            else if (itemId === 'move-right')
              props.onMove?.(sheetId, index + 1);
            else if (itemId === 'delete') props.onDelete?.(sheetId);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {listOpen &&
        overflowing &&
        createPortal(
          <SheetList
            sheets={sheets}
            activeId={activeId}
            anchorRef={listButtonRef}
            onSelect={(sheetId) => {
              onSelect(sheetId);
              setListOpen(false);
            }}
            onClose={() => setListOpen(false)}
          />,
          document.body
        )}
    </div>
  );
}

function SheetList({
  sheets,
  activeId,
  anchorRef,
  onSelect,
  onClose
}: {
  sheets: readonly DrawingSheet[];
  activeId: DrawingSheetId;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onSelect(sheetId: DrawingSheetId): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  useMenuKeyboard(ref);

  // Under the button, its right edges aligned, inside the window.
  useLayoutEffect(() => {
    const menu = ref.current?.getBoundingClientRect();
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!menu || !anchor) return;
    setPosition({
      x: Math.max(
        8,
        Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 8)
      ),
      y: Math.max(
        8,
        Math.min(anchor.bottom + 6, window.innerHeight - menu.height - 8)
      )
    });
    ref.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        ref.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchorRef, onClose]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    anchorRef.current?.focus({ preventScroll: true });
    onClose();
  };

  return (
    <div
      ref={ref}
      className="context-menu drawing-sheet-list"
      role="menu"
      aria-labelledby={`${id}-heading`}
      tabIndex={-1}
      style={
        position
          ? { left: position.x, top: position.y }
          : { left: 0, top: 0, opacity: 0 }
      }
      onKeyDown={onMenuKeyDown}
    >
      <div id={`${id}-heading`} className="context-menu-heading">
        {sheets.length} sheets
      </div>
      {sheets.map((entry, index) => {
        const views = entry.views.length;
        const dims = entry.annotations?.length ?? 0;
        return (
          <button
            key={entry.sheetId}
            type="button"
            role="menuitemradio"
            aria-checked={entry.sheetId === activeId}
            className="context-menu-item drawing-sheet-list-item"
            onClick={() => onSelect(entry.sheetId)}
          >
            <span className="drawing-sheet-list-index" aria-hidden="true">
              {index + 1}
            </span>
            <span className="context-menu-label">
              {entry.name}
              <span className="context-menu-detail">
                {`${sheetPaperTag(entry)} · ${formatDrawingScale(entry.scale)} · ${views} ${views === 1 ? 'view' : 'views'}${dims > 0 ? ` · ${dims} ${dims === 1 ? 'note' : 'notes'}` : ''}`}
              </span>
            </span>
            <span className="context-menu-icon" aria-hidden="true">
              {entry.sheetId === activeId && <Check size={13} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
