import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';

interface ContextPanelProps {
  stepIndex: number;
  stepCount: number;
  title: string;
  helper: string;
  children: ReactNode;
  backLabel?: string;
  nextLabel?: string;
  nextDisabled?: boolean;
  onBack?: () => void;
  onNext?: () => void;
}

/**
 * Right-hand panel frame: eyebrow step counter, title, helper copy, scrolling
 * body, and Back/Continue workflow navigation.
 */
export function ContextPanel({
  stepIndex,
  stepCount,
  title,
  helper,
  children,
  backLabel = 'Back',
  nextLabel = 'Continue',
  nextDisabled = false,
  onBack,
  onNext
}: ContextPanelProps) {
  return (
    <aside className="context-panel" aria-label={`${title} settings`}>
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <div className="panel-eyebrow">
            Step {stepIndex} of {stepCount}
          </div>
        </div>
        <p className="helper">{helper}</p>
      </div>
      <div className="panel-body">{children}</div>
      {(onBack || onNext) && (
        <div className="workflow-nav" aria-label="Workflow navigation">
          <button type="button" className="secondary" disabled={!onBack} onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            {backLabel}
          </button>
          <button
            type="button"
            className="outline-action"
            disabled={!onNext || nextDisabled}
            onClick={onNext}
          >
            {nextLabel}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </aside>
  );
}
