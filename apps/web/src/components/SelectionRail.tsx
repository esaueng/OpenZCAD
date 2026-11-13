import {
  Anchor,
  ArrowUpFromDot,
  BrushCleaning,
  CircleAlert,
  Diameter,
  Eraser,
  Info,
  ListChecks,
  Ruler,
  SquarePen,
  SquareX
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import { useSettledFlag } from '../hooks/useSettledFlag';
import type { SelectionActionId } from '../lib/interaction/capabilities';
import {
  LIVE_DIAMETER_DETAIL_ATTRIBUTE,
  renderLabelSegments
} from '../lib/liveLabels';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation,
  SelectionCalloutVerb
} from '../lib/selectionCallout';
import { OPERATION_PHASE_LABELS } from '../lib/selectionCalloutView';
import {
  selectionRailHeld,
  selectionRailVerbEnabled
} from '../lib/selectionRailHold';
import { TOOL_META, type ToolId } from '../lib/tools';
import { chamferOutlineGlyph, filletOutlineGlyph } from '../lib/toolIcons';
import type { LabelSegment } from '../lib/topologyLabels';
import { Tooltip } from './Tooltip';

/**
 * How long the exact check must run before the rail says so. Most releases
 * validate within a frame or two: announcing each one blinked a marker in
 * and out and dimmed every verb.
 */
export const VALIDATING_ANNOUNCE_MS = 250;

const ACTION_ICONS: Record<SelectionActionId, ReactNode> = {
  'resize-body': <Ruler size={16} aria-hidden="true" />,
  'offset-face': <ArrowUpFromDot size={16} aria-hidden="true" />,
  'resize-radial-face': <Diameter size={16} aria-hidden="true" />,
  'edit-fillet': TOOL_META.fillet.icon,
  'remove-fillet': <Eraser size={16} aria-hidden="true" />,
  'remove-all-fillets': <BrushCleaning size={16} aria-hidden="true" />,
  'remove-face-feature': <Eraser size={16} aria-hidden="true" />,
  'sketch-on-face': TOOL_META.sketch.icon,
  fillet: TOOL_META.fillet.icon,
  chamfer: TOOL_META.chamfer.icon,
  // Not Chamfer's glyph: the rail shows both at once, and two buttons with
  // one picture read as one command (the outline verb went unfound).
  'chamfer-chain': chamferOutlineGlyph,
  'fillet-face-edges': filletOutlineGlyph,
  'chamfer-face-edges': chamferOutlineGlyph,
  'extrude-region': TOOL_META.extrude.icon
};

function verbIcon(verb: SelectionCalloutVerb): ReactNode {
  if (verb.id === 'edit-face') {
    // One id, two verbs: an imported face with an edit of its own, and one
    // whose card only reads out what recognition found.
    return verb.label === 'Face details' ? (
      <Info size={16} aria-hidden="true" />
    ) : (
      <SquarePen size={16} aria-hidden="true" />
    );
  }
  if (verb.id.startsWith('tool:')) {
    return TOOL_META[verb.id.slice('tool:'.length) as ToolId].icon;
  }
  return ACTION_ICONS[verb.id.slice('action:'.length) as SelectionActionId];
}

/**
 * How long a pick that leaves the rail mid-hold (its drag, or the exact
 * check after the release) is still drawn, held, before the rail gives way.
 * The pick can drop out for a frame or two as the release settles; drawing
 * the pinned tools for those frames flashed the whole tool list in and
 * straight back out.
 */
export const RELEASE_HOLD_MS = 1000;

/** What ends a held pick before {@link RELEASE_HOLD_MS} runs out. */
export interface HeldPickGuard {
  /**
   * The document's history position (Undo, Redo, another project). A pick
   * that leaves because the document was rewound under it is gone, not
   * settling: a change here gives way at once.
   */
  revision?: unknown;
  /**
   * Whether what the pick acts on (its bodies) still exists. A pick whose
   * target was deleted or undone away gives way at once.
   */
  isLive?: ((pick: SelectionCalloutContent) => boolean) | undefined;
}

/**
 * The pick the rail draws: `pick`, or, for up to {@link RELEASE_HOLD_MS}
 * after a held pick goes null, that last held pick as a check in flight
 * (every control disabled). A pick that returns ends the hold at once, and
 * a pick that leaves while not held is never kept. So does a guard that
 * fails ({@link HeldPickGuard}): the revision moved since the pick was last
 * drawn, or its target is gone. Then the null is a real deselection (Undo
 * mid-drag, a delete), and drawing it as a check would grey out the rail
 * for nothing.
 *
 * Derived during render, as useDelayedUnmount is, so the frame the pick
 * leaves in is already the held one, and the frame its guard fails in is
 * already the released one.
 */
export function useHeldPick(
  pick: SelectionCalloutContent | null,
  { revision, isLive }: HeldPickGuard = {}
): SelectionCalloutContent | null {
  const present = pick !== null;
  const lastHeld = useRef<{
    pick: SelectionCalloutContent;
    revision: unknown;
  } | null>(pick && selectionRailHeld(pick) ? { pick, revision } : null);
  const [wasPresent, setWasPresent] = useState(present);
  const [holding, setHolding] = useState(false);
  if (present !== wasPresent) {
    setWasPresent(present);
    setHolding(!present && lastHeld.current !== null);
  }
  useEffect(() => {
    if (pick) {
      lastHeld.current = selectionRailHeld(pick) ? { pick, revision } : null;
    }
  });
  const last = !present && holding ? lastHeld.current : null;
  const held =
    last &&
    Object.is(last.revision, revision) &&
    (isLive?.(last.pick) ?? true)
      ? last.pick
      : null;
  // A guard that failed ends the hold for good: the revision only moves on,
  // and a target that comes back (Redo) is a new pick, not this one settling.
  const released = holding && !present && held === null;
  useEffect(() => {
    if (!released) return;
    lastHeld.current = null;
    setHolding(false);
  }, [released]);
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(() => {
      lastHeld.current = null;
      setHolding(false);
    }, RELEASE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [holding]);
  return useMemo(() => {
    if (pick) return pick;
    if (!held?.operation) return null;
    return { ...held, operation: { ...held.operation, phase: 'validating' } };
  }, [pick, held]);
}

/**
 * What can be done with the pick, as the verb rail itself. A pick swaps the
 * rail's fixed tools for the pick's own verbs, under a Deselect all that
 * says what is picked; the verb the pick has armed is the lit one. The
 * pick's name and measurement read in the bar at the foot of the stage
 * ({@link SelectionReadout}), so nothing hangs over the model or beside
 * the rail.
 *
 * It keeps the Selection card's classes and accessible names ("Selection:
 * Fillet", "Deselect all", the "Offset Face operation" region), so every
 * way of reaching a verb still reaches it.
 *
 * Within one pick the rail's buttons and height are fixed: a drag, or the
 * check after it, disables the rest in place, and the phase mark sits in a
 * slot the operation always keeps.
 *
 * The operation's refusal is not here: it joins the notice lane
 * ({@link SelectionRefusal}), where every other message the workspace has
 * for the user already stands.
 */
export function SelectionRail({
  content,
  summary
}: {
  content: SelectionCalloutContent;
  /** What is picked, in words: "1 face", "8 edges". */
  summary: string;
}) {
  const operation = content.operation;
  const validating = operation?.phase === 'validating';
  // The verbs are held from the first frame (the check owns the pick until it
  // answers); only saying so waits until the check has visibly taken time.
  const announced = useSettledFlag(validating, VALIDATING_ANNOUNCE_MS);
  // A quick check keeps the marker the release came from (the drag's dot,
  // the typed value's) rather than blinking a new one.
  const before = useRef(operation?.phase);
  const phase = validating && !announced ? before.current : operation?.phase;
  useLayoutEffect(() => {
    if (!validating) before.current = operation?.phase;
  });
  const held = selectionRailHeld(content);
  // A drag, and a quick check after one, look alike: the verb being made
  // lit and the rest dimmed. Undimming the rest for the check's frame or
  // two read as the rail coming back and going away again.
  const dragHold = held && phase === 'dragging';
  return (
    <section
      className="selection-rail selection-callout-chip"
      role={operation ? 'region' : 'group'}
      aria-label={operation ? `${operation.title} operation` : 'Selection'}
      aria-busy={validating ? 'true' : undefined}
      data-busy={validating && !announced && !dragHold ? 'quiet' : undefined}
      data-hold={dragHold ? 'drag' : undefined}
    >
      {content.onClear && (
        <>
          <Tooltip label="Deselect all" shortcut="Esc" description={summary}>
            <button
              type="button"
              className="command-rail selection-rail-clear"
              aria-label="Deselect all"
              disabled={held}
              onClick={content.onClear}
            >
              <SquareX size={16} aria-hidden="true" />
            </button>
          </Tooltip>
          {content.verbs.length > 0 && (
            <span className="command-rail-divider" aria-hidden="true" />
          )}
        </>
      )}
      {content.verbs.map((verb) => (
        <Tooltip key={verb.id} label={verb.label} description={verb.title}>
          <button
            type="button"
            className={`command-rail selection-rail-verb${verb.pressed ? ' active' : ''}`}
            // Named for what it acts on, so it never shares a name with the
            // More tools tile or tool-card action of the same verb.
            aria-label={`Selection: ${verb.label}`}
            aria-pressed={verb.pressed}
            // The one rule shortcuts and the palette ask too
            // (selectionRailToolHoldReason), so a key never launches what
            // the rail shows greyed out.
            disabled={!selectionRailVerbEnabled(content, verb)}
            onClick={() => content.onVerb(verb.id)}
          >
            {verbIcon(verb)}
          </button>
        </Tooltip>
      ))}
      {operation?.selectAllEdgesCount ? (
        <Tooltip
          label={`All ${operation.selectAllEdgesCount} edges`}
          description="Add every edge of this body to the operation"
        >
          <button
            type="button"
            className="command-rail selection-rail-verb"
            aria-label={`Select all ${operation.selectAllEdgesCount} edges`}
            disabled={held}
            onClick={operation.onSelectAllEdges}
          >
            <ListChecks size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      ) : null}
      {operation?.badge && (
        <span
          className="selection-callout-badge selection-rail-badge"
          tabIndex={0}
          aria-label={operation.badge.label}
          title={operation.badge.detail}
        >
          <Anchor size={14} aria-hidden="true" />
        </span>
      )}
      {/* Armed is the resting state, and the lit verb already says which
          operation the pick carries; every other phase is news. The slot
          stays for as long as there is an operation, so a mark coming or
          going never moves the rail. */}
      {operation && (
        <span className="selection-rail-phase-slot">
          {phase && phase !== 'armed' && <PhaseMarker phase={phase} />}
        </span>
      )}
    </section>
  );
}

/** What each phase mark's tooltip says, in words a user would use. */
const PHASE_TOOLTIPS: Partial<
  Record<NonNullable<SelectionCalloutOperation['phase']>, string>
> = {
  'exact-entry': 'Typing an exact value',
  validating: 'Checking the exact result',
  failed: 'This value did not build'
};

function PhaseMarker({
  phase
}: {
  phase: NonNullable<SelectionCalloutOperation['phase']>;
}) {
  const label = OPERATION_PHASE_LABELS[phase];
  if (phase === 'dragging') {
    // Only a dot while the hand is on the handle: the value on the handle is
    // what is being read then.
    return (
      <span
        className="selection-callout-phase-dot"
        aria-label={label}
        title={label}
      />
    );
  }
  // A mark under the verb, its tone the phase's; the words are for
  // assistive tech and the tooltip, since the rail has no room for a pill.
  // A refusal is a mark worth explaining: a bare red dot under the verbs
  // read as a recording light, so it is an alert glyph with a tooltip that
  // says what failed and where the reason is.
  const failed = phase === 'failed';
  return (
    <Tooltip
      label={PHASE_TOOLTIPS[phase] ?? label}
      description={
        failed
          ? 'The reason and the ways out are in the note above the search bar.'
          : undefined
      }
    >
      <span
        className={`selection-callout-phase selection-rail-phase phase-${phase}${failed ? ' has-icon' : ''}`}
        tabIndex={failed ? 0 : undefined}
      >
        {failed && <CircleAlert size={14} aria-hidden="true" />}
        <span className="visually-hidden">{label}</span>
      </span>
    </Tooltip>
  );
}

/**
 * The pick's name and its key measurement, at the foot of the stage where
 * the bar's guidance reads: the one readout of what is picked.
 */
export function SelectionReadout({
  label,
  detail,
  detailDiameter
}: {
  label: readonly LabelSegment[] | null;
  detail?: string | undefined;
  /** When `detail` is a diameter: a radius drag rewrites it in place. */
  detailDiameter?: { diameter: number; units: string } | undefined;
}) {
  const nameRef = useRef<HTMLSpanElement>(null);
  // The name ends in an ellipsis only when it and the measurement fill the
  // row. Cut, the whole of it is the name's tooltip; assistive tech reads
  // the full text either way, since the cut is drawn, not made.
  const [cut, setCut] = useState(false);
  const measureCut = useCallback(() => {
    const name = nameRef.current;
    if (!name) return;
    const isCut = name.scrollWidth > name.clientWidth;
    setCut(isCut);
    if (isCut) name.title = name.textContent ?? '';
    else name.removeAttribute('title');
  }, []);
  // Segmented like every other spelling of a pick, so a cylinder-radius drag
  // can rewrite the diameter node in place (setLiveDiameter).
  useLayoutEffect(() => {
    if (!nameRef.current) return;
    renderLabelSegments(nameRef.current, label ?? []);
    measureCut();
  }, [label, measureCut]);
  // The row widens and narrows with the window and the docks, and a name
  // that grows into the row's end changes its own box on the way.
  useLayoutEffect(() => {
    const name = nameRef.current;
    if (!name || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureCut);
    observer.observe(name);
    return () => observer.disconnect();
  }, [measureCut]);
  return (
    <span className="selection-readout" role="group" aria-label="Picked">
      <span
        className="selection-callout-name"
        ref={nameRef}
        data-cut={cut ? '' : undefined}
        // A radius drag rewrites the name in place without a render: the
        // tooltip is read from the text as the pointer arrives.
        onPointerEnter={(event) => {
          if (cut) {
            event.currentTarget.title = event.currentTarget.textContent ?? '';
          }
        }}
      />
      {detail && (
        <span
          className="selection-callout-detail"
          {...(detailDiameter
            ? {
                [LIVE_DIAMETER_DETAIL_ATTRIBUTE]: String(
                  detailDiameter.diameter
                ),
                'data-units': detailDiameter.units
              }
            : {})}
        >
          {detail}
        </span>
      )}
    </span>
  );
}
