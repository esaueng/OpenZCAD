import type {
  PlaneId,
  ProjectDocument,
  SketchPlaneRef
} from '@openzcad/shared';
import { earlierDatumPlanes } from '../lib/datumPlaneDisplay';
import { PLANE_LABELS } from '../lib/model';

export interface SketchPlanePromptProps {
  document: ProjectDocument;
  offsetText: string;
  /**
   * The exact projection matches this version. Until it does a datum's
   * frame is the previous build's, and a sketch entered on it would be drawn
   * against a plane that is about to move.
   */
  datumsReady: boolean;
  onOffsetTextChange(text: string): void;
  onPickPlane(plane: PlaneId): void;
  /** Enters a sketch on `plane`, saying `status` on the status line. */
  onEnterSketch(plane: SketchPlaneRef, status: string): void;
  onCancel(): void;
}

/**
 * The Sketch tool's plane chooser: a command card like any other. It floated
 * over the viewport's top edge, where the mode toggle and, at 1024 px, the
 * project name drew over its title and its ×. Loaded with the gesture (and
 * prefetched on idle), not with the workspace: the entry chunk has no room.
 *
 * Besides the principal planes it offers every resolved R01 datum plane; a
 * sketch started on one is attached to it by id.
 */
export function SketchPlanePrompt({
  document,
  offsetText,
  datumsReady,
  onOffsetTextChange,
  onPickPlane,
  onEnterSketch,
  onCancel
}: SketchPlanePromptProps) {
  // A datum reference holds no offset of its own, so a typed offset would be
  // dropped without a word: datum buttons wait until it is back to zero.
  const offset = Number(offsetText);
  const offsetBlocksDatums = offsetText.trim() !== '' && offset !== 0;
  return (
    <div className="sketch-plane-prompt" role="status">
      <span>
        <strong>Pick a sketch plane</strong>
        <small>
          Click a planar face on the model, or start on a principal plane.
        </small>
      </span>
      <label className="sketch-plane-offset">
        <span>Offset</span>
        <input
          type="number"
          step="any"
          value={offsetText}
          aria-label="Sketch plane offset"
          onChange={(event) => onOffsetTextChange(event.target.value)}
        />
        <span className="sketch-plane-offset-units">{document.units}</span>
      </label>
      <span className="sketch-plane-buttons">
        {(['XY', 'XZ', 'YZ'] as const).map((plane) => (
          <button key={plane} type="button" onClick={() => onPickPlane(plane)}>
            {PLANE_LABELS[plane]}
          </button>
        ))}
        {earlierDatumPlanes(document, null)
          .filter((datum) => document.derived.datumFrames?.[datum.featureId])
          .map((datum) => (
            <button
              key={datum.featureId}
              type="button"
              aria-label={`Sketch on ${datum.name}`}
              disabled={offsetBlocksDatums || !datumsReady}
              title={
                !datumsReady
                  ? `Waiting for exact geometry before sketching on ${datum.name}.`
                  : offsetBlocksDatums
                    ? `The offset applies to the principal planes only. Set it to 0 to sketch on ${datum.name}, or make an offset plane from it.`
                    : `Sketch on the datum plane ${datum.name}`
              }
              onClick={() =>
                onEnterSketch(
                  { type: 'datum', datumFeatureId: datum.featureId },
                  `Sketching on ${datum.name} · Finish Sketch when done.`
                )
              }
            >
              {datum.name}
            </button>
          ))}
        <button
          type="button"
          className="sketch-plane-dismiss"
          aria-label="Cancel sketch"
          title="Cancel sketch (Esc)"
          onClick={onCancel}
        >
          ×
        </button>
      </span>
    </div>
  );
}
