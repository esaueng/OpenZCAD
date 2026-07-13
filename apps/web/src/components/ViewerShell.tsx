import {
  ModelViewer,
  type SketchOverlay,
  type StandardView,
  type ViewerSettings
} from './ModelViewer';
import { ViewerToolbar } from './ViewerToolbar';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';

interface ViewerShellProps {
  bodies: BodyRepresentation[];
  sketches: SketchOverlay[];
  selectedBodyIds: string[];
  selectedTopology: TopologySelection | null;
  settings: ViewerSettings;
  fitSignal: number;
  viewRequest: { view: StandardView; nonce: number } | null;
  onSelectTopology(selection: TopologySelection | null, additive: boolean): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
}

export function ViewerShell({
  bodies,
  sketches,
  selectedBodyIds,
  selectedTopology,
  settings,
  fitSignal,
  viewRequest,
  onSelectTopology,
  onToggleGrid,
  onFit,
  onView,
  onCycleDisplayMode
}: ViewerShellProps) {
  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <ModelViewer
        bodies={bodies}
        sketches={sketches}
        selectedBodyIds={selectedBodyIds}
        selectedTopology={selectedTopology}
        settings={settings}
        fitSignal={fitSignal}
        viewRequest={viewRequest}
        onSelectTopology={onSelectTopology}
      />
      <ViewerToolbar
        settings={settings}
        onToggleGrid={onToggleGrid}
        onFit={onFit}
        onView={onView}
        onCycleDisplayMode={onCycleDisplayMode}
      />
      {bodies.length === 0 && sketches.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            <small>
              Pick a tool from the toolbar above — try <b>Box</b> (B) — or
              sketch a profile and extrude it.
            </small>
            <small className="viewer-notice-keys">
              <kbd>Ctrl</kbd>+<kbd>K</kbd> all commands · <kbd>?</kbd> shortcuts
            </small>
          </div>
        </div>
      )}
      <div className="viewer-watermark">openzcad kernel · exact b-rep</div>
    </section>
  );
}
