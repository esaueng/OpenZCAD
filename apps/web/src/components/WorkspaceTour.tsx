import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent
} from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  advanceOnSignals,
  advanceThroughCompleted,
  tourStepBody,
  tourStepTarget,
  WORKSPACE_TOUR_STEPS,
  type WorkspaceTourSignals
} from '../lib/workspaceTour';
import { useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';
import { StableLabel } from './StableLabel';
import { TOUCH_ONLY_QUERY, useMediaQuery } from '../hooks/useMediaQuery';
import { useStageFootClaim } from '../hooks/useStageFootClaim';
import { guideCoversStage } from '../lib/fitFrame';

interface WorkspaceTourProps extends WorkspaceTourSignals {
  /** Fired on skip AND on finishing the last step — either way it is over. */
  onDismiss(): void;
  minimized?: boolean;
  onMinimizedChange?(value: boolean): void;
  /**
   * The card up on a phone's stage (a command card, the inspector), named
   * so one card can be told from the next; null with none. The guide shares
   * the right lane's foot with them, and expanded it left the card a 13 px
   * sliver (#1945), so it folds to its header while one is up. Expand opens
   * it for that card alone; the saved preference, minimized or not, is
   * untouched and returns when the card goes.
   */
  yieldTo?: string | null;
  /**
   * The step the tour had reached when the card last stood. The card leaves
   * the stage while a command or a sketch runs, and comes back mounted
   * anew: without this it counted its steps again from the first, and came
   * back at "Select to edit" after the user had moved past it.
   */
  startIndex?: number;
  /** The step now showing, for whoever keeps `startIndex`. */
  onIndexChange?(index: number): void;
  /**
   * The card rose across the middle of the stage (a phone's guide, coming
   * up or expanding), where it can stand over the model it asks to be
   * tapped: whoever owns the camera frames the model clear of it again.
   */
  onCoverStage?(): void;
}

/**
 * Floating first-model tour card over the viewport's lower-left corner.
 *
 * Non-modal on purpose: every step asks the user to work the real workspace,
 * so nothing may sit between them and it. Steps auto-advance when their
 * observable action happens (see lib/workspaceTour); Next moves on by hand.
 */
export function WorkspaceTour({
  featureCount,
  hasSelection,
  historyOpen,
  exportSeen,
  onDismiss,
  minimized: minimizedProp,
  onMinimizedChange,
  yieldTo = null,
  startIndex = 0,
  onIndexChange,
  onCoverStage
}: WorkspaceTourProps) {
  const keymap = useKeymap();
  const touchOnly = useMediaQuery(TOUCH_ONLY_QUERY);
  const [localMinimized, setLocalMinimized] = useState(false);
  const savedMinimized = minimizedProp ?? localMinimized;
  // Expand pressed while the guide was folded for a card: it stays open
  // until that card goes, and the next card folds it again.
  const [openedOver, setOpenedOver] = useState<string | null>(null);
  if (openedOver !== null && openedOver !== yieldTo) setOpenedOver(null);
  const yieldToCommand = yieldTo !== null;
  // While a card is up the guide is folded unless opened over that card,
  // whatever was saved; the saved choice returns with the card's close.
  const minimized = yieldToCommand ? openedOver !== yieldTo : savedMinimized;
  const [index, setIndex] = useState(() =>
    advanceThroughCompleted(startIndex, {
      featureCount,
      hasSelection,
      historyOpen,
      exportSeen
    })
  );
  /** The signals as of the last pass, to tell an action from a state. */
  const seenSignalsRef = useRef<WorkspaceTourSignals>({
    featureCount,
    hasSelection,
    historyOpen,
    exportSeen
  });
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const cardRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * The step's text scrolls in a card capped on a short phone (#1953). It
   * then takes the keyboard too: Safari gives a scroller no stop of its
   * own, and Tab went past text still out of view to Next (PR review).
   */
  const [textScrolls, setTextScrolls] = useState(false);
  /** Where the keyboard came from when it entered the card. */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const rememberReturn = (event: ReactFocusEvent<HTMLElement>) => {
    const from = event.relatedTarget;
    if (
      from instanceof HTMLElement &&
      from !== from.ownerDocument.body &&
      !event.currentTarget.contains(from)
    ) {
      returnFocusRef.current = from;
    }
  };

  // Skip and Finish unmount the card with the focus inside it. It goes back
  // where it came from or, failing that, to the workspace itself: the
  // command bar was the fallback, so the first step's "press B" typed a B
  // into search instead of opening Box.
  const releaseFocus = () => {
    const doc = globalThis.document;
    const active = doc.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      !cardRef.current?.contains(active)
    ) {
      return;
    }
    const back = returnFocusRef.current;
    if (back && back.isConnected) {
      back.focus();
    } else {
      active.blur();
    }
  };

  useEffect(() => {
    const before = seenSignalsRef.current;
    const after = { featureCount, hasSelection, historyOpen, exportSeen };
    seenSignalsRef.current = after;
    setIndex((current) => advanceOnSignals(current, before, after));
  }, [featureCount, hasSelection, historyOpen, exportSeen]);

  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  useEffect(() => {
    onIndexChangeRef.current?.(index);
  }, [index]);

  const finished = index >= WORKSPACE_TOUR_STEPS.length;
  useEffect(() => {
    if (finished) {
      onDismissRef.current();
    }
  }, [finished]);

  const step = WORKSPACE_TOUR_STEPS[index];
  const signals = { featureCount, hasSelection, historyOpen, exportSeen };
  const target = tourStepTarget(index, signals);

  // Outline the chrome region the step talks about. Imperative by design:
  // the targets (tool palette, History control) belong to other components, and
  // threading a "tour is pointing at you" prop through each of them would
  // couple them all to a card that exists for one session on one device.
  // The tool palette arrives in its own chunk after the workspace paints,
  // so the target may not exist when the step starts: watch the document
  // until it does rather than pointing at nothing.
  // A selector list names several parts (the rail and its foot); each is
  // outlined as it arrives.
  useEffect(() => {
    if (!target) {
      return;
    }
    const doc = globalThis.document;
    const pending = target.split(',').map((part) => part.trim());
    const outlined: HTMLElement[] = [];
    let observer: MutationObserver | null = null;
    const outline = () => {
      for (let at = pending.length - 1; at >= 0; at -= 1) {
        const found = doc.querySelector(pending[at]!);
        if (!(found instanceof HTMLElement)) continue;
        found.classList.add('tour-target');
        outlined.push(found);
        pending.splice(at, 1);
      }
      return pending.length === 0;
    };
    if (!outline() && typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => {
        if (outline()) {
          observer?.disconnect();
          observer = null;
        }
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      for (const element of outlined) element.classList.remove('tour-target');
    };
  }, [target]);

  // A phone's panel shares the card's corner of the stage; it ends above
  // the card rather than over its Next and Finish (UX-001).
  // Risen across a phone's stage, it can stand over the model: ask for the
  // model to be framed clear of it. A wider stage's card stands beside the
  // model, and asks nothing.
  useStageFootClaim(
    cardRef,
    '--workspace-tour-claim',
    !finished && !!step,
    (card, stage) => {
      const middle = stage.left + stage.width / 2;
      if (
        guideCoversStage(card, stage) &&
        card.left < middle &&
        card.right > middle
      )
        onCoverStage?.();
    }
  );

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || minimized) {
      setTextScrolls(false);
      return;
    }
    const measure = () =>
      setTextScrolls(content.scrollHeight > content.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [minimized, index]);

  if (finished || !step) {
    return null;
  }

  const last = index === WORKSPACE_TOUR_STEPS.length - 1;
  return (
    <section
      ref={cardRef}
      className={`workspace-tour${minimized ? ' is-minimized' : ''}`}
      aria-label="Modeling guide"
      onFocus={rememberReturn}
    >
      <header className="workspace-tour-head">
        <button
          type="button"
          className="icon-button"
          aria-label={
            minimized ? 'Expand modeling guide' : 'Minimize modeling guide'
          }
          aria-expanded={!minimized}
          onClick={() => {
            // With a card up, opening or folding it holds for that card
            // alone: the saved choice stands (PR review).
            if (yieldToCommand) {
              setOpenedOver(minimized ? yieldTo : null);
              return;
            }
            setLocalMinimized(!minimized);
            onMinimizedChange?.(!minimized);
          }}
        >
          {minimized ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
        <span>Modeling guide</span>
        <span className="workspace-tour-progress" aria-hidden="true">
          {WORKSPACE_TOUR_STEPS.map((entry, dot) => (
            <span
              key={entry.id}
              className={`workspace-tour-dot ${
                dot === index ? 'is-active' : dot < index ? 'is-done' : ''
              }`}
            />
          ))}
        </span>
        <span className="workspace-tour-count mono">
          {index + 1}/{WORKSPACE_TOUR_STEPS.length}
        </span>
        <button
          type="button"
          className="icon-button"
          title="Skip the tour"
          aria-label="Skip the tour"
          onClick={() => {
            releaseFocus();
            onDismiss();
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {minimized && (
        <span className="visually-hidden" role="status" aria-live="polite">
          Modeling guide, step {index + 1} of {WORKSPACE_TOUR_STEPS.length}:{' '}
          {step.title}
        </span>
      )}
      {/* A step can change on its own (it advances when its action
          happens), so the new step is announced. */}
      <div
        ref={contentRef}
        className="workspace-tour-content"
        hidden={minimized}
        tabIndex={textScrolls ? 0 : undefined}
        aria-live="polite"
        aria-atomic="true"
      >
        <h2 className="workspace-tour-title">{step.title}</h2>
        <p className="workspace-tour-body">
          {tourStepBody(
            step,
            (id) => {
              const chord = keymap.label(id);
              return chord ? platformShortcutLabel(chord) : undefined;
            },
            touchOnly
          )}
        </p>
      </div>
      <footer hidden={minimized} className="workspace-tour-actions">
        <button
          type="button"
          className="workspace-tour-next"
          onClick={() => {
            if (last) {
              releaseFocus();
              // Finish must notify the parent before the card disappears:
              // a reload can arrive before a passive completion effect runs.
              onDismiss();
              return;
            }
            setIndex((current) => current + 1);
          }}
        >
          <StableLabel reserve={['Finish', 'Next']} align="center">
            {last ? 'Finish' : 'Next'}
          </StableLabel>
        </button>
      </footer>
    </section>
  );
}
