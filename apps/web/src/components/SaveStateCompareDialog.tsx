import { useEffect, useRef, useState } from 'react';
import { GitCompare } from 'lucide-react';
import {
  UNITS_CONVERT_SYMBOLS,
  type SaveStateDiff,
  type SaveStateDiffGroup
} from '@openzcad/document-core';
import { useModalFocus } from '../lib/useModalFocus';

/** One section of a comparison as the dialog lists it. */
export interface SaveStateDiffSection {
  heading: string;
  lines: string[];
}

function groupLines(group: SaveStateDiffGroup): string[] {
  return [
    ...group.added.map((item) => `Added “${item.name}”`),
    ...group.removed.map((item) => `Removed “${item.name}”`),
    ...group.changed.map((item) => `“${item.name}”: ${item.changes.join(', ')}`)
  ];
}

/** The comparison in words, sections with nothing in them left out. */
export function describeSaveStateDiff(
  diff: SaveStateDiff
): SaveStateDiffSection[] {
  const sections: SaveStateDiffSection[] = [
    {
      heading: 'Project',
      lines: [
        ...diff.properties.map(
          (property) =>
            `${property.field === 'name' ? 'Name' : 'Units'}: ${property.before} → ${property.after}`
        ),
        ...(diff.unitConversion
          ? [
              `Converted stored units ${UNITS_CONVERT_SYMBOLS[diff.unitConversion.from]} → ${UNITS_CONVERT_SYMBOLS[diff.unitConversion.to]} (${diff.unitConversion.values} ${diff.unitConversion.values === 1 ? 'value' : 'values'})`
            ]
          : [])
      ]
    },
    {
      heading: 'Features',
      lines: [
        ...groupLines(diff.features),
        ...(diff.features.reordered ? ['History order changed'] : [])
      ]
    },
    {
      heading: 'Parameters',
      lines: diff.parameters.map((change) =>
        change.before === null
          ? `Added ${change.name} = ${change.after}`
          : change.after === null
            ? `Removed ${change.name} (was ${change.before})`
            : change.before === change.after
              ? `${change.name}: settings changed`
              : `${change.name}: ${change.before} → ${change.after}${
                  change.settingsChanged ? ', settings changed' : ''
                }`
      )
    },
    { heading: 'Sketches', lines: groupLines(diff.sketches) },
    { heading: 'Bodies', lines: groupLines(diff.bodies) },
    { heading: 'Drawing sheets', lines: groupLines(diff.drawingSheets) }
  ];
  return sections.filter((section) => section.lines.length > 0);
}

export interface SaveStateCompareOption {
  /** `current` for the open project, else a save point's id. */
  id: string;
  label: string;
}

export interface SaveStateCompareDialogProps {
  /** The save point the comparison starts from. */
  label: string;
  /** What it can be compared with; the first is the default. */
  options: SaveStateCompareOption[];
  /** Builds the comparison from this save point to the chosen one. */
  compare(againstId: string): Promise<SaveStateDiff>;
  onClose(): void;
}

/**
 * L03 diff between two save states, or a save state and the project now.
 * Both documents are opened and compared in the browser; nothing is sent.
 */
export function SaveStateCompareDialog({
  label,
  options,
  compare,
  onClose
}: SaveStateCompareDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true });
  const [againstId, setAgainstId] = useState(options[0]?.id ?? 'current');
  const [result, setResult] = useState<
    | { state: 'loading' }
    | { state: 'ready'; sections: SaveStateDiffSection[] }
    | { state: 'failed'; message: string }
  >({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setResult({ state: 'loading' });
    compare(againstId).then(
      (diff) => {
        if (!cancelled)
          setResult({ state: 'ready', sections: describeSaveStateDiff(diff) });
      },
      (error: unknown) => {
        if (!cancelled)
          setResult({
            state: 'failed',
            message:
              error instanceof Error && error.message
                ? error.message
                : 'Could not compare these versions.'
          });
      }
    );
    return () => {
      cancelled = true;
    };
    // `compare` is the caller's per-render closure; the choice is the input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [againstId]);
  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="save-compare-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-compare-dialog-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="save-compare-dialog-title">
          <GitCompare size={16} aria-hidden="true" />
          Compare “{label}”
        </h2>
        <label className="save-compare-against">
          <span>With</span>
          <select
            value={againstId}
            onChange={(event) => setAgainstId(event.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="save-compare-result" aria-live="polite">
          {result.state === 'loading' ? (
            <p>Comparing…</p>
          ) : result.state === 'failed' ? (
            <p role="alert">{result.message}</p>
          ) : result.sections.length === 0 ? (
            <p>No changes to the model.</p>
          ) : (
            result.sections.map((section) => (
              <section
                key={section.heading}
                className="save-compare-section"
                aria-label={section.heading}
              >
                <h3>{section.heading}</h3>
                <ul>
                  {section.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
        <div className="save-compare-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
