import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCopy, Download, SquareDashed } from 'lucide-react';
import type { FeatureId, UnitSystem } from '@openzcad/shared';
import {
  flatPatternDxf,
  flatPatternExtents,
  flatPatternSvg,
  type SheetMetalFlatPattern
} from '@openzcad/kernel-adapter/sheet-metal-flat-pattern';
import { useModalFocus } from '../lib/useModalFocus';
import { unitLabel } from '../lib/measurements';
import { exportFileStem, formatNumber } from '../lib/model';
import {
  bendTableCsv,
  bendTableHeadings,
  bendTableRows,
  flatPatternChangedWarning
} from '../lib/sheetMetalFlatPattern';

export interface FlatPatternDialogProps {
  /** The sheet-metal features to choose from; at least one. */
  features: readonly { featureId: FeatureId; name: string }[];
  initialFeatureId: FeatureId;
  /** The document's units: the pattern, the table and the files use them. */
  units: UnitSystem;
  /** The project's name, for the file names. */
  projectName: string;
  /** Rebuilds the feature's flat pattern (the geometry worker). */
  loadPattern(featureId: FeatureId): Promise<SheetMetalFlatPattern>;
  /** Saves one exported file; resolves false when the user cancelled. */
  onSave(file: {
    fileName: string;
    format: 'dxf' | 'svg';
    text: string;
  }): Promise<boolean>;
  /** Puts text on the clipboard. */
  onCopy(text: string): Promise<void>;
  onClose(): void;
}

type Load =
  | { featureId: FeatureId; status: 'loading' }
  | { featureId: FeatureId; status: 'ready'; pattern: SheetMetalFlatPattern }
  | { featureId: FeatureId; status: 'error'; message: string };

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * M16 slice 4: the flat-pattern view of a sheet-metal feature — the flat
 * sheet with its bend lines (dashed, up and down told apart) and notes, its
 * overall size, the bend table, and the DXF, SVG and CSV outputs. Read-only:
 * nothing here edits the document.
 */
export function FlatPatternDialog({
  features,
  initialFeatureId,
  units,
  projectName,
  loadPattern,
  onSave,
  onCopy,
  onClose
}: FlatPatternDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef: closeRef });
  const [featureId, setFeatureId] = useState<FeatureId>(initialFeatureId);
  const [load, setLoad] = useState<Load>({
    featureId: initialFeatureId,
    status: 'loading'
  });
  const [notice, setNotice] = useState<string | null>(null);
  const loadRef = useRef(loadPattern);
  loadRef.current = loadPattern;

  useEffect(() => {
    let active = true;
    setLoad({ featureId, status: 'loading' });
    setNotice(null);
    loadRef.current(featureId).then(
      (pattern) => {
        if (active) setLoad({ featureId, status: 'ready', pattern });
      },
      (error: unknown) => {
        if (!active) return;
        setLoad({
          featureId,
          status: 'error',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'The flat pattern could not be built.'
        });
      }
    );
    return () => {
      active = false;
    };
  }, [featureId]);

  const feature =
    features.find((entry) => entry.featureId === featureId) ?? features[0];
  const pattern = load.status === 'ready' ? load.pattern : null;
  const view = useMemo(() => {
    if (!pattern) return null;
    try {
      return {
        kind: 'drawn' as const,
        svg: flatPatternSvg(pattern, {
          units,
          ...(feature ? { title: `${feature.name} flat pattern` } : {})
        }),
        preview: svgDataUrl(
          flatPatternSvg(pattern, { units, transparent: false })
        ),
        extents: flatPatternExtents(pattern),
        rows: bendTableRows(pattern)
      };
    } catch (error) {
      return {
        kind: 'error' as const,
        error:
          error instanceof Error
            ? error.message
            : 'The flat pattern could not be drawn.'
      };
    }
  }, [pattern, units, feature]);
  const length = unitLabel('length', units);
  const warning = pattern ? flatPatternChangedWarning(pattern.changedBy) : null;
  const stem = `${exportFileStem(projectName)}-${exportFileStem(feature?.name ?? 'sheet-metal')}-flat`;
  const drawn = view?.kind === 'drawn' ? view : null;

  async function save(format: 'dxf' | 'svg') {
    if (!pattern || !drawn) return;
    const fileName = `${stem}.${format}`;
    try {
      const text =
        format === 'dxf' ? flatPatternDxf(pattern, units) : drawn.svg;
      const saved = await onSave({ fileName, format, text });
      setNotice(saved ? `Saved ${fileName}.` : 'Export cancelled.');
    } catch (error) {
      setNotice(
        error instanceof Error && error.message
          ? error.message
          : `${format.toUpperCase()} export failed.`
      );
    }
  }

  async function copyTable() {
    if (!pattern) return;
    try {
      await onCopy(bendTableCsv(pattern, units));
      setNotice('Bend table copied as CSV.');
    } catch {
      setNotice('The clipboard is unavailable; the bend table was not copied.');
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog flat-pattern-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flat-pattern-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="flat-pattern-title">
          <SquareDashed size={16} aria-hidden="true" />
          Flat pattern{feature ? ` — ${feature.name}` : ''}
        </h2>
        {features.length > 1 && (
          <label className="export-dialog-custom">
            <span>Sheet metal</span>
            <select
              value={featureId}
              onChange={(event) =>
                setFeatureId(event.target.value as FeatureId)
              }
            >
              {features.map((entry) => (
                <option key={entry.featureId} value={entry.featureId}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {warning && (
          <p className="flat-pattern-warning" role="note">
            {warning}
          </p>
        )}
        {load.status === 'loading' && (
          <p className="export-dialog-progress" role="status">
            Unfolding…
          </p>
        )}
        {load.status === 'error' && (
          <p className="export-dialog-error" role="alert">
            {load.message}
          </p>
        )}
        {view?.kind === 'error' && (
          <p className="export-dialog-error" role="alert">
            {view.error}
          </p>
        )}
        {drawn && (
          <>
            <img
              className="flat-pattern-preview"
              src={drawn.preview}
              alt={`Flat pattern of ${feature?.name ?? 'the sheet'}: outline with ${drawn.rows.length} bend ${drawn.rows.length === 1 ? 'line' : 'lines'}`}
            />
            <p className="flat-pattern-legend">
              <span className="flat-pattern-key" data-direction="up">
                Up
              </span>
              <span className="flat-pattern-key" data-direction="down">
                Down
              </span>
              <span className="flat-pattern-size">
                Flat size{' '}
                <strong>
                  {formatNumber(drawn.extents.width)} ×{' '}
                  {formatNumber(drawn.extents.height)} {length}
                </strong>
                , {formatNumber(pattern!.thickness)} {length} thick
              </span>
            </p>
            {drawn.rows.length === 0 ? (
              <p className="export-dialog-scope">A flat sheet: no bends yet.</p>
            ) : (
              <div className="flat-pattern-table-wrap">
                <table className="flat-pattern-table" aria-label="Bend table">
                  <thead>
                    <tr>
                      {bendTableHeadings(units).map((heading) => (
                        <th key={heading} scope="col">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {drawn.rows.map((row) => (
                      <tr key={row.number}>
                        <td>{row.number}</td>
                        <td>{row.direction}</td>
                        <td>{row.angle}</td>
                        <td>{row.insideRadius}</td>
                        <td>{row.kFactor}</td>
                        <td>{row.bendAllowance}</td>
                        <td>{row.bendDeduction}</td>
                        <td>{row.lineLength}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="export-dialog-hint">
              Nominal shop values (K-factor and allowances are rules of thumb,
              not a certification). Files are at 1:1 in {length}.
            </p>
          </>
        )}
        <div className="export-dialog-status" role="status">
          {notice}
        </div>
        <div className="export-dialog-actions flat-pattern-actions">
          <button
            ref={closeRef}
            type="button"
            className="secondary"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!drawn || drawn.rows.length === 0}
            onClick={() => void copyTable()}
          >
            <ClipboardCopy size={13} aria-hidden="true" />
            Copy bend table
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!drawn}
            onClick={() => void save('svg')}
          >
            <Download size={13} aria-hidden="true" />
            Export SVG
          </button>
          <button
            type="button"
            className="primary"
            disabled={!drawn}
            onClick={() => void save('dxf')}
          >
            <Download size={13} aria-hidden="true" />
            Export DXF
          </button>
        </div>
      </div>
    </div>
  );
}
