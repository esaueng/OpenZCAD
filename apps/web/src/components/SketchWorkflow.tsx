import type { SketchProfileAnalysis } from '@openzcad/geometry';
import type { SketchSessionState } from '../lib/interaction/machine';
import { constraintToolSpec } from '../lib/sketch/constraints';
import { sketchEditToolSpec } from '../lib/sketch/edits';
import { sketchDrawToolLabel } from './SketchToolRail';

export interface SketchWorkflowProps {
  plane: string;
  /**
   * What the rails have live: an armed relation or modify tool, with its
   * picks so far, ahead of the draw tool under it.
   */
  tool: Pick<
    SketchSessionState,
    'tool' | 'circleMode' | 'pendingConstraint' | 'pendingEdit'
  >;
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

/**
 * The live tool named as the rails name it ("Diameter circle", "Fillet: 1/2
 * selected"). Written out here rather than capitalised by CSS, which turned
 * a pick count into "0/1 Selected".
 */
function toolReadout(session: SketchWorkflowProps['tool']): string {
  const armed = session.pendingConstraint
    ? {
        spec: constraintToolSpec(session.pendingConstraint.kind),
        picks: session.pendingConstraint.picks.length
      }
    : session.pendingEdit
      ? {
          spec: sketchEditToolSpec(session.pendingEdit.kind),
          picks: session.pendingEdit.picks.length
        }
      : null;
  return armed
    ? `${armed.spec.label}: ${armed.picks}/${armed.spec.picks} selected`
    : sketchDrawToolLabel(session.tool, session.circleMode);
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
        <span>{toolReadout(props.tool)}</span>
      </p>
      <div
        className="sketch-workflow-snaps"
        role="group"
        aria-label="Sketch snapping"
      >
        {/* A toggle keeps one name and says on or off by being pressed:
            "Geometry snaps off", pressed, was read out as a contradiction. */}
        <button
          type="button"
          aria-pressed={props.geometrySnaps}
          onClick={props.onGeometrySnaps}
        >
          Geometry snaps
        </button>
        <button
          type="button"
          aria-pressed={props.gridSnaps}
          onClick={props.onGridSnaps}
        >
          Grid snaps
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
          <button
            type="button"
            className="secondary"
            onClick={props.onDiagnose}
          >
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
      {/* The Shift hint is the palette's footer, under the settings. */}
      <p className="muted">
        Select geometry to edit dimensions. Finish Sketch keeps completed
        geometry.
      </p>
    </section>
  );
}
