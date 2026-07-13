import type { ProjectDocument } from '@openzcad/shared';
import type { ViewPreset } from '../lib/view';
import type { GeometrySelection, ModelingTool } from '../lib/selection';

interface StatusBarProps {
  status: string;
  document: ProjectDocument | null;
  selectedId: string | null;
  viewPreset: ViewPreset;
  geometrySelection: GeometrySelection | null;
  activeTool: ModelingTool;
}

export function StatusBar({
  status,
  document,
  selectedId,
  viewPreset,
  geometrySelection,
  activeTool
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-bar__primary">
        <span className="status-dot" />
        <span>{status}</span>
      </div>
      <div className="status-bar__meta">
        <span>View {viewPreset.toUpperCase()}</span>
        <span>Tool {activeTool === 'fillet' ? 'FILLET' : 'SELECT'}</span>
        <span>
          {document ? `${document.bodyOrder.length} bodies` : 'No model'}
        </span>
        <span>
          {geometrySelection
            ? `${geometrySelection.kind} · ${geometrySelection.bodyName}`
            : selectedId
              ? 'Model-tree selection'
              : 'Selection none'}
        </span>
      </div>
    </footer>
  );
}
