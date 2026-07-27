import {
  Check,
  Circle,
  MousePointer2,
  Minus,
  Square,
  Waypoints
} from 'lucide-react';
import type { SketchToolId } from '../lib/interaction/machine';

interface SketchToolRailProps {
  tool: SketchToolId;
  onTool(tool: SketchToolId): void;
  onExit(): void;
}

const TOOLS: {
  id: SketchToolId;
  label: string;
  keyHint: string;
  icon: typeof Minus;
}[] = [
  { id: 'select', label: 'Select', keyHint: 'V', icon: MousePointer2 },
  { id: 'line', label: 'Line', keyHint: 'L', icon: Minus },
  { id: 'arc', label: 'Arc', keyHint: 'A', icon: Waypoints },
  { id: 'circle', label: 'Circle', keyHint: 'C', icon: Circle },
  { id: 'rectangle', label: 'Rectangle', keyHint: 'R', icon: Square }
];

/**
 * Floating tool strip for in-viewport sketching: drawing tools plus the
 * Exit Sketching action. Lives beneath the sketch tool card.
 */
export function SketchToolRail({ tool, onTool, onExit }: SketchToolRailProps) {
  return (
    <div className="sketch-rail" role="toolbar" aria-label="Sketch tools">
      {TOOLS.map(({ id, label, keyHint, icon: Icon }) => (
        <button
          key={id}
          type="button"
          className={tool === id ? 'active' : undefined}
          aria-pressed={tool === id}
          title={`${label} (${keyHint})`}
          onClick={() => onTool(id)}
        >
          <Icon size={14} aria-hidden="true" />
          {label}
          <kbd>{keyHint}</kbd>
        </button>
      ))}
      <span className="sketch-rail-divider" aria-hidden="true" />
      <button
        type="button"
        className="sketch-rail-exit"
        title="Exit Sketching (Esc)"
        onClick={onExit}
      >
        <Check size={14} aria-hidden="true" />
        Exit Sketching
      </button>
    </div>
  );
}
