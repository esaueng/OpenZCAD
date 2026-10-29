import { ChevronDown, Ellipsis } from 'lucide-react';
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import {
  commandContextFor,
  FOLD_GROUPS,
  RAIL_GROUPS,
  remainingTools,
  toolApplies,
  type CommandSelection
} from '../lib/commandContext';
import type { LabelSegment } from '../lib/topologyLabels';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from '../lib/tools';
import { toolCommandId, useKeymap } from '../lib/keymap';
import { Tooltip } from './Tooltip';

interface CommandCardProps {
  selection: CommandSelection;
  /**
   * What is picked, in words. The rail does not draw it — the Selection
   * card above the rail names it — but the summary and the clear action
   * stay in the contract so the caller's wiring is unchanged.
   */
  summary: { label: readonly LabelSegment[]; detail?: string } | null;
  /** Clears the selection; absent while nothing is picked. */
  onClear?: (() => void) | undefined;
  activeTool: ToolId | null;
  availability: ToolAvailability;
  onLaunchTool(tool: ToolId): void;
  /** The "More tools" fold, remembered per device in the panel state. */
  moreOpen: boolean;
  onToggleMore(): void;
}

/**
 * The verb rail: a thin icon column matching the instrument rail on the
 * right. Its buttons are one fixed, ordered set of primary verbs that never
 * moves with the selection, so every tool keeps its place and the hand can
 * learn it; every other tool waits behind the "More tools" button at its
 * foot, which opens a flyout of named tiles under fixed group headings.
 *
 * The selection changes emphasis only: a tool that does not act on the
 * current kind of pick is dimmed in place (still clickable — launching it
 * arms its own picking), and the context's primary verb is lit. Names and
 * keys ride the tooltips, and every button keeps the accessible name the
 * palette's tiles always had, so no command is out of reach and none
 * appears twice.
 *
 * The fold is closed by default and ⌘K reaches every command by name
 * regardless. Opened, it stays open across picks and reloads, like the
 * drawer.
 */
export function CommandCard({
  selection,
  activeTool,
  availability,
  onLaunchTool,
  moreOpen,
  onToggleMore
}: CommandCardProps) {
  const context = commandContextFor(selection);
  const restCount = remainingTools().length;
  const keymap = useKeymap();
  const flyoutRef = useRef<HTMLDivElement>(null);
  const below = useGroupsBelowFold(flyoutRef, moreOpen);
  const button = (tool: ToolId, variant: 'rail' | 'tile') => {
    const meta = TOOL_META[tool];
    const shortcut = keymap.label(toolCommandId(tool));
    const disabledReason = toolDisabledReason(tool, availability);
    const active = activeTool === tool;
    // The primary verb hints at what to do next; once a tool is armed it
    // yields, so the armed tool is the only lit button.
    const primary =
      variant === 'rail' && activeTool === null && context.primary === tool;
    const applies = active || toolApplies(context, tool);
    return (
      <Tooltip
        key={tool}
        label={meta.label}
        shortcut={shortcut}
        description={disabledReason ?? meta.hint}
      >
        <button
          type="button"
          className={`command-${variant}${primary ? ' is-primary' : ''}${active ? ' active' : ''}${applies ? '' : ' is-dim'}`}
          disabled={disabledReason !== null}
          aria-label={toolTitle(tool, availability, shortcut ?? null)}
          aria-pressed={active}
          data-applies={applies ? 'true' : 'false'}
          onClick={() => onLaunchTool(tool)}
        >
          {meta.icon}
          {variant === 'tile' && <span>{meta.label}</span>}
        </button>
      </Tooltip>
    );
  };
  return (
    // A navigation landmark rather than a toolbar, so the tooltips are told
    // it is a rail: they open beside it instead of over the next tool.
    <nav
      className="tool-palette command-rail"
      aria-label="Feature tools"
      data-context={context.kind}
      data-tooltip-rail=""
    >
      {RAIL_GROUPS.map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 && (
            <span className="command-rail-divider" aria-hidden="true" />
          )}
          <section
            role="group"
            aria-label={group.label}
            className="command-rail-group"
          >
            {group.tools.map((tool) => button(tool, 'rail'))}
          </section>
        </Fragment>
      ))}
      <span className="command-rail-divider" aria-hidden="true" />
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
              : `The ${restCount} other tools, by name`
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
          // A flyout beside the rail: help for a rail button next to it
          // drops its description, and a tile's help opens beside the fold
          // rather than over the tiles below it.
          <div
            ref={flyoutRef}
            className={`command-flyout${below.length > 0 ? ' has-more-below' : ''}`}
            data-rail-flyout=""
            data-tooltip-rail="vertical"
          >
            {FOLD_GROUPS.map((group) => (
              <Fragment key={group.label}>
                <span
                  className="command-flyout-heading"
                  data-group={group.label}
                >
                  {group.label}
                </span>
                {group.tools.map((tool) => button(tool, 'tile'))}
              </Fragment>
            ))}
            {below.length > 0 && (
              // A short window hides whole groups (Pattern, under Bodies)
              // past a fold only a 10px shade marked (F017). This names them
              // and scrolls the first into view. The keyboard needs no stop
              // of its own: a focused tile already scrolls into view.
              <button
                type="button"
                className="command-flyout-more"
                tabIndex={-1}
                aria-label={`Scroll to ${below.join(', ')}`}
                onClick={() => {
                  const flyout = flyoutRef.current;
                  const heading = Array.from(
                    flyout?.querySelectorAll<HTMLElement>(
                      '.command-flyout-heading'
                    ) ?? []
                  ).find((candidate) => candidate.dataset.group === below[0]);
                  if (!flyout || !heading) return;
                  flyout.scrollTo({
                    top: heading.offsetTop - 4,
                    behavior: 'smooth'
                  });
                }}
              >
                <span>
                  More: {below.join(', ')}
                  <ChevronDown size={12} aria-hidden="true" />
                </span>
              </button>
            )}
          </div>
        )}
      </section>
    </nav>
  );
}

/**
 * The fold's groups whose heading is past the flyout's scrolled fold, in
 * order: none in a window tall enough for the whole list. Measured on open,
 * on scroll and on resize; a heading counts as hidden once the overflow cue
 * itself would cover it.
 */
function useGroupsBelowFold(
  flyoutRef: { readonly current: HTMLDivElement | null },
  open: boolean
): string[] {
  const [below, setBelow] = useState<string[]>([]);
  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    if (!open || !flyout) {
      setBelow((current) => (current.length === 0 ? current : []));
      return;
    }
    const measure = () => {
      let hidden: string[] = [];
      if (flyout.scrollHeight > flyout.clientHeight + 1) {
        const cue =
          flyout.querySelector<HTMLElement>('.command-flyout-more')
            ?.offsetHeight ?? 0;
        const fold = flyout.scrollTop + flyout.clientHeight - cue;
        hidden = Array.from(
          flyout.querySelectorAll<HTMLElement>('.command-flyout-heading')
        )
          .filter((heading) => heading.offsetTop + heading.offsetHeight > fold)
          .map((heading) => heading.dataset.group ?? '');
      }
      setBelow((current) =>
        current.join('|') === hidden.join('|') ? current : hidden
      );
    };
    measure();
    flyout.addEventListener('scroll', measure, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(flyout);
    return () => {
      flyout.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [flyoutRef, open]);
  return below;
}
