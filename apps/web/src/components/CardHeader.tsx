import type { ReactNode } from 'react';
import { X } from 'lucide-react';

interface CardHeaderProps {
  title: ReactNode;
  /** One of CARD_EYEBROWS: creating, editing, or editing the shape directly. */
  eyebrow: ReactNode;
  /**
   * State worth news beside the title — an operation's exact entry,
   * validation or refusal. A card at rest shows nothing here.
   */
  status?: ReactNode;
  /** Header controls before the close button, such as the overflow menu. */
  actions?: ReactNode;
  closeLabel: string;
  closeTitle?: string;
  closeDisabled?: boolean;
  onClose(): void;
}

/**
 * What stands in a card's place while its chunk loads: the card's shell and
 * header rule with blank lines where its title and fields will be, so a
 * tool's first open shows its card at once rather than a lane prompt with
 * nothing under it.
 */
export function CardSkeleton() {
  return (
    <div
      className="card-skeleton"
      role="status"
      aria-label="Loading card"
      aria-busy="true"
    >
      <div className="panel-header">
        <span className="card-skeleton-line card-skeleton-title" />
      </div>
      <div className="card-skeleton-body">
        <span className="card-skeleton-line" />
        <span className="card-skeleton-line" />
      </div>
    </div>
  );
}

/**
 * The one header every command card wears: the title, the eyebrow saying
 * whether it creates or edits, an optional state badge, and the same close
 * button.
 *
 * The region Extrude card used to draw its own — an icon tile, a "Ready"
 * badge, a subtitle and a small bare × — beside cards whose header was this
 * one, so the same kind of card had two designs depending on which code path
 * opened it.
 */
export function CardHeader({
  title,
  eyebrow,
  status,
  actions,
  closeLabel,
  closeTitle,
  closeDisabled,
  onClose
}: CardHeaderProps) {
  return (
    <div className="panel-header">
      <div className="panel-title-row">
        <h2>{title}</h2>
        {status}
        <span className="panel-eyebrow">{eyebrow}</span>
        {actions}
        <button
          type="button"
          className="icon-button panel-close"
          title={closeTitle}
          aria-label={closeLabel}
          disabled={closeDisabled}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
