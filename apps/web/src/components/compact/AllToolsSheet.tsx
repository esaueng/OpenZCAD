import { Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import {
  allToolsLead,
  allToolsSections,
  compactToolLabel
} from '../../lib/compactTray';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolId
} from '../../lib/tools';
import type { CompactBuildProps } from './compactSlots';
import { useTrayReason } from './ContextTray';

/**
 * Every tool in Build (U12 slice 4), as a sheet page: a search on top, the
 * recent (or pinned) row first, then the five groups. A tile is an icon with
 * one word under it and the tool's full name for assistive technology; a
 * tool that cannot run now stays tappable and says why, under the group it
 * was tapped in and scrolled into view: at the list's top it was off-screen
 * once the list had scrolled. A tap launches the tool through the
 * workspace's own launch path.
 */
export function AllToolsSheet({
  build,
  onLaunch
}: {
  build: CompactBuildProps;
  onLaunch(tool: ToolId): void;
}) {
  const [query, setQuery] = useState('');
  const [reason, showReason, reasonTurn] = useTrayReason();
  // The group the refused tile was tapped in. A recent tool stands in its
  // own group as well; the reason goes under the tile that was tapped.
  const [reasonSection, setReasonSection] = useState<string | null>(null);
  const reasonRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (reasonTurn > 0)
      reasonRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [reasonTurn]);
  const headingId = useId();
  const sections = allToolsSections(
    query,
    allToolsLead(build.recentTools, build.pinnedTools)
  );
  // Each tile's place in reading order, so the grid comes in tile by tile.
  let order = 0;
  return (
    <div className="compact-all-tools">
      <label className="compact-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          className="compact-search-input"
          aria-label="Search tools"
          placeholder="Search"
          value={query}
          autoComplete="off"
          enterKeyHint="search"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {sections.map((section) => (
        <section
          key={section.id}
          className="compact-tool-group"
          aria-labelledby={`${headingId}-${section.id}`}
        >
          <h3
            id={`${headingId}-${section.id}`}
            className="compact-tool-group-title"
          >
            {section.label}
          </h3>
          <ul className="compact-tool-grid">
            {section.tools.map((tool) => {
              const disabled = toolDisabledReason(tool, build.availability);
              return (
                <li key={tool} style={{ '--i': order++ } as CSSProperties}>
                  <button
                    type="button"
                    className={`compact-tool-tile${
                      build.activeTool === tool ? ' active' : ''
                    }`}
                    aria-label={TOOL_META[tool].label}
                    aria-disabled={disabled !== null}
                    aria-pressed={build.activeTool === tool}
                    title={toolTitle(tool, build.availability, null)}
                    onClick={() => {
                      if (disabled === null) {
                        onLaunch(tool);
                        return;
                      }
                      setReasonSection(section.id);
                      showReason(`${TOOL_META[tool].label}: ${disabled}`);
                    }}
                  >
                    <span className="compact-tool-icon" aria-hidden="true">
                      {TOOL_META[tool].icon}
                    </span>
                    <span className="compact-tool-label" aria-hidden="true">
                      {compactToolLabel(tool)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {reason && reasonSection === section.id ? (
            <p ref={reasonRef} className="compact-tray-reason" role="status">
              {reason}
            </p>
          ) : null}
        </section>
      ))}
      {sections.length === 0 ? (
        <p className="compact-all-tools-empty" role="status">
          No tools match
        </p>
      ) : null}
    </div>
  );
}
