import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Download,
  LoaderCircle,
  TriangleAlert
} from 'lucide-react';
import type { MeshQualityReport } from '@openzcad/kernel-adapter/exact';
import { useModalFocus } from '../lib/useModalFocus';
import { StableLabel } from './StableLabel';

/** Worker export formats this dialog can request; `stl` is ASCII. */
export type MeshExportDialogFormat =
  '3mf' | 'stl-binary' | 'stl' | 'obj' | 'glb' | 'ply';

const FORMAT_LABELS: Record<MeshExportDialogFormat, string> = {
  '3mf': '3MF',
  'stl-binary': 'STL',
  stl: 'STL',
  obj: 'OBJ',
  glb: 'glTF',
  ply: 'PLY'
};

export interface ExportDialogBody {
  bodyId: string;
  name: string;
}

/**
 * Coarse stages of a running printability check, narrated in the dialog.
 * The caller maps the geometry worker's request states onto these. (An
 * export itself reports through the activity pill once this dialog hands it
 * over, so `saving` is only ever narrated by the host.)
 */
export type ExportProgress =
  'preparing' | 'loading-kernel' | 'building' | 'saving';

const PROGRESS_LABELS: Record<ExportProgress, string> = {
  preparing: 'Preparing…',
  'loading-kernel': 'Loading the geometry kernel…',
  building: 'Building exact geometry…',
  saving: 'Writing the file…'
};

/**
 * Chordal deviation in millimetres, the space every slicer works in. The
 * standard value matches what exports have always used; draft and fine bracket
 * it by the spread slicers themselves default across.
 */
const QUALITY_PRESETS = [
  { id: 'draft', label: 'Draft', deflection: 0.2 },
  { id: 'standard', label: 'Standard', deflection: 0.08 },
  { id: 'fine', label: 'Fine', deflection: 0.02 }
] as const;

type QualityPresetId = (typeof QUALITY_PRESETS)[number]['id'] | 'custom';

const CUSTOM_DEFLECTION_MIN = 0.001;
const CUSTOM_DEFLECTION_MAX = 1;

const FORMAT_OPTIONS: {
  format: MeshExportDialogFormat;
  label: string;
  hint: string;
}[] = [
  {
    format: '3mf',
    label: '3MF',
    hint: 'One package, bodies stay separate — best for slicers'
  },
  {
    format: 'stl-binary',
    label: 'STL (binary)',
    hint: 'Single merged mesh, compact'
  },
  {
    format: 'stl',
    label: 'STL (ASCII)',
    hint: 'Plain text for tools that diff or parse it'
  },
  {
    format: 'obj',
    label: 'OBJ',
    hint: 'One merged mesh for DCC tools'
  },
  {
    format: 'glb',
    label: 'glTF (GLB)',
    hint: 'One merged mesh for web and AR viewers'
  },
  {
    format: 'ply',
    label: 'PLY (binary)',
    hint: 'One merged mesh with vertex normals for mesh tools'
  }
];

export interface ExportDialogProps {
  /** What the export will contain, e.g. a body name or "all bodies (2)". */
  scopeLabel: string;
  /** Bodies in the export, for naming printability rows. */
  bodies: ExportDialogBody[];
  /**
   * The document version the bodies come from. A printability verdict
   * describes one body set at one revision; either moving makes it stale.
   */
  revision: number;
  onClose(): void;
  /**
   * Starts the export. The dialog closes at once: progress, cancel and the
   * outcome are the host's to report, in the activity pill, so the workspace
   * is live while the mesh builds.
   */
  onExport(format: MeshExportDialogFormat, deflection: number): void;
  onCheckQuality(
    deflection: number,
    options?: { onProgress?(progress: ExportProgress): void }
  ): Promise<MeshQualityReport>;
}

/**
 * Mesh export with explicit quality and a pre-flight watertightness check.
 * The check runs at the deflection the export would use, so its verdict
 * describes the file being written, not an idealized mesh.
 */
export function ExportDialog({
  scopeLabel,
  bodies,
  revision,
  onClose,
  onExport,
  onCheckQuality
}: ExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  const [format, setFormat] = useState<MeshExportDialogFormat>('3mf');
  const [preset, setPreset] = useState<QualityPresetId>('standard');
  const [customDeflection, setCustomDeflection] = useState('0.05');
  const [phase, setPhase] = useState<'idle' | 'checking'>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{
    deflection: number;
    scope: string;
    result: MeshQualityReport;
  } | null>(null);
  const scope = `${revision}:${bodies.map((body) => body.bodyId).join(',')}`;

  // Escape must still close the dialog when focus has fallen out of it (a
  // click on the backdrop drops it on the body). The workspace keymap stands
  // down while the dialog is open, so nothing else would take the key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (
        event.key === 'Escape' &&
        dialog &&
        !dialog.contains(document.activeElement)
      ) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const presetDeflection = QUALITY_PRESETS.find(
    (entry) => entry.id === preset
  )?.deflection;
  const parsedCustom = Number(customDeflection);
  const customValid =
    Number.isFinite(parsedCustom) &&
    parsedCustom >= CUSTOM_DEFLECTION_MIN &&
    parsedCustom <= CUSTOM_DEFLECTION_MAX;
  const deflection =
    preset === 'custom'
      ? customValid
        ? parsedCustom
        : null
      : presetDeflection!;

  const bodyName = (bodyId: string) =>
    bodies.find((body) => body.bodyId === bodyId)?.name ?? bodyId;
  const staleReason =
    report === null
      ? null
      : report.scope !== scope
        ? 'scope'
        : report.deflection !== deflection
          ? 'quality'
          : null;
  const staleReport = staleReason !== null;

  async function runQualityCheck() {
    if (deflection === null || phase !== 'idle') {
      return;
    }
    // Bound to what was asked, not what is current when the answer lands:
    // a verdict that arrives after the scope moved must read as stale.
    const checkedScope = scope;
    setPhase('checking');
    setProgress('preparing');
    setError(null);
    try {
      const result = await onCheckQuality(deflection, {
        onProgress: setProgress
      });
      setReport({ deflection, scope: checkedScope, result });
    } catch (checkError) {
      setReport(null);
      setError(
        checkError instanceof Error
          ? checkError.message
          : 'The printability check failed.'
      );
    } finally {
      setPhase('idle');
      setProgress(null);
    }
  }

  function runExport() {
    if (deflection === null || phase !== 'idle') {
      return;
    }
    onExport(format, deflection);
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="export-dialog-title">
          <Download size={16} aria-hidden="true" />
          Export mesh
        </h2>
        <p className="export-dialog-scope">
          {/* glTF fixes its own unit; the size is the same either way. */}
          Exports {scopeLabel}{' '}
          {format === 'glb'
            ? 'in metres, the unit glTF defines.'
            : 'in millimetres, ready for slicing.'}
        </p>

        <fieldset className="export-dialog-group">
          <legend>Format</legend>
          {FORMAT_OPTIONS.map((option) => (
            <label key={option.format} className="export-dialog-option">
              {/* Named by the format alone, with the hint as its description,
                  and a value of its own: without one every radio's value was
                  the browser default "on", which is what assistive tech read. */}
              <input
                type="radio"
                name="export-format"
                value={option.format}
                aria-label={option.label}
                aria-describedby={`export-format-hint-${option.format}`}
                checked={format === option.format}
                onChange={() => setFormat(option.format)}
              />
              <span aria-hidden="true">{option.label}</span>
              <small id={`export-format-hint-${option.format}`}>
                {option.hint}
              </small>
            </label>
          ))}
        </fieldset>

        <fieldset className="export-dialog-group">
          <legend>Mesh quality</legend>
          <div className="export-dialog-presets">
            {QUALITY_PRESETS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={preset === entry.id ? 'active' : undefined}
                onClick={() => setPreset(entry.id)}
              >
                {entry.label}
                <small>{entry.deflection} mm</small>
              </button>
            ))}
            <button
              type="button"
              className={preset === 'custom' ? 'active' : undefined}
              onClick={() => setPreset('custom')}
            >
              Custom
            </button>
          </div>
          {preset === 'custom' ? (
            <label className="export-dialog-custom">
              <span>Max chord deviation (mm)</span>
              <input
                type="number"
                min={CUSTOM_DEFLECTION_MIN}
                max={CUSTOM_DEFLECTION_MAX}
                step="0.001"
                value={customDeflection}
                onChange={(event) => setCustomDeflection(event.target.value)}
              />
            </label>
          ) : null}
          {preset === 'custom' && !customValid ? (
            <p className="export-dialog-error" role="alert">
              Enter a deviation between {CUSTOM_DEFLECTION_MIN} and{' '}
              {CUSTOM_DEFLECTION_MAX} mm.
            </p>
          ) : null}
        </fieldset>

        <section className="export-dialog-group export-dialog-quality">
          <header>
            <strong>Printability</strong>
            {/* aria-disabled, not disabled, while checking: disabling the
                focused button drops focus out of the dialog, and Escape then
                went to the workspace behind it. */}
            <button
              type="button"
              className="secondary"
              disabled={deflection === null}
              aria-disabled={phase !== 'idle' ? true : undefined}
              // Named outright: the visible words sit in a width-reserving
              // grid beside an icon slot, and a reader that did not descend
              // into it announced the button with no name.
              aria-label={
                report && !staleReport
                  ? 'Re-check watertightness'
                  : 'Check watertightness'
              }
              onClick={() => void runQualityCheck()}
            >
              <span className="icon-slot" aria-hidden="true">
                {phase === 'checking' ? (
                  <LoaderCircle size={13} className="spin" />
                ) : null}
              </span>
              <StableLabel reserve={['Re-check', 'Check watertightness']}>
                {report && !staleReport ? 'Re-check' : 'Check watertightness'}
              </StableLabel>
            </button>
          </header>
          {report && !staleReport ? (
            <ul className="export-dialog-report">
              {report.result.bodies.map((body) => (
                <li key={body.bodyId} data-ok={body.watertight}>
                  {body.watertight ? (
                    <CircleCheck size={13} aria-hidden="true" />
                  ) : (
                    <TriangleAlert size={13} aria-hidden="true" />
                  )}
                  <span>{bodyName(body.bodyId)}</span>
                  <small>
                    {body.watertight
                      ? 'watertight'
                      : `${body.boundaryEdges} open, ${body.nonManifoldEdges} non-manifold edge(s)`}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="export-dialog-hint">
              {staleReason === 'scope'
                ? 'The bodies being exported changed — re-check to see the new verdict.'
                : staleReason === 'quality'
                  ? 'Quality changed — re-check to see the new verdict.'
                  : 'Optional: verify every body meshes watertight before exporting.'}
            </p>
          )}
        </section>

        {/* One slot with a reserved line: a progress or error row that
            appeared here pushed the buttons down under the pointer. */}
        <div className="export-dialog-status">
          {error ? (
            <p className="export-dialog-error" role="alert">
              {error}
            </p>
          ) : phase !== 'idle' && progress ? (
            <p className="export-dialog-progress" role="status">
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
              {PROGRESS_LABELS[progress]}
            </p>
          ) : null}
        </div>

        <div className="export-dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={deflection === null || phase !== 'idle'}
            onClick={runExport}
          >
            <Download size={13} aria-hidden="true" />
            Export {FORMAT_LABELS[format]}
          </button>
        </div>
      </div>
    </div>
  );
}
