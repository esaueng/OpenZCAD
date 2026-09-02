import { Circle, Layers3, MoveUpRight, PenLine, Spline, X } from 'lucide-react';
import type {
  OperationPhase,
  ToolCardIcon,
  ToolCardModel
} from '../lib/interaction/machine';
import type { SelectionActionId } from '../lib/interaction/capabilities';
import { StableLabel } from './StableLabel';

const ICONS: Record<ToolCardIcon, typeof MoveUpRight> = {
  'offset-face': MoveUpRight,
  'resize-cylinder-radius': Circle,
  fillet: Spline,
  extrude: Layers3,
  sketch: PenLine
};

const PHASE_LABELS: Record<OperationPhase, string> = {
  armed: 'Ready',
  dragging: 'Dragging',
  'exact-entry': 'Exact entry',
  validating: 'Validating',
  failed: 'Failed'
};
// The card is centred on the viewport, so a pill that grew with its label
// moved both of the card's edges on every phase change.
const PHASE_LABEL_RESERVE = Object.values(PHASE_LABELS);

interface ToolCardProps {
  model: ToolCardModel;
  onAction?(action: SelectionActionId): void;
  /** Opens the existing feature a refusal named, so the way out is a button. */
  onEditCulprit?(featureId: string): void;
  onClose(): void;
}

/**
 * Floating card announcing the operation the current selection armed
 * ("Offset Face", "Fillet", ...) with a one-line hint — the viewport-native
 * companion of the selection-first interaction machine.
 */
export function ToolCard({
  model,
  onAction,
  onEditCulprit,
  onClose
}: ToolCardProps) {
  const Icon = ICONS[model.icon];
  return (
    <div
      className={`tool-card${model.phase ? ` phase-${model.phase}` : ''}`}
      role="region"
      aria-label={`${model.title} operation`}
      aria-busy={model.phase === 'validating'}
    >
      <span className="tool-card-icon">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="tool-card-copy">
        <strong>
          {model.title}
          {model.phase ? (
            <span className={`tool-card-phase pill-${model.phase}`}>
              <StableLabel reserve={PHASE_LABEL_RESERVE} align="center">
                {PHASE_LABELS[model.phase]}
              </StableLabel>
            </span>
          ) : null}
        </strong>
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
            {model.error.detail ? (
              // The kernel's own words are kept, but a person reads the cause
              // first and asks for the machinery only if the cause was not
              // enough.
              <details className="tool-card-details">
                <summary>Details</summary>
                <span>{model.error.detail}</span>
              </details>
            ) : null}
          </span>
        ) : null}
        <small aria-live="polite">{model.hint}</small>
      </span>
      {model.actions && model.actions.length > 1 ? (
        <span className="tool-card-submode" role="tablist">
          {model.actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="tab"
              aria-selected={action.active}
              aria-label={
                action.disabledReason
                  ? `${action.label}: ${action.disabledReason}`
                  : action.label
              }
              title={action.disabledReason}
              className={action.active ? 'active' : undefined}
              disabled={!action.enabled || model.phase === 'validating'}
              onClick={() => onAction?.(action.id)}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        className="tool-card-close"
        aria-label={`Dismiss ${model.title}`}
        disabled={model.phase === 'validating'}
        onClick={onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
