import { ModelViewer, type ViewerSettings } from './ModelViewer';
import { ViewerToolbar } from './ViewerToolbar';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';

interface ViewerShellProps {
  bodies: BodyRepresentation[];
  selectedBodyId: string | null;
  selectedTopology: TopologySelection | null;
  settings: ViewerSettings;
  fitSignal: number;
  onSelectTopology(selection: TopologySelection | null): void;
  onToggleGrid(): void;
  onFit(): void;
}

export function ViewerShell({
  bodies,
  selectedBodyId,
  selectedTopology,
  settings,
  fitSignal,
  onSelectTopology,
  onToggleGrid,
  onFit
}: ViewerShellProps) {
  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <ModelViewer
        bodies={bodies}
        selectedBodyId={selectedBodyId}
        selectedTopology={selectedTopology}
        settings={settings}
        fitSignal={fitSignal}
        onSelectTopology={onSelectTopology}
      />
      <ViewerToolbar
        settings={settings}
        onToggleGrid={onToggleGrid}
        onFit={onFit}
      />
      {bodies.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            <small>
              Add a primitive, or sketch a profile and extrude or revolve it,
              from the panel on the right.
            </small>
          </div>
        </div>
      )}
      <div className="viewer-watermark">openzcad kernel · exact b-rep</div>
    </section>
  );
}
