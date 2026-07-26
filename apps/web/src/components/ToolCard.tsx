import {
  Circle,
  Layers3,
  MoveUpRight,
  PenLine,
  Spline,
  X
} from 'lucide-react';
import type { ToolCardIcon, ToolCardModel } from '../lib/interaction/machine';

const ICONS: Record<ToolCardIcon, typeof MoveUpRight> = {
  'offset-face': MoveUpRight,
  'resize-hole': Circle,
  fillet: Spline,
  extrude: Layers3,
  sketch: PenLine
};

interface ToolCardProps {
  model: ToolCardModel;
  onSubMode?(active: 0 | 1): void;
  onClose(): void;
}

/**
 * Floating card announcing the operation the current selection armed
 * ("Offset Face", "Fillet", ...) with a one-line hint — the viewport-native
 * companion of the selection-first interaction machine.
 */
export function ToolCard({ model, onSubMode, onClose }: ToolCardProps) {
  const Icon = ICONS[model.icon];
  return (
    <div className="tool-card" role="status" aria-label={model.title}>
      <span className="tool-card-icon">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="tool-card-copy">
        <strong>{model.title}</strong>
        <small>{model.hint}</small>
      </span>
      {model.subMode && (
        <span className="tool-card-submode" role="tablist">
          {model.subMode.options.map((option, index) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={model.subMode!.active === index}
              className={
                model.subMode!.active === index ? 'active' : undefined
              }
              onClick={() => onSubMode?.(index as 0 | 1)}
            >
              {option}
            </button>
          ))}
        </span>
      )}
      <button
        type="button"
        className="tool-card-close"
        aria-label={`Dismiss ${model.title}`}
        onClick={onClose}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
