import { useEffect, useRef, useState } from 'react';
import {
  CircleCheck,
  Download,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react';
import type { MeshQualityReport } from '@openzcad/kernel-adapter/exact';
import {
  resolveExportUnits,
  type ExportUnits,
  type UnitSystem
} from '@openzcad/shared';
import { countLabel } from '../lib/toasts';
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

/**
 * The largest angle a facet may turn along a curved face. 20° is the kernel's
 * own default (0.35 rad), sent as no angle at all so a default export stays
 * byte-for-byte what it was; tighter angles add facets on small radii, where
 * the chord deviation alone leaves a visibly polygonal hole.
 */
const ANGLE_OPTIONS = [20, 15, 10, 5] as const;
type AngleOption = (typeof ANGLE_OPTIONS)[number];

function angularToleranceFor(angle: AngleOption): number | undefined {
  return angle === 20 ? undefined : (angle * Math.PI) / 180;
}

const UNIT_NAMES: Record<UnitSystem, string> = {
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',
  inch: 'inches'
};

/** Formats whose numbers follow the export unit; glTF is metres by spec. */
const UNIT_FREE_FORMATS: ReadonlySet<MeshExportDialogFormat> = new Set(['glb']);

function formatDeviation(value: number): string {
  if (value === 0) return '0';
  return value >= 0.01 ? value.toFixed(3) : value.toPrecision(2);
}

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
  /**
   * Bodies hidden in the viewport that an all-bodies export could write.
   * Above zero the dialog offers the choice; a selection export passes 0.
   */
  hiddenBodies?: number;
  includeHidden?: boolean;
  onIncludeHiddenChange?(include: boolean): void;
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
  onExport(
    format: MeshExportDialogFormat,
    deflection: number,
    options?: { angularTolerance?: number }
  ): void;
  /**
   * Checks the mesh the export would write. `units` is the space its writer
   * tessellates in: the export unit, or millimetres for glTF.
   */
  onCheckQuality(
    deflection: number,
    options?: {
      angularTolerance?: number;
      units?: UnitSystem;
      onProgress?(progress: ExportProgress): void;
    }
  ): Promise<MeshQualityReport>;
  /** The export-unit preference, and the project units it may defer to. */
  exportUnits?: ExportUnits;
  documentUnits?: UnitSystem;
  onExportUnitsChange?(units: ExportUnits): void;
}

/**
 * Mesh export with explicit quality and a pre-flight watertightness check.
 * The check runs at the deflection the export would use, so its verdict
 * describes the file being written, not an idealized mesh.
 */
export function ExportDialog({
  scopeLabel,
  hiddenBodies = 0,
  includeHidden = true,
  onIncludeHiddenChange,
  bodies,
  revision,
  onClose,
  onExport,
  onCheckQuality,
  exportUnits = 'mm',
  documentUnits = 'mm',
  onExportUnitsChange
}: ExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Escape must still close the dialog when focus has fallen out of it (a
  // click on the backdrop drops it on the body). The workspace keymap stands
  // down while the dialog is open, so nothing else would take the key.
  useModalFocus(dialogRef, { autoFocus: true });

  const [format, setFormat] = useState<MeshExportDialogFormat>('3mf');
  const [preset, setPreset] = useState<QualityPresetId>('standard');
  const [customDeflection, setCustomDeflection] = useState('0.05');
  const [angle, setAngle] = useState<AngleOption>(20);
  const [phase, setPhase] = useState<'idle' | 'checking'>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<{
    deflection: number;
    angle: AngleOption;
    units: UnitSystem;
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
      // useModalFocus hands a body-targeted Escape to the dialog itself;
      // that copy bubbles here too and was already handled there.
      if (
        event.key === 'Escape' &&
        dialog &&
        !dialog.contains(document.activeElement) &&
        !(event.target instanceof Node && dialog.contains(event.target))
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

  // The space the chosen writer tessellates in: glTF's root node scales a
  // millimetre mesh, every other format meshes in the export unit itself.
  const tessellationUnits: UnitSystem = UNIT_FREE_FORMATS.has(format)
    ? 'mm'
    : resolveExportUnits(exportUnits, documentUnits);
  const bodyName = (bodyId: string) =>
    bodies.find((body) => body.bodyId === bodyId)?.name ?? bodyId;
  const staleReason =
    report === null
      ? null
      : report.scope !== scope
        ? 'scope'
        : report.deflection !== deflection ||
            report.angle !== angle ||
            report.units !== tessellationUnits
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
    const checkedAngle = angle;
    const checkedUnits = tessellationUnits;
    const angularTolerance = angularToleranceFor(checkedAngle);
    setPhase('checking');
    setProgress('preparing');
    setError(null);
    try {
      const result = await onCheckQuality(deflection, {
        onProgress: setProgress,
        ...(angularTolerance === undefined ? {} : { angularTolerance }),
        ...(checkedUnits === 'mm' ? {} : { units: checkedUnits })
      });
      setReport({
        deflection,
        angle: checkedAngle,
        units: checkedUnits,
        scope: checkedScope,
        result
      });
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
    const angularTolerance = angularToleranceFor(angle);
    if (angularTolerance === undefined) onExport(format, deflection);
    else onExport(format, deflection, { angularTolerance });
    onClose();
  }

  const writtenUnits = UNIT_FREE_FORMATS.has(format)
    ? 'm'
    : resolveExportUnits(exportUnits, documentUnits);

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        tabIndex={-1}
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
            ? 'in meters, the unit glTF defines.'
            : writtenUnits === 'mm'
              ? 'in millimeters, ready for slicing.'
              : format === '3mf'
                ? `in ${UNIT_NAMES[writtenUnits]}, declared in the package.`
                : `in ${UNIT_NAMES[writtenUnits]}. The file does not record its unit.`}
        </p>
        {hiddenBodies > 0 && onIncludeHiddenChange && (
          <label className="export-dialog-custom">
            <input
              type="checkbox"
              checked={includeHidden}
              onChange={(event) => onIncludeHiddenChange(event.target.checked)}
            />
            Include {countLabel(hiddenBodies, 'hidden body', 'hidden bodies')}
          </label>
        )}

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
                aria-pressed={preset === entry.id}
                onClick={() => setPreset(entry.id)}
              >
                {entry.label}
                <small>{entry.deflection} mm</small>
              </button>
            ))}
            <button
              type="button"
              className={preset === 'custom' ? 'active' : undefined}
              aria-pressed={preset === 'custom'}
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
          <div className="export-dialog-fields">
            <label className="export-dialog-custom">
              <span>Max facet angle</span>
              <select
                value={angle}
                onChange={(event) =>
                  setAngle(Number(event.target.value) as AngleOption)
                }
              >
                {ANGLE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option === 20 ? '20° (default)' : `${option}°`}
                  </option>
                ))}
              </select>
            </label>
            {onExportUnitsChange ? (
              <label className="export-dialog-custom">
                <span>Units</span>
                <select
                  value={exportUnits}
                  disabled={UNIT_FREE_FORMATS.has(format)}
                  onChange={(event) =>
                    onExportUnitsChange(event.target.value as ExportUnits)
                  }
                >
                  <option value="document">
                    Project ({UNIT_NAMES[documentUnits]})
                  </option>
                  <option value="mm">Millimeters</option>
                  <option value="cm">Centimeters</option>
                  <option value="m">Meters</option>
                  <option value="inch">Inches</option>
                </select>
              </label>
            ) : null}
          </div>
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
              disabled={deflection === null || bodies.length === 0}
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
                ) : (
                  <ShieldCheck size={13} />
                )}
              </span>
              <StableLabel
                reserve={['Re-check watertightness', 'Check watertightness']}
              >
                {report && !staleReport
                  ? 'Re-check watertightness'
                  : 'Check watertightness'}
              </StableLabel>
            </button>
          </header>
          {report && !staleReport ? (
            <p className="export-dialog-measure" role="status">
              {`${report.result.triangleCount.toLocaleString('en-US')} ${report.result.triangleCount === 1 ? 'triangle' : 'triangles'} · measured deviation ${formatDeviation(report.result.maxDeviation)} mm of ${report.deflection} mm allowed${report.result.sampled ? ' (sampled)' : ''}`}
            </p>
          ) : null}
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
                      : `${countLabel(body.boundaryEdges, 'open edge', 'open edges')}, ${countLabel(body.nonManifoldEdges, 'non-manifold edge', 'non-manifold edges')}`}
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
            disabled={
              deflection === null || phase !== 'idle' || bodies.length === 0
            }
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
