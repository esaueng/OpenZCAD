import {
  ChevronDown,
  Ellipsis,
  ListCollapse,
  List,
  Pin,
  PinOff,
  Search,
  Undo2
} from 'lucide-react';
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent
} from 'react';
import {
  commandContextFor,
  commandContextLabel,
  toolApplies,
  type CommandSelection
} from '../lib/commandContext';
import type { SelectionCalloutContent } from '../lib/selectionCallout';
import type { LabelSegment } from '../lib/topologyLabels';
import {
  DEFAULT_PINNED_TOOLS,
  drawerGroups,
  pinTool,
  railSections,
  shiftPinnedTool,
  suggestedTools,
  TOOL_DRAG_TYPE,
  unpinTool,
  type ToolDrawerFilter,
  type ToolDrawerView
} from '../lib/toolRail';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { toolCommandId, useKeymap } from '../lib/keymap';
import { SelectionRail, selectionRailCollapsed } from './SelectionRail';
import { Tooltip } from './Tooltip';

const TOOL_COUNT = Object.keys(TOOL_META).length;

interface CommandCardProps {
  selection: CommandSelection;
  /**
   * What is picked, in words. The rail does not draw it — the bar at the
   * foot of the stage names the pick — but the summary and the clear action
   * stay in the contract so the caller's wiring is unchanged.
   */
  summary: { label: readonly LabelSegment[]; detail?: string } | null;
  /** Clears the selection; absent while nothing is picked. */
  onClear?: (() => void) | undefined;
  /**
   * A pick with verbs of its own: the rail carries them in place of its
   * pinned tools ({@link SelectionRail}). Null while nothing is picked, or
   * while the pick is a History row's (its card names it).
   */
  pick?: SelectionCalloutContent | null;
  /** The pick, counted: "1 face", "8 edges". */
  pickSummary?: string;
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
  /** The "More tools" drawer, remembered per device in the panel state. */
  moreOpen: boolean;
  onToggleMore(): void;
  /** The tools pinned to the rail, in order; the original eight by default. */
  pinnedTools?: readonly ToolId[];
  onPinnedToolsChange?(tools: ToolId[]): void;
  /** Recently launched tools, newest first, which lead the suggestions. */
  recentTools?: readonly ToolId[];
  /** What the drawer lists: the tools that fit now, or every tool. */
  drawerFilter?: ToolDrawerFilter;
  onDrawerFilterChange?(filter: ToolDrawerFilter): void;
  /**
   * How the drawer opens: the simple list of what fits, or the advanced
   * sheet. Without a handler there is no switch, and the drawer is advanced.
   */
  drawerView?: ToolDrawerView;
  onDrawerViewChange?(view: ToolDrawerView): void;
}

type DragSource = 'pin' | 'suggested' | 'drawer';

/**
 * The verb rail: a thin icon column matching the instrument rail on the
 * right, and the drawer of every tool beside it.
 *
 * The rail's top is the user's: the tools they pinned, in their order,
 * split into Sketch / Create / Finish / Bodies sections. A pin never moves
 * or vanishes with the selection, so the hand can learn it; a pinned tool
 * that does not act on the pick is dimmed in place. Under the pins the rail
 * suggests a few tools for the moment — the ones that can run now and act on
 * the pick, the recently used first — which change as the work does.
 *
 * "More tools" at the foot opens the drawer. Its simple view is a short list
 * of the tools that fit now, icon and name, beside the rail. "All tools &
 * pins" expands it to the advanced view: a sheet the stage's height with a
 * search, a switch between what fits and every tool, each tool's key and a
 * pin on each row. The view is remembered. A tool is pinned by dragging it from the drawer (or up from the
 * suggestions) onto the rail, or with its pin; pins reorder by dragging or
 * Alt+↑/↓, and unpin by dragging them back onto the drawer.
 *
 * A pick makes the rail its own: the pins give way to Deselect all and the
 * pick's verbs, the armed one lit. While a handle is dragged the rail keeps
 * only the verb being made. More tools stays at the foot throughout, so no
 * command is ever out of reach; ⌘K reaches every one by name regardless.
 */
export function CommandCard({
  selection,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen,
  onToggleMore,
  pick = null,
  pickSummary = '',
  pinnedTools = DEFAULT_PINNED_TOOLS,
  onPinnedToolsChange,
  recentTools = [],
  drawerFilter = 'all',
  onDrawerFilterChange,
  drawerView = 'advanced',
  onDrawerViewChange
}: CommandCardProps) {
  const context = commandContextFor(selection);
  const collapsed = pick !== null && selectionRailCollapsed(pick);
  const pins = pick ? [] : pinnedTools;
  const suggested = pick
    ? []
    : suggestedTools(context, availability, pinnedTools, recentTools);
  const onRail = new Set<ToolId>([...pins, ...suggested]);
  const restCount = TOOL_COUNT - onRail.size;
  const keymap = useKeymap();
  const listRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<{
    tool: ToolId;
    from: DragSource;
  } | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // The pin being moved, once it has left its place. Hidden a tick after
  // the drag starts: Chromium cancels a drag whose source disappears inside
  // its own dragstart.
  const [lifted, setLifted] = useState<ToolId | null>(null);
  const focusAfterMove = useRef<ToolId | null>(null);
  const advanced = drawerView === 'advanced' || !onDrawerViewChange;
  // The simple view lists what fits, and has no search to narrow it.
  const filter = advanced ? drawerFilter : 'fits';
  const listed = drawerGroups(
    context,
    availability,
    filter,
    advanced ? query : '',
    activeTool
  );
  // The simple list is what the rail does not already show: the advanced
  // sheet lists everything, so pins can be managed from it.
  const groups = advanced
    ? listed
    : listed
        .map((group) => ({
          ...group,
          tools: group.tools.filter(
            (tool) => tool === activeTool || !onRail.has(tool)
          )
        }))
        .filter((group) => group.tools.length > 0);
  const shownCount = groups.reduce((sum, group) => sum + group.tools.length, 0);
  const below = useGroupsBelowFold(
    listRef,
    moreOpen,
    groups.map((group) => group.tools.join()).join('|')
  );
  const canPin = onPinnedToolsChange !== undefined;

  useLayoutEffect(() => {
    const tool = focusAfterMove.current;
    if (!tool) return;
    focusAfterMove.current = null;
    railRef.current
      ?.querySelector<HTMLElement>(`[data-pinned-tool="${tool}"]`)
      ?.focus();
  });

  const setPins = (next: ToolId[]) => onPinnedToolsChange?.(next);

  const startDrag = (
    event: DragEvent<HTMLElement>,
    tool: ToolId,
    from: DragSource
  ) => {
    if (!canPin) return;
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData(TOOL_DRAG_TYPE, tool);
    event.dataTransfer.setData('text/plain', TOOL_META[tool].label);
    // A row from the drawer drags as the small icon it will be on the rail,
    // not as a ghost of the whole row.
    const image = railDragImage(event.currentTarget);
    try {
      if (image) event.dataTransfer.setDragImage(image, 15, 15);
    } catch {
      // A browser without drag images keeps its own; the drop is the same.
    }
    setDrag({ tool, from });
    if (from === 'pin') window.setTimeout(() => setLifted(tool), 0);
  };
  const endDrag = () => {
    setDrag(null);
    setDropIndex(null);
    setLifted(null);
  };

  /** Where a drop at `clientY` lands, counted among the other pins. */
  const dropIndexAt = (clientY: number, tool: ToolId) => {
    const buttons = Array.from(
      railRef.current?.querySelectorAll<HTMLElement>('[data-pinned-tool]') ?? []
    ).filter((button) => button.dataset.pinnedTool !== tool);
    let index = 0;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) index += 1;
    }
    return index;
  };

  const onRailDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drag.from === 'pin' ? 'move' : 'copy';
    const index = dropIndexAt(event.clientY, drag.tool);
    if (index !== dropIndex) setDropIndex(index);
  };
  const onRailDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.preventDefault();
    setPins(
      pinTool(pinnedTools, drag.tool, dropIndexAt(event.clientY, drag.tool))
    );
    endDrag();
  };
  const onRailDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDropIndex(null);
  };

  const onPinKeyDown = (event: KeyboardEvent<HTMLElement>, tool: ToolId) => {
    if (!canPin || !event.altKey) return;
    const delta =
      event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    focusAfterMove.current = tool;
    setPins(shiftPinnedTool(pinnedTools, tool, delta));
  };

  // The landing slot (the dragged tool's icon, as the rail will draw it)
  // sits before the pin at the drop index, counted without the tool being
  // dragged, or after the last pin. A pin being dragged leaves its place,
  // so off the rail the rail reads as it will once it is unpinned.
  const others = drag ? pins.filter((tool) => tool !== drag.tool) : pins;
  const dropBefore =
    dropIndex !== null && dropIndex < others.length ? others[dropIndex] : null;
  const dropAfter =
    dropIndex !== null && dropIndex >= others.length ? others.at(-1) : null;

  const railButton = (tool: ToolId, from: 'pin' | 'suggested') => {
    const meta = TOOL_META[tool];
    const shortcut = keymap.label(toolCommandId(tool));
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    // The primary verb hints at what to do next; once a tool is armed it
    // yields, so the armed tool is the only lit button.
    const primary = activeTool === null && context.primary === tool;
    const applies = active || toolApplies(context, tool);
    const classes = [
      'command-rail',
      from === 'suggested' && 'is-suggested',
      primary && 'is-primary',
      active && 'active',
      !applies && 'is-dim',
      from === 'pin' && drag?.tool === tool && lifted === tool && 'is-dragging'
    ].filter(Boolean);
    const button = (
      <Tooltip
        label={meta.label}
        shortcut={shortcut}
        description={
          disabledReason ??
          (from === 'suggested'
            ? `${meta.hint}. Suggested now — drag up to pin`
            : meta.hint)
        }
      >
        <button
          type="button"
          className={classes.join(' ')}
          // Greyed by aria, not `disabled`: a disabled button starts no
          // drag, and a greyed pin must still move and a greyed tool still
          // pin. The press is refused here instead.
          aria-disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability, shortcut ?? null)}
          aria-pressed={active}
          data-applies={applies ? 'true' : 'false'}
          data-pinned-tool={from === 'pin' ? tool : undefined}
          draggable={canPin}
          onDragStart={(event) => startDrag(event, tool, from)}
          onDragEnd={endDrag}
          onKeyDown={
            from === 'pin' ? (event) => onPinKeyDown(event, tool) : undefined
          }
          onClick={() => {
            if (disabledReason === null) onLaunchTool(tool);
          }}
        >
          {meta.icon}
        </button>
      </Tooltip>
    );
    // One keyed wrapper whether or not a slot stands beside it, so the
    // button is never remounted under the pointer as the slot moves.
    return (
      <Fragment key={tool}>
        {from === 'pin' && dropBefore === tool && landingSlot}
        {button}
        {from === 'pin' && dropAfter === tool && landingSlot}
      </Fragment>
    );
  };

  const landingSlot = drag && (
    <span className="command-rail-slot" aria-hidden="true">
      {TOOL_META[drag.tool].icon}
    </span>
  );

  const drawerRow = (tool: ToolId) => {
    const meta = TOOL_META[tool];
    const shortcut = keymap.label(toolCommandId(tool));
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    const applies = active || toolApplies(context, tool);
    const pinned = pinnedTools.includes(tool);
    const title = toolTitle(tool, availability, shortcut ?? null);
    return (
      <div
        key={tool}
        className={`command-tile-row${pinned ? ' is-pinned' : ''}`}
      >
        <Tooltip
          label={meta.label}
          shortcut={shortcut}
          description={disabledReason ?? meta.hint}
        >
          <button
            type="button"
            className={`command-tile${active ? ' active' : ''}${applies ? '' : ' is-dim'}`}
            aria-disabled={disabledReason !== null}
            // A tool the rail already carries keeps one button of its own
            // name: the rail's. Its row here says where it is.
            aria-label={onRail.has(tool) ? `On rail: ${title}` : title}
            aria-pressed={active}
            data-applies={applies ? 'true' : 'false'}
            draggable={canPin}
            onDragStart={(event) => startDrag(event, tool, 'drawer')}
            onDragEnd={endDrag}
            onClick={() => {
              if (disabledReason === null) onLaunchTool(tool);
            }}
          >
            {meta.icon}
            <span>{meta.label}</span>
            {advanced && shortcut && <kbd>{shortcut}</kbd>}
          </button>
        </Tooltip>
        {canPin && advanced && (
          <button
            type="button"
            className="command-tile-pin"
            aria-pressed={pinned}
            aria-label={
              pinned
                ? `Unpin ${meta.label} from the rail`
                : `Pin ${meta.label} to the rail`
            }
            title={pinned ? 'Unpin from the rail' : 'Pin to the rail'}
            onClick={() =>
              setPins(
                pinned
                  ? unpinTool(pinnedTools, tool)
                  : pinTool(pinnedTools, tool)
              )
            }
          >
            <Pin size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  const fitsLabel = (() => {
    const pickLabel = commandContextLabel(selection);
    return pickLabel ? `For ${pickLabel}` : 'Ready now';
  })();
  const unpinTarget = drag?.from === 'pin';
  const sections = railSections(pins);

  return (
    // A navigation landmark rather than a toolbar, so the tooltips are told
    // it is a rail: they open beside it instead of over the next tool.
    <nav
      className="tool-palette command-rail"
      aria-label="Feature tools"
      data-context={context.kind}
      data-tooltip-rail=""
    >
      {pick ? (
        <SelectionRail content={pick} summary={pickSummary} />
      ) : (
        <div
          ref={railRef}
          className={`command-rail-pins${drag && drag.from !== 'pin' ? ' is-drop-target' : ''}`}
          onDragOver={onRailDragOver}
          onDragLeave={onRailDragLeave}
          onDrop={onRailDrop}
        >
          {sections.map((section, index) => (
            <Fragment key={`${section.label}-${index}`}>
              {index > 0 && (
                <span className="command-rail-divider" aria-hidden="true" />
              )}
              <section
                role="group"
                aria-label={section.label}
                className="command-rail-group"
              >
                {section.tools.map((tool) => railButton(tool, 'pin'))}
              </section>
            </Fragment>
          ))}
          {sections.length === 0 && dropIndex !== null && landingSlot}
          {sections.length === 0 && dropIndex === null && (
            <span
              className="command-rail-empty"
              title="Drag tools here from More tools to pin them"
              aria-hidden="true"
            >
              <Pin size={14} />
            </span>
          )}
        </div>
      )}
      {suggested.length > 0 && (
        <>
          <span
            className="command-rail-divider is-suggested"
            aria-hidden="true"
          />
          <section
            role="group"
            aria-label="Suggested"
            className="command-rail-group command-rail-suggested"
          >
            {suggested.map((tool) => railButton(tool, 'suggested'))}
          </section>
        </>
      )}
      {!collapsed && (
        <span className="command-rail-divider" aria-hidden="true" />
      )}
      {!collapsed && (
        <section
          role="group"
          aria-label="All tools"
          className={`command-more${moreOpen ? ' open' : ''}`}
        >
          <Tooltip
            label={moreOpen ? 'Hide other tools' : 'More tools'}
            description={
              moreOpen
                ? 'Close the list of the other tools'
                : `Every tool by name — ${restCount} not on the rail. Drag one onto the rail to pin it`
            }
          >
            <button
              type="button"
              className={`command-rail command-more-toggle${moreOpen ? ' active' : ''}`}
              aria-expanded={moreOpen}
              aria-label={`More tools (${restCount})`}
              onClick={onToggleMore}
            >
              <Ellipsis size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {moreOpen && (
            // A drawer beside the rail: help for a rail button next to it
            // drops its description, and a row's help opens beside the
            // drawer rather than over the rows below it.
            <div
              className={`command-flyout ${advanced ? 'is-advanced' : 'is-simple'}${below.length > 0 ? ' has-more-below' : ''}${unpinTarget ? ' is-unpin-target' : ''}`}
              data-rail-flyout=""
              onDragOver={(event) => {
                if (!unpinTarget) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                if (!drag || drag.from !== 'pin') return;
                event.preventDefault();
                setPins(unpinTool(pinnedTools, drag.tool));
                endDrag();
              }}
            >
              {advanced && (
                <div className="command-flyout-head">
                  <label className="command-flyout-search">
                    <Search size={13} aria-hidden="true" />
                    <input
                      type="search"
                      aria-label="Find a tool"
                      placeholder="Find a tool"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && query) {
                          event.stopPropagation();
                          setQuery('');
                        }
                      }}
                    />
                  </label>
                  {onDrawerFilterChange && (
                    <div
                      className="command-flyout-filter"
                      role="group"
                      aria-label="Show tools"
                    >
                      <button
                        type="button"
                        aria-pressed={drawerFilter === 'fits'}
                        onClick={() => onDrawerFilterChange('fits')}
                      >
                        {fitsLabel}
                      </button>
                      <button
                        type="button"
                        aria-pressed={drawerFilter === 'all'}
                        onClick={() => onDrawerFilterChange('all')}
                      >
                        All {TOOL_COUNT}
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div
                ref={listRef}
                className="command-flyout-list"
                data-tooltip-rail="vertical"
              >
                {groups.map((group) => (
                  <Fragment key={group.label}>
                    <span
                      className="command-flyout-heading"
                      data-group={group.label}
                    >
                      {group.label}
                    </span>
                    {group.tools.map(drawerRow)}
                  </Fragment>
                ))}
                {groups.length === 0 && (
                  <p className="command-flyout-empty">
                    {advanced && query
                      ? `No tool matches “${query}”`
                      : advanced
                        ? 'Nothing fits this pick'
                        : 'Everything that fits is on the rail'}
                  </p>
                )}
                {below.length > 0 && (
                  // A short window hides whole groups (Pattern, under
                  // Bodies) past a fold only a 10px shade marked (F017).
                  // This names them and scrolls the first into view. The
                  // keyboard needs no stop of its own: a focused row already
                  // scrolls into view.
                  <button
                    type="button"
                    className="command-flyout-more"
                    tabIndex={-1}
                    aria-label={`Scroll to ${below.join(', ')}`}
                    onClick={() => {
                      const list = listRef.current;
                      const heading = Array.from(
                        list?.querySelectorAll<HTMLElement>(
                          '.command-flyout-heading'
                        ) ?? []
                      ).find(
                        (candidate) => candidate.dataset.group === below[0]
                      );
                      if (!list || !heading) return;
                      list.scrollTo({
                        top: heading.offsetTop - 4,
                        behavior: 'smooth'
                      });
                    }}
                  >
                    <span>
                      More: {below[0]}
                      {below.length > 1 && ` +${below.length - 1}`}
                      <ChevronDown size={12} aria-hidden="true" />
                    </span>
                  </button>
                )}
              </div>
              {/* The switch between the views stands at the foot's left in
                  both, so it is under the pointer to switch straight back. */}
              <div className="command-flyout-foot">
                {onDrawerViewChange && (
                  <button
                    type="button"
                    className="command-flyout-view"
                    onClick={() =>
                      onDrawerViewChange(advanced ? 'simple' : 'advanced')
                    }
                  >
                    {advanced ? (
                      <ListCollapse size={12} aria-hidden="true" />
                    ) : (
                      <List size={12} aria-hidden="true" />
                    )}
                    {advanced ? 'Simple view' : 'All tools & pins'}
                    {!advanced && TOOL_COUNT - shownCount > 0 && (
                      <span className="command-flyout-count">
                        +{TOOL_COUNT - shownCount}
                      </span>
                    )}
                  </button>
                )}
                {advanced && unpinTarget && (
                  <span className="command-flyout-hint">
                    <PinOff size={12} aria-hidden="true" /> Drop to unpin
                  </span>
                )}
                {advanced && (
                  <span className="command-flyout-spacer" aria-hidden="true" />
                )}
                {canPin && advanced && (
                  <button
                    type="button"
                    className="command-flyout-reset"
                    aria-label="Reset pinned tools"
                    title="Reset the rail to its original tools"
                    disabled={
                      pinnedTools.join() === DEFAULT_PINNED_TOOLS.join()
                    }
                    onClick={() => setPins([...DEFAULT_PINNED_TOOLS])}
                  >
                    <Undo2 size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}
    </nav>
  );
}

/**
 * A rail-sized copy of a tool's icon to drag by, gone once the browser has
 * taken its picture; null when the source has no icon.
 */
function railDragImage(source: HTMLElement): HTMLElement | null {
  const icon = source.querySelector('svg');
  if (!icon) return null;
  const image = document.createElement('div');
  image.className = 'command-drag-image';
  image.appendChild(icon.cloneNode(true));
  document.body.appendChild(image);
  window.setTimeout(() => image.remove(), 0);
  return image;
}

/**
 * The drawer's groups whose heading is past the list's scrolled fold, in
 * order: none in a window tall enough for the whole list. Measured on open,
 * on scroll, on resize and whenever the listed tools change; a heading
 * counts as hidden once the overflow cue itself would cover it.
 */
function useGroupsBelowFold(
  listRef: { readonly current: HTMLDivElement | null },
  open: boolean,
  listKey: string
): string[] {
  const [below, setBelow] = useState<string[]>([]);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) {
      setBelow((current) => (current.length === 0 ? current : []));
      return;
    }
    const measure = () => {
      let hidden: string[] = [];
      if (list.scrollHeight > list.clientHeight + 1) {
        const cue =
          list.querySelector<HTMLElement>('.command-flyout-more')
            ?.offsetHeight ?? 0;
        const fold = list.scrollTop + list.clientHeight - cue;
        hidden = Array.from(
          list.querySelectorAll<HTMLElement>('.command-flyout-heading')
        )
          .filter((heading) => heading.offsetTop + heading.offsetHeight > fold)
          .map((heading) => heading.dataset.group ?? '');
      }
      setBelow((current) =>
        current.join('|') === hidden.join('|') ? current : hidden
      );
    };
    measure();
    list.addEventListener('scroll', measure, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [listRef, open, listKey]);
  return below;
}
