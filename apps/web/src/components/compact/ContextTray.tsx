import { LayoutGrid } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { trayTools } from '../../lib/compactTray';
import { TOOL_META, toolDisabledReason, toolTitle } from '../../lib/tools';
import { verbIcon } from '../SelectionRail';
import type { CompactBuildProps } from './compactSlots';

/** How long a disabled verb's reason stays after the tap that asked. */
export const TRAY_REASON_MS = 4000;

/**
 * Says why a disabled verb cannot run, for a while after its tap: on a
 * phone there is no hover to show a tooltip, so a disabled verb stays
 * tappable and answers with its reason inline. The third value counts the
 * taps that asked, so each one can be answered, not only the first.
 */
export function useTrayReason(): [
  string | null,
  (reason: string) => void,
  number
] {
  const [reason, setReason] = useState<{ text: string; turn: number } | null>(
    null
  );
  useEffect(() => {
    if (!reason) return;
    const timer = window.setTimeout(() => setReason(null), TRAY_REASON_MS);
    return () => window.clearTimeout(timer);
  }, [reason]);
  return [
    reason?.text ?? null,
    (text) =>
      setReason((current) => ({ text, turn: (current?.turn ?? 0) + 1 })),
    reason?.turn ?? 0
  ];
}

/**
 * Build's tray at rest (U12 slice 4): the sheet's peek row. With nothing
 * picked it holds the tools the document is ready for; with a pick, the
 * pick's own verbs, as the verb rail does. Each is a 44 px icon named for
 * assistive technology; the row's one word is All tools', which opens every
 * tool in the sheet.
 */
export function ContextTray({
  build,
  allToolsOpen,
  onAllTools,
  onReason
}: {
  build: CompactBuildProps;
  allToolsOpen: boolean;
  onAllTools(): void;
  /**
   * A disabled verb's reason came (true) or went (false). The reason stands
   * under the row, below the peek's fold, so the sheet makes room for it
   * while it shows. Each tap that asks says so again, so a sheet lowered
   * meanwhile comes back up for it.
   */
  onReason?(shown: boolean): void;
}) {
  const [reason, showReason, reasonTurn] = useTrayReason();
  const onReasonRef = useRef(onReason);
  onReasonRef.current = onReason;
  const reasonShown = reason !== null;
  const reasonSeen = useRef(false);
  useEffect(() => {
    if (!reasonShown && !reasonSeen.current) return;
    reasonSeen.current = true;
    onReasonRef.current?.(reasonShown);
  }, [reasonShown, reasonTurn]);
  const pick = build.pick && build.pick.verbs.length > 0 ? build.pick : null;
  const tools = pick
    ? []
    : trayTools(build.context, build.availability, build.recentTools);
  return (
    <div className="compact-tray" role="group" aria-label="Build tray">
      <div className="compact-tray-row">
        <div className="compact-tray-verbs">
          {pick
            ? pick.verbs.map((verb) => {
                const enabled = pick.enabled(verb);
                return (
                  <button
                    key={verb.id}
                    type="button"
                    className={`compact-tray-button${verb.pressed ? ' active' : ''}`}
                    // The verb rail's naming, so a pick's verbs are found the
                    // same way wherever they stand.
                    aria-label={`Selection: ${verb.label}`}
                    aria-pressed={verb.pressed}
                    aria-disabled={!enabled}
                    title={verb.title}
                    onClick={() => {
                      if (enabled) pick.onVerb(verb.id);
                      else showReason(verb.title || `${verb.label} is off`);
                    }}
                  >
                    {verbIcon(verb)}
                  </button>
                );
              })
            : tools.map((tool) => {
                const disabled = toolDisabledReason(tool, build.availability);
                return (
                  <button
                    key={tool}
                    type="button"
                    className={`compact-tray-button${
                      build.activeTool === tool ? ' active' : ''
                    }`}
                    aria-label={TOOL_META[tool].label}
                    aria-disabled={disabled !== null}
                    title={toolTitle(tool, build.availability, null)}
                    onClick={() => {
                      if (disabled === null) build.onLaunchTool(tool);
                      else showReason(disabled);
                    }}
                  >
                    {TOOL_META[tool].icon}
                  </button>
                );
              })}
        </div>
        <button
          type="button"
          className="compact-tray-button compact-tray-all"
          aria-label="All tools"
          aria-expanded={allToolsOpen}
          onClick={onAllTools}
        >
          <LayoutGrid size={22} aria-hidden="true" />
          <span className="compact-tray-label" aria-hidden="true">
            Tools
          </span>
        </button>
      </div>
      {reason ? (
        <p className="compact-tray-reason" role="status">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
