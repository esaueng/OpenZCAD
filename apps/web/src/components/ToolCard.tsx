import type { ReactNode } from 'react';
import { Anchor } from 'lucide-react';
import type { OperationPhase, ToolCardModel } from '../lib/interaction/machine';
import type { SelectionActionId } from '../lib/interaction/capabilities';
import type {
  SelectionCalloutVerb,
  SelectionCalloutVerbId
} from '../lib/selectionCallout';
import { CARD_EYEBROWS } from '../lib/cardEyebrows';
import { OPERATION_PHASE_LABELS as PHASE_LABELS } from '../lib/selectionCalloutView';
import { CardHeader } from './CardHeader';
import { StableLabel } from './StableLabel';
import { Tooltip } from './Tooltip';

/**
 * The phases worth a badge. Armed is the card's resting state — the card
 * being open already says the command is ready — so it carries none, as the
 * selection chip carries none; dragging collapses the card to a dot.
 */
const BADGED_PHASES = ['exact-entry', 'validating', 'failed'] as const;
type BadgedPhase = (typeof BADGED_PHASES)[number];
// A badge that grew with its label pushed the eyebrow along on every phase
// change; it reserves the widest label instead.
const PHASE_LABEL_RESERVE = BADGED_PHASES.map((phase) => PHASE_LABELS[phase]);

function isBadgedPhase(
  phase: OperationPhase | undefined
): phase is BadgedPhase {
  return (BADGED_PHASES as readonly string[]).includes(phase ?? '');
}

interface ToolCardProps {
  model: ToolCardModel;
  children?: ReactNode;
  cancelableWhileValidating?: boolean;
  onAction?(action: SelectionActionId): void;
  /** Opens the existing feature a refusal named, so the way out is a button. */
  onEditCulprit?(featureId: string): void;
  /** Opens the Activity log, where the full kernel diagnostic is retained. */
  onViewDetails?(): void;
  /**
   * Commits the value the last passing preview showed. After a refusal at
   * release the model on screen is already that value; this keeps it rather
   * than sending the hand back to find it.
   */
  keepLastValid?: { label: string; keep(): void };
  selectAllEdges?: { count: number; select(): void };
  /**
   * The pick's other tools (a region's Revolve, Sweep, Loft), which leave
   * this operation for theirs with the same pick.
   */
  verbs?: readonly SelectionCalloutVerb[];
  onVerb?(id: SelectionCalloutVerbId): void;
  onClose(): void;
}

/**
 * The card for the operation the current selection armed ("Offset Face",
 * "Fillet", the region Extrude editor, ...) with a one-line hint — the
 * viewport-native companion of the selection-first interaction machine. Its
 * header is every command card's (CardHeader); the phase rides in the
 * header's badge slot.
 */
export function ToolCard({
  model,
  children,
  cancelableWhileValidating = false,
  onAction,
  onEditCulprit,
  onViewDetails,
  keepLastValid,
  selectAllEdges,
  verbs = [],
  onVerb,
  onClose
}: ToolCardProps) {
  const status = (
    <>
      {model.phase === 'dragging' ? (
        // role="img": ARIA drops a name given to a role-less span.
        <span
          className="tool-card-phase-dot"
          role="img"
          aria-label={PHASE_LABELS[model.phase]}
          title={PHASE_LABELS[model.phase]}
        />
      ) : isBadgedPhase(model.phase) ? (
        <span className={`tool-card-phase pill-${model.phase}`}>
          {model.phase === 'validating' ? (
            // A segment running round a ring says "working" for as long as
            // the check takes; the label alone read as a frozen state.
            <svg
              className="tool-card-orbit"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <circle cx="6" cy="6" r="4.5" pathLength={1} />
            </svg>
          ) : null}
          <StableLabel reserve={PHASE_LABEL_RESERVE} align="center">
            {PHASE_LABELS[model.phase]}
          </StableLabel>
        </span>
      ) : null}
      {model.badge ? (
        <Tooltip label={model.badge.label} description={model.badge.detail}>
          <span
            className="tool-card-badge"
            role="img"
            tabIndex={0}
            aria-label={model.badge.label}
          >
            <Anchor size={12} aria-hidden="true" />
          </span>
        </Tooltip>
      ) : null}
    </>
  );
  return (
    <div
      className={`tool-card${model.phase ? ` phase-${model.phase}` : ''}`}
      role="region"
      aria-label={`${model.title} operation`}
      aria-busy={model.phase === 'validating'}
    >
      <CardHeader
        title={model.title}
        eyebrow={CARD_EYEBROWS[model.eyebrow]}
        status={status}
        closeLabel={`Dismiss ${model.title}`}
        closeDisabled={
          model.phase === 'validating' && !cancelableWhileValidating
        }
        onClose={onClose}
      />
      <div className="tool-card-body">
        <div className="tool-card-copy">
          {model.error ? (
            <span className="tool-card-diagnostic" role="alert">
              <span className="tool-card-error">{model.error.message}</span>
              {model.error.culprit && onEditCulprit ? (
                <button
                  type="button"
                  className="tool-card-recovery"
                  onClick={() => onEditCulprit(model.error!.culprit!.featureId)}
                >
                  Edit {model.error.culprit.featureName}
                </button>
              ) : null}
              {keepLastValid ? (
                <button
                  type="button"
                  className="tool-card-recovery"
                  onClick={keepLastValid.keep}
                >
                  {keepLastValid.label}
                </button>
              ) : null}
              {model.error.detail && onViewDetails ? (
                <button
                  type="button"
                  className="activity-log-link"
                  onClick={onViewDetails}
                >
                  View details
                </button>
              ) : null}
            </span>
          ) : null}
          {/* The diagnostic is the message; the phase hint under it said the
              same thing a second time ("adjust the value") on every refusal. */}
          {model.error ? null : <small aria-live="polite">{model.hint}</small>}
        </div>
        {(model.actions && model.actions.length > 1) || selectAllEdges ? (
          <div className="tool-card-actions">
            {model.actions && model.actions.length > 1 ? (
              // Toggle buttons, not tabs: there is no tab panel, and a tablist
              // promises arrow-key movement these never had.
              <span
                className="tool-card-submode"
                role="group"
                aria-label={`${model.title} mode`}
              >
                {model.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    aria-pressed={action.active}
                    aria-label={
                      action.disabledReason
                        ? `${action.label}: ${action.disabledReason}`
                        : action.note
                          ? `${action.label}: ${action.note}`
                          : action.label
                    }
                    title={action.disabledReason ?? action.note}
                    className={action.active ? 'active' : undefined}
                    disabled={!action.enabled || model.phase === 'validating'}
                    onClick={() => onAction?.(action.id)}
                  >
                    {action.label}
                  </button>
                ))}
              </span>
            ) : null}
            {selectAllEdges ? (
              <button
                type="button"
                className="tool-card-recovery"
                aria-label={`Select all ${selectAllEdges.count} edges`}
                disabled={model.phase === 'validating'}
                onClick={selectAllEdges.select}
              >
                All {selectAllEdges.count} edges
              </button>
            ) : null}
          </div>
        ) : null}
        {verbs.length > 0 ? (
          <div className="tool-card-verbs" role="group" aria-label="Or">
            {verbs.map((verb) => (
              <button
                key={verb.id}
                type="button"
                className="tool-card-recovery"
                title={verb.title}
                // The verb rail's naming, so a pick's verbs are reached
                // the same way wherever its card stands.
                aria-label={`Selection: ${verb.label}`}
                disabled={
                  verb.disabled ||
                  (model.phase === 'validating' && !cancelableWhileValidating)
                }
                onClick={() => onVerb?.(verb.id)}
              >
                {verb.label}
              </button>
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
