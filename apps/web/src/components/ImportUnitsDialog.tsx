import { useRef, useState } from 'react';
import { Ruler } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import {
  describeReadingSize,
  IMPORT_UNIT_CHOICES,
  IMPORT_UNIT_LABELS
} from '../lib/importUnits';
import { useModalFocus } from '../lib/useModalFocus';

export interface ImportUnitsDialogProps {
  fileName: string;
  /**
   * The file's own numbers: width, depth (and height for a mesh); null when
   * they could not be measured, and the choices show no sizes.
   */
  extent: readonly number[] | null;
  documentUnits: UnitSystem;
  /** Preselected: what the import assumed before it asked. */
  initialUnit: UnitSystem;
  /**
   * The reading, and whether to stop asking for unitless files; null when
   * the import was cancelled.
   */
  onChoose(choice: { units: UnitSystem; remember: boolean } | null): void;
}

/**
 * Asks how to read a file that states no unit. Each choice shows the size
 * it would make in the project's units, which is usually enough to tell a
 * 20 mm part from a 20 inch one at a glance.
 */
export function ImportUnitsDialog({
  fileName,
  extent,
  documentUnits,
  initialUnit,
  onChoose
}: ImportUnitsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  const [units, setUnits] = useState<UnitSystem>(initialUnit);
  const [remember, setRemember] = useState(false);

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog import-units-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-units-title"
        aria-describedby="import-units-scope"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onChoose(null);
          }
        }}
      >
        <h2 id="import-units-title">
          <Ruler size={16} aria-hidden="true" />
          Units for {fileName}
        </h2>
        <p id="import-units-scope" className="export-dialog-scope">
          This file does not say what unit its numbers are in. Choose how to
          read them.
        </p>
        <fieldset className="export-dialog-group">
          <legend>Read the file as</legend>
          {IMPORT_UNIT_CHOICES.map((choice) => (
            <label key={choice} className="export-dialog-option">
              <input
                type="radio"
                name="import-units"
                value={choice}
                aria-label={IMPORT_UNIT_LABELS[choice]}
                aria-describedby={
                  extent ? `import-units-size-${choice}` : undefined
                }
                checked={units === choice}
                onChange={() => setUnits(choice)}
              />
              <span aria-hidden="true">{IMPORT_UNIT_LABELS[choice]}</span>
              {extent ? (
                <small id={`import-units-size-${choice}`}>
                  {describeReadingSize(extent, choice, documentUnits)}
                </small>
              ) : null}
            </label>
          ))}
        </fieldset>
        <label className="export-dialog-custom">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Always read unitless files this way (change it in Settings)
        </label>
        <div className="export-dialog-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => onChoose(null)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onChoose({ units, remember })}
          >
            Import in {IMPORT_UNIT_LABELS[units].toLowerCase()}
          </button>
        </div>
      </div>
    </div>
  );
}
