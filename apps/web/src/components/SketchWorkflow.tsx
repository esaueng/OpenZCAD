import type { SketchProfileAnalysis } from '@openzcad/geometry';

export interface SketchWorkflowProps {
  plane: string;
  tool: string;
  objects: { id: string; label: string }[];
  selectedId: string | null;
  analysis: SketchProfileAnalysis | null;
  analysisError: string | null;
  geometrySnaps: boolean;
  gridSnaps: boolean;
  busy: boolean;
  error: string | null;
  onSelect(id: string | null): void;
  onGeometrySnaps(): void;
  onGridSnaps(): void;
  onDiagnose(): void;
}

/** Persistent, document-backed orientation and feedback for the sketch session. */
export function SketchWorkflow(props: SketchWorkflowProps) {
  const profiles = props.analysis?.profiles.length ?? 0;
  const problems =
    props.analysis?.diagnostics.filter(
      (d) => d.severity !== 'info' || d.code === 'open-endpoint'
    ) ?? [];
  return (
    <section className="sketch-workflow" aria-label="Sketch overview">
      <p className="sketch-workflow-context">
        <strong>{props.plane}</strong>
        <span>{props.tool}</span>
      </p>
      <div
        className="sketch-workflow-snaps"
        role="group"
        aria-label="Sketch snapping"
      >
        <button
          type="button"
          aria-pressed={props.geometrySnaps}
          onClick={props.onGeometrySnaps}
        >
          Geometry snaps {props.geometrySnaps ? 'on' : 'off'}
        </button>
        <button
          type="button"
          aria-pressed={props.gridSnaps}
          onClick={props.onGridSnaps}
        >
          Grid snaps {props.gridSnaps ? 'on' : 'off'}
        </button>
      </div>
      <p className="sketch-workflow-readiness" role="status">
        {props.objects.length === 0
          ? 'Draw a closed outline to make a solid.'
          : `${profiles} closed ${profiles === 1 ? 'profile' : 'profiles'}${profiles ? ' ready to extrude' : ' · close the boundary to extrude'}`}
      </p>
      {props.analysisError && <p role="alert">{props.analysisError}</p>}
      {problems.length > 0 && (
        <details className="sketch-workflow-problems">
          <summary>
            {problems.length} profile{' '}
            {problems.length === 1 ? 'issue' : 'issues'}
          </summary>
          <ul>
            {problems.map((problem, index) => (
              <li key={`${problem.code}-${index}`}>
                <button
                  type="button"
                  onClick={() => {
                    props.onDiagnose();
                    props.onSelect(problem.sourceEntityIds[0] ?? null);
                  }}
                >
                  {problem.message}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={props.onDiagnose}>
            Highlight gaps
          </button>
        </details>
      )}
      {props.objects.length > 0 && (
        <label className="field">
          <span>Selected geometry</span>
          <select
            value={props.selectedId ?? ''}
            disabled={props.busy}
            onChange={(event) => props.onSelect(event.target.value || null)}
          >
            <option value="">Choose geometry to edit</option>
            {props.objects.map((object) => (
              <option key={object.id} value={object.id}>
                {object.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {props.error && (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      )}
      <p className="muted">
        Select geometry to edit dimensions. Shift temporarily disables snapping.
        Finish Sketch keeps completed geometry.
      </p>
    </section>
  );
}
