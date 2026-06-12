import { GenerativeDesignViewer, type ViewerSettings } from './GenerativeDesignViewer';
import { ViewerToolbar } from './ViewerToolbar';
import { SelectionLegend } from './SelectionLegend';
import type { BodyRepresentation } from '@openzcad/shared';
import type { BodyLoad, BodyRole, WorkflowCounts } from '../lib/workflow';

interface ViewerShellProps {
  bodies: BodyRepresentation[];
  bodyRoles: Record<string, BodyRole | null>;
  bodyLoads: Record<string, BodyLoad>;
  counts: WorkflowCounts;
  selectedBodyId: string | null;
  settings: ViewerSettings;
  fitSignal: number;
  outcomePreviewScale: number | null;
  previewOutcomeName: string | null;
  onSelectBody(bodyId: string | null): void;
  onToggleGrid(): void;
  onToggleLoads(): void;
  onFit(): void;
}

export function ViewerShell({
  bodies,
  bodyRoles,
  bodyLoads,
  counts,
  selectedBodyId,
  settings,
  fitSignal,
  outcomePreviewScale,
  previewOutcomeName,
  onSelectBody,
  onToggleGrid,
  onToggleLoads,
  onFit
}: ViewerShellProps) {
  return (
    <section className="viewer-shell" aria-label="3D viewport">
      <GenerativeDesignViewer
        bodies={bodies}
        bodyRoles={bodyRoles}
        bodyLoads={bodyLoads}
        selectedBodyId={selectedBodyId}
        settings={settings}
        fitSignal={fitSignal}
        outcomePreviewScale={outcomePreviewScale}
        onSelectBody={onSelectBody}
      />
      <ViewerToolbar
        settings={settings}
        onToggleGrid={onToggleGrid}
        onToggleLoads={onToggleLoads}
        onFit={onFit}
      />
      {bodies.length > 0 && <SelectionLegend counts={counts} />}
      {bodies.length === 0 && (
        <div className="viewer-notice">
          <div>
            <strong>No geometry yet</strong>
            <small>
              Use the Model step to add primitives, sketch and extrude profiles, or import an
              STL mesh.
            </small>
          </div>
        </div>
      )}
      <div className="viewer-watermark">
        {previewOutcomeName ? `preview · ${previewOutcomeName}` : 'mock kernel'}
      </div>
    </section>
  );
}
