import type { ProjectDocument } from '@openzcad/shared';
import type { ViewPreset } from '../lib/view';

interface StatusBarProps {
  status: string;
  document: ProjectDocument | null;
  selectedId: string | null;
  viewPreset: ViewPreset;
}

export function StatusBar({
  status,
  document,
  selectedId,
  viewPreset
}: StatusBarProps) {
  return (
    <footer className="status-bar">
      <div className="status-bar__primary">
        <span className="status-dot" />
        <span>{status}</span>
      </div>
      <div className="status-bar__meta">
        <span>View {viewPreset.toUpperCase()}</span>
        <span>{document ? `${document.bodyOrder.length} bodies` : 'No model'}</span>
        <span>{selectedId ? `Selected ${selectedId}` : 'Selection none'}</span>
      </div>
    </footer>
  );
}

