import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  advanceThroughCompleted,
  WORKSPACE_TOUR_STEPS,
  type WorkspaceTourSignals
} from '../lib/workspaceTour';
import { StableLabel } from './StableLabel';

interface WorkspaceTourProps extends WorkspaceTourSignals {
  /** Fired on skip AND on finishing the last step — either way it is over. */
  onDismiss(): void;
}

/**
 * Floating first-model tour card over the viewport's lower-left corner.
 *
 * Non-modal on purpose: every step asks the user to work the real workspace,
 * so nothing may sit between them and it. Steps auto-advance when their
 * observable action happens (see lib/workspaceTour); Next covers the rest.
 */
export function WorkspaceTour({
  featureCount,
  hasSelection,
  exportSeen,
  onDismiss
}: WorkspaceTourProps) {
  const [index, setIndex] = useState(() =>
    advanceThroughCompleted(0, { featureCount, hasSelection, exportSeen })
  );
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    setIndex((current) =>
      advanceThroughCompleted(current, {
        featureCount,
        hasSelection,
        exportSeen
      })
    );
  }, [featureCount, hasSelection, exportSeen]);

  const finished = index >= WORKSPACE_TOUR_STEPS.length;
  useEffect(() => {
    if (finished) {
      onDismissRef.current();
    }
  }, [finished]);

  const step = WORKSPACE_TOUR_STEPS[index];

  // Outline the chrome region the step talks about. Imperative by design:
  // the targets (tool palette, sidebar) are other components' roots, and
  // threading a "tour is pointing at you" prop through each of them would
  // couple them all to a card that exists for one session on one device.
  useEffect(() => {
    const selector = step?.targetSelector;
    if (!selector) {
      return;
    }
    const target = globalThis.document.querySelector(selector);
    if (!(target instanceof HTMLElement)) {
      return;
    }
    target.classList.add('tour-target');
    return () => target.classList.remove('tour-target');
  }, [step]);

  if (finished || !step) {
    return null;
  }

  const last = index === WORKSPACE_TOUR_STEPS.length - 1;
  return (
    <section className="workspace-tour" aria-label="Getting started">
      <header className="workspace-tour-head">
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
          onClick={onDismiss}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </header>
      <h2 className="workspace-tour-title">{step.title}</h2>
      <p className="workspace-tour-body">{step.body}</p>
      <footer className="workspace-tour-actions">
        <button
          type="button"
          className="workspace-tour-next"
          onClick={() => setIndex((current) => current + 1)}
        >
          <StableLabel reserve={['Finish', 'Next']} align="center">
            {last ? 'Finish' : 'Next'}
          </StableLabel>
        </button>
      </footer>
    </section>
  );
}
