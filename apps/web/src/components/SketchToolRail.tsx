import {
  Check,
  Circle,
  Construction,
  Layers3,
  MousePointer2,
  Minus,
  ScanSearch,
  Square,
  Waypoints
} from 'lucide-react';
import type { SketchToolId } from '../lib/interaction/machine';

interface SketchToolRailProps {
  tool: SketchToolId;
  construction: boolean;
  onTool(tool: SketchToolId): void;
  onConstruction(value: boolean): void;
  onDiagnostics(): void;
  onExtrude(): void;
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
export function SketchToolRail({
  tool,
  construction,
  onTool,
  onConstruction,
  onDiagnostics,
  onExtrude,
  onExit
}: SketchToolRailProps) {
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
        className={construction ? 'active' : undefined}
        aria-pressed={construction}
        title="Toggle construction geometry"
        onClick={() => onConstruction(!construction)}
      >
        <Construction size={14} aria-hidden="true" />
        Construction
      </button>
      <button
        type="button"
        title="Find open endpoints and invalid profile geometry"
        onClick={onDiagnostics}
      >
        <ScanSearch size={14} aria-hidden="true" />
        Diagnostics
      </button>
      <button type="button" title="Extrude valid profiles" onClick={onExtrude}>
        <Layers3 size={14} aria-hidden="true" />
        Extrude
      </button>
      <span className="sketch-rail-divider" aria-hidden="true" />
      <button
        type="button"
        className="sketch-rail-exit"
        title="Finish Sketch"
        onClick={onExit}
      >
        <Check size={14} aria-hidden="true" />
        Finish Sketch
      </button>
    </div>
  );
}
