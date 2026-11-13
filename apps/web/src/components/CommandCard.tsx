import {
  ChevronDown,
  Ellipsis,
  ListCollapse,
  List,
  Pin,
  PinOff,
  Search,
  Undo2,
  X
} from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
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
  type CommandContextKind,
  type CommandSelection
} from '../lib/commandContext';
import type {
  SelectionCalloutContent,
  SelectionCalloutVerb
} from '../lib/selectionCallout';
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
  TOOL_GROUPS,
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolGroup,
  type ToolId
} from '../lib/tools';
import { toolCommandId, useKeymap } from '../lib/keymap';
import { selectionRailHeld } from '../lib/selectionRailHold';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useRovingToolbar } from '../hooks/useRovingToolbar';
import { SelectionRail, useHeldPick } from './SelectionRail';
import { Tooltip } from './Tooltip';

const TOOL_COUNT = Object.keys(TOOL_META).length;

/** A drawer section's id by the heading it is listed under. */
const SECTION_BY_LABEL = new Map(
  TOOL_GROUPS.map((group) => [group.label, group.id] as const)
);

/** The breathing room left above a heading scrolled to the list's top. */
const HEADING_GAP_PX = 4;

/**
 * The rail's stops for the arrow keys: its tools, the pick's verbs and the
 * Tools button, with the two marks under a pick's verbs that carry help of
 * their own. The drawer beside the rail is not one of them: it is a list
 * with a search field, and Tab walks it.
 */
const RAIL_STOPS =
  'button.command-rail, .selection-rail-badge, .selection-rail-phase.has-icon';
const RAIL_STOPS_EXCEPT = '.command-flyout';
/**
 * The stage height at which quiet-stage.css lays the advanced drawer out as
 * a grid with the close button beside the search rather than over it. The
 * two must agree: the markup's order follows the layout this names.
 */
const SHORT_STAGE_QUERY = '(max-height: 540px)';

/** What the heading over a pick's verbs calls each kind of pick. */
const PICK_KINDS: Partial<Record<CommandContextKind, string>> = {
  edges: 'Edge',
  face: 'Face',
  region: 'Region',
  body: 'Body',
  bodies: 'Body'
};

/**
 * What a suggested tool says of itself, in its help and after its name: why
 * it is on the rail today and may not be tomorrow, and how to keep it.
 */
const SUGGESTED_HELP = 'Suggested for this step — drag up to pin';

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
  /**
   * The document's history position: a pick that leaves the rail while it
   * is held is drawn as a check in flight only while this stays put, so an
   * Undo under a drag gives the rail back at once ({@link useHeldPick}).
   */
  pickRevision?: unknown;
  /** Whether a held pick's target still exists in the document. */
  isPickLive?: ((pick: SelectionCalloutContent) => boolean) | undefined;
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
  /**
   * The drawer's section last scrolled to, remembered as the list scrolls
   * and opened on again. Without a handler nothing is remembered.
   */
  drawerSection?: ToolGroup | null;
  onDrawerSectionChange?(section: ToolGroup): void;
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
 * The drawer is docked, not a popover: it is remembered open, and a click on
 * the model or a pick leaves it where it is, the way a model panel stays.
 * So it is drawn as part of the rail (joined to its edge, with a panel's
 * header), it has a close button of its own, and Escape closes it from
 * inside, from its button, and from the idle workspace once nothing is left
 * to cancel or clear (App's Escape ladder). It stands under every popover
 * and the command bar's results, which are the temporary surfaces.
 *
 * A pick makes the rail its own: the pins give way to a heading naming the
 * pick, Deselect all and the pick's verbs, the armed one lit. While a handle
 * is dragged the rail holds: every button stays where it was, only the verb
 * being made still acts. More tools stays at the foot throughout, so the
 * rail never jumps and no command is ever more than the drag away; ⌘K
 * reaches every one by name regardless.
 *
 * The rail is one tab stop (useRovingToolbar): the arrow keys move between
 * its tools, greyed ones included, so Tab passes it in one press.
 */
export function CommandCard({
  selection,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen,
  onToggleMore,
  pick: pickProp = null,
  pickRevision,
  isPickLive,
  pickSummary = '',
  pinnedTools = DEFAULT_PINNED_TOOLS,
  onPinnedToolsChange,
  recentTools = [],
  drawerFilter = 'all',
  onDrawerFilterChange,
  drawerView = 'advanced',
  onDrawerViewChange,
  drawerSection = null,
  onDrawerSectionChange
}: CommandCardProps) {
  const context = commandContextFor(selection);
  // A pick that drops out mid-drag is still drawn, held, for a moment: the
  // release can lose it for a frame or two, and the pins in its place
  // flashed the whole tool list in and straight back out.
  const pick = useHeldPick(pickProp, {
    revision: pickRevision,
    isLive: isPickLive
  });
  const held = pick !== null && selectionRailHeld(pick);
  // The drawer as it is drawn: a held rail closes it without forgetting it
  // was open, so it comes back once the drag is done. Everything that says
  // or measures the drawer reads this, never the remembered flag, so the
  // toggle never claims an open drawer that is not there and the layout
  // hooks let go of a drawer that has gone.
  const drawerOpen = moreOpen && !held;
  const pins = pick ? [] : pinnedTools;
  const suggested = pick
    ? []
    : suggestedTools(context, availability, pinnedTools, recentTools);
  const onRail = new Set<ToolId>([...pins, ...suggested]);
  // What the rail draws while a pick owns it: the pick's verbs that are
  // tools. The simple list skips them as it skips pins, so Shell is not
  // offered twice side by side.
  const pickTools = new Set<ToolId>(
    (pick?.verbs ?? []).flatMap((verb) => {
      const tool = verbTool(verb.id);
      return tool ? [tool] : [];
    })
  );
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
            (tool) =>
              tool === activeTool || (!onRail.has(tool) && !pickTools.has(tool))
          )
        }))
        .filter((group) => group.tools.length > 0);
  const shownCount = groups.reduce((sum, group) => sum + group.tools.length, 0);
  const below = useGroupsBelowFold(
    listRef,
    drawerOpen,
    groups.map((group) => group.tools.join()).join('|')
  );
  // A search narrows the sections to its matches: scrolling those says
  // nothing about where the full list was left.
  useRememberedSection(
    listRef,
    drawerOpen,
    drawerSection,
    advanced && query ? undefined : onDrawerSectionChange
  );
  const canPin = onPinnedToolsChange !== undefined;
  const moreToggleRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  useRovingToolbar(toolbarRef, {
    items: RAIL_STOPS,
    except: RAIL_STOPS_EXCEPT,
    // A pick's rail is entered at its head, not on the Tools button the
    // Build rail was last left on.
    resetOn: pick !== null
  });
  const closeDrawer = () => {
    onToggleMore();
    moreToggleRef.current?.focus();
  };
  /** Back to the drawer's button, unless something else took the keyboard. */
  const restoreFocusToToggle = () => {
    const toggle = moreToggleRef.current;
    const active = toggle?.ownerDocument.activeElement;
    if (toggle && (!active || active === toggle.ownerDocument.body))
      toggle.focus();
  };
  // The drawer's name and its way out, at the head in both views: a drawer
  // that stays through clicks elsewhere needs a close button on itself, not
  // only the button that opened it. On a short stage the advanced sheet
  // draws this to the right of its search and filters, so it follows them
  // in the markup there: Tab then meets the head's controls in the order
  // they are drawn (WCAG 2.4.3). The stylesheet places both by name, so
  // only the keyboard's order depends on where this stands.
  const closeAfterHead = useMediaQuery(SHORT_STAGE_QUERY) && advanced;
  // Moving the title takes its button out of the document and back, which
  // drops the keyboard's focus if it was there (a phone turned on its side
  // with the close button focused): hand it back.
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeFocused = useRef(false);
  useLayoutEffect(() => {
    if (closeFocused.current && !closeRef.current?.matches(':focus'))
      closeRef.current?.focus();
  }, [closeAfterHead]);
  const drawerTitle = (
    <div className="command-flyout-title">
      <span>Tools</span>
      <button
        ref={closeRef}
        type="button"
        className="command-flyout-close"
        onFocus={() => (closeFocused.current = true)}
        onBlur={() => (closeFocused.current = false)}
        aria-label="Close tools drawer"
        title="Close (Esc)"
        onClick={closeDrawer}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
  const focusOnOpen = useRef(false);
  const drawerId = useId();
  useLayoutEffect(() => {
    if (!drawerOpen || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    flyoutRef.current
      ?.querySelector<HTMLElement>('input[type="search"]')
      ?.focus();
  }, [drawerOpen]);
  useFlyoutAtToggle(
    flyoutRef,
    moreToggleRef,
    drawerOpen && !advanced,
    groups.map((group) => group.tools.join()).join('|')
  );

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

  /** Where a drop lands in the rail's one- or two-column reading order. */
  const dropIndexAt = (clientX: number, clientY: number, tool: ToolId) => {
    const buttons = Array.from(
      railRef.current?.querySelectorAll<HTMLElement>('[data-pinned-tool]') ?? []
    ).filter((button) => button.dataset.pinnedTool !== tool);
    const boxes = buttons.map((button) => button.getBoundingClientRect());
    const twoColumns = new Set(boxes.map((box) => box.left)).size > 1;
    let index = 0;
    for (const rect of boxes) {
      if (
        twoColumns
          ? clientY > rect.bottom ||
            (clientY >= rect.top &&
              clientY <= rect.bottom &&
              clientX > rect.left + rect.width / 2)
          : clientY > rect.top + rect.height / 2
      )
        index += 1;
    }
    return index;
  };

  const onRailDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = drag.from === 'pin' ? 'move' : 'copy';
    const index = dropIndexAt(event.clientX, event.clientY, drag.tool);
    if (index !== dropIndex) setDropIndex(index);
  };
  const onRailDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!drag) return;
    event.preventDefault();
    setPins(
      pinTool(
        pinnedTools,
        drag.tool,
        dropIndexAt(event.clientX, event.clientY, drag.tool)
      )
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
          (from === 'suggested' ? `${meta.hint}. ${SUGGESTED_HELP}` : meta.hint)
        }
      >
        <button
          type="button"
          className={classes.join(' ')}
          // Greyed by aria, not `disabled`: a disabled button starts no
          // drag, and a greyed pin must still move and a greyed tool still
          // pin. The press is refused here instead.
          aria-disabled={disabledReason !== null}
          // A suggestion says so after its name: the dot on it is the only
          // other mark, and a name that still starts with the tool's is
          // found by everything that looks the tool up.
          aria-label={
            from === 'suggested'
              ? `${toolTitle(tool, availability, shortcut ?? null)}. ${SUGGESTED_HELP}`
              : toolTitle(tool, availability, shortcut ?? null)
          }
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
        {/* No tooltip: the row already reads its name (and, in the full
            list, its hint and key), so help beside it only repeated the
            label. Its accessible name carries all three. */}
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
          onClick={(event) => {
            if (disabledReason !== null) return;
            const hadFocus =
              event.currentTarget.ownerDocument.activeElement ===
              event.currentTarget;
            onLaunchTool(tool);
            if (!drawerOpen) return;
            // A tool taken from the drawer ends the browsing: the drawer
            // goes away rather than waiting out the command and coming
            // back over the stage. A greyed row leaves it open, as its
            // reason is what the reader came for.
            onToggleMore();
            // The row goes with the drawer. A command that takes the
            // keyboard (its bar, its panel) has it by the next frame; one
            // that does not (Move) would leave it on the page, so it goes
            // back to the button that opens the drawer again.
            if (hadFocus) requestAnimationFrame(restoreFocusToToggle);
          }}
        >
          {meta.icon}
          <span className="command-tile-description">
            <span>{meta.label}</span>
            {advanced && <small>{disabledReason ?? meta.hint}</small>}
          </span>
          {advanced && shortcut && <kbd>{shortcut}</kbd>}
        </button>
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
    // A vertical toolbar: one tab stop, the arrow keys inside it. Marked as
    // a rail for the tooltips as well, which open beside it instead of over
    // the next tool whatever the layout a short window gives it.
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-orientation="vertical"
      className="tool-palette command-rail"
      aria-label="Feature tools"
      data-context={context.kind}
      data-rail={pick ? 'selection' : 'build'}
      data-tooltip-rail=""
    >
      {pick ? (
        <SelectionRail
          content={pick}
          summary={pickSummary}
          kind={PICK_KINDS[context.kind]}
          count={pickCount(selection, context.kind)}
        />
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
      <span className="command-rail-divider" aria-hidden="true" />
      <section
        role="group"
        aria-label="All tools"
        className={`command-more${drawerOpen ? ' open' : ''}`}
        // Escape closes the drawer from its button as well as from inside
        // it, and hands the keyboard back to the button.
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !drawerOpen) return;
          event.preventDefault();
          event.stopPropagation();
          closeDrawer();
        }}
      >
        <Tooltip
          label={drawerOpen ? 'Hide other tools' : 'More tools'}
          description={
            held
              ? 'Available once the drag is done'
              : drawerOpen
                ? 'Close the list of the other tools'
                : `Every tool by name — ${restCount} not on the rail. Drag one onto the rail to pin it`
          }
        >
          <button
            ref={moreToggleRef}
            type="button"
            className={`command-rail command-more-toggle${drawerOpen ? ' active' : ''}`}
            aria-expanded={drawerOpen}
            aria-controls={drawerOpen ? drawerId : undefined}
            aria-label={`More tools (${restCount})`}
            // Kept in place while a drag holds the rail, so the rail never
            // changes height; nothing else acts on the pick until it is done.
            // Greyed by aria, as the tools are: a disabled button drops the
            // keyboard's focus, and the arrow keys could not reach it.
            aria-disabled={held}
            onClick={(event) => {
              if (held) return;
              if (!drawerOpen) focusOnOpen.current = event.detail === 0;
              onToggleMore();
            }}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {drawerOpen && (
          // A drawer docked to the rail: help for a rail button next to it
          // drops its description, and its rows, which name themselves,
          // carry no help of their own.
          <div
            ref={flyoutRef}
            id={drawerId}
            role="group"
            aria-label="Tools drawer"
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
            {!closeAfterHead && drawerTitle}
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
            {closeAfterHead && drawerTitle}
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
                    data-section={SECTION_BY_LABEL.get(group.label)}
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
            </div>
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
                  ).find((candidate) => candidate.dataset.group === below[0]);
                  if (!list || !heading) return;
                  list.scrollTo({
                    top: heading.offsetTop - HEADING_GAP_PX,
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
                  disabled={pinnedTools.join() === DEFAULT_PINNED_TOOLS.join()}
                  onClick={() => setPins([...DEFAULT_PINNED_TOOLS])}
                >
                  <Undo2 size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** How many of its kind the pick holds, for the rail's heading. */
function pickCount(
  selection: CommandSelection,
  kind: CommandContextKind
): number {
  switch (kind) {
    case 'edges':
      return selection.edgeCount;
    case 'region':
      return selection.regionCount;
    case 'body':
    case 'bodies':
      return selection.bodyCount;
    default:
      return 1;
  }
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
/** The tool a selection verb launches, if it is one. */
function verbTool(id: SelectionCalloutVerb['id']): ToolId | null {
  if (id.startsWith('tool:')) return id.slice('tool:'.length) as ToolId;
  return VERB_ACTION_TOOLS[id] ?? null;
}

/** Selection actions that are a tool started on the pick. */
const VERB_ACTION_TOOLS: Partial<Record<SelectionCalloutVerb['id'], ToolId>> = {
  'action:sketch-on-face': 'sketch',
  'action:fillet': 'fillet',
  'action:chamfer': 'chamfer',
  'action:extrude-region': 'extrude'
};

/**
 * Stands the simple list's foot level with the More tools button that opened
 * it, rather than at the stage's foot: the rail is centred and its length
 * follows the pick, so a list pinned to the stage hung from nowhere, up to a
 * few hundred pixels below the button. The lift stays within the frame the
 * stylesheet gives the list (its max-height above the stage's foot), so a
 * list taller than the room above the button still runs down past it.
 *
 * Measured, not laid out: the list takes the column float as its containing
 * block (the rail scrolls and would clip it), and the button's place in the
 * float moves with the rail's length and centring.
 */
function useFlyoutAtToggle(
  flyoutRef: { readonly current: HTMLDivElement | null },
  toggleRef: { readonly current: HTMLButtonElement | null },
  active: boolean,
  listKey: string
) {
  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    const toggle = toggleRef.current;
    if (!active || !flyout || !toggle) return;
    const measure = () => {
      flyout.style.setProperty('--flyout-lift', '0px');
      const frame = flyout.getBoundingClientRect();
      const anchor = toggle.getBoundingClientRect();
      const maxHeight = Number.parseFloat(getComputedStyle(flyout).maxHeight);
      // The frame's top is the max-height above the list's resting foot.
      const room = Number.isFinite(maxHeight)
        ? Math.max(0, maxHeight - frame.height)
        : 0;
      const lift = Math.min(room, Math.max(0, frame.bottom - anchor.bottom));
      flyout.style.setProperty('--flyout-lift', `${lift}px`);
    };
    measure();
    const rail = toggle.closest<HTMLElement>('.tool-palette') ?? toggle;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(rail);
    observer?.observe(flyout);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      flyout.style.removeProperty('--flyout-lift');
    };
  }, [flyoutRef, toggleRef, active, listKey]);
}

/**
 * The section someone has scrolled to: the last one whose heading has
 * reached the list's top, or the last section once the list is scrolled to
 * its end (it may be too short to reach the top). None before the list has
 * any heading.
 */
function sectionAtTop(list: HTMLElement): ToolGroup | null {
  const headings = Array.from(
    list.querySelectorAll<HTMLElement>('.command-flyout-heading[data-section]')
  );
  if (headings.length === 0) return null;
  const atEnd =
    list.scrollHeight > list.clientHeight + 1 &&
    list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
  let reached = headings[0]!;
  for (const heading of headings) {
    if (atEnd || heading.offsetTop - HEADING_GAP_PX <= list.scrollTop + 1)
      reached = heading;
  }
  return (reached.dataset.section as ToolGroup | undefined) ?? null;
}

/** What a person scrolls the drawer with: anything else is the drawer's own. */
const SCROLL_INTENT_EVENTS = [
  'wheel',
  'touchstart',
  'pointerdown',
  'keydown'
] as const;

/**
 * Opens the drawer on the section it was left at, and remembers the section
 * as the list is scrolled. A section the list does not carry now (the
 * simple view, a filter) opens at the head and is kept until the list is
 * scrolled. Only a scroll someone made counts: the drawer's own (opening
 * on the section, a list that settles its height) would otherwise record
 * where it happened to land, an earlier section when the list was short.
 */
function useRememberedSection(
  listRef: { readonly current: HTMLDivElement | null },
  open: boolean,
  section: ToolGroup | null,
  onChange: ((section: ToolGroup) => void) | undefined
) {
  const remembered = useRef(section);
  remembered.current = section;
  const change = useRef(onChange);
  change.current = onChange;
  useLayoutEffect(() => {
    const list = listRef.current;
    const target = remembered.current;
    if (!open || !list || !target) return;
    const heading = list.querySelector<HTMLElement>(
      `.command-flyout-heading[data-section="${target}"]`
    );
    if (heading)
      list.scrollTop = Math.max(0, heading.offsetTop - HEADING_GAP_PX);
  }, [listRef, open]);
  const tracking = onChange !== undefined;
  useEffect(() => {
    const list = listRef.current;
    if (!open || !list || !tracking) return;
    // The drawer's head and foot count too: its "More" cue scrolls the
    // list, and the keyboard moves into it from the search.
    const drawer = list.parentElement ?? list;
    let intent = false;
    const intend = () => {
      intent = true;
    };
    const record = () => {
      if (!intent) return;
      const top = sectionAtTop(list);
      if (top && top !== remembered.current) {
        remembered.current = top;
        change.current?.(top);
      }
    };
    for (const type of SCROLL_INTENT_EVENTS)
      drawer.addEventListener(type, intend, { passive: true });
    list.addEventListener('scroll', record, { passive: true });
    return () => {
      for (const type of SCROLL_INTENT_EVENTS)
        drawer.removeEventListener(type, intend);
      list.removeEventListener('scroll', record);
    };
  }, [listRef, open, tracking]);
}

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
