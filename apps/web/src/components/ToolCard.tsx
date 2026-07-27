import { Circle, Layers3, MoveUpRight, PenLine, Spline, X } from 'lucide-react';
import type {
  OperationPhase,
  ToolCardIcon,
  ToolCardModel
} from '../lib/interaction/machine';
import type { SelectionActionId } from '../lib/interaction/capabilities';

const ICONS: Record<ToolCardIcon, typeof MoveUpRight> = {
  'offset-face': MoveUpRight,
  'resize-hole': Circle,
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

interface ToolCardProps {
  model: ToolCardModel;
  onAction?(action: SelectionActionId): void;
  onClose(): void;
}

/**
 * Floating card announcing the operation the current selection armed
 * ("Offset Face", "Fillet", ...) with a one-line hint — the viewport-native
 * companion of the selection-first interaction machine.
 */
export function ToolCard({ model, onAction, onClose }: ToolCardProps) {
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
              {PHASE_LABELS[model.phase]}
            </span>
          ) : null}
        </strong>
        {model.error ? (
          <small className="tool-card-error" role="alert">
            {model.error}
          </small>
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
              className={action.active ? 'active' : undefined}
              disabled={model.phase === 'validating'}
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
