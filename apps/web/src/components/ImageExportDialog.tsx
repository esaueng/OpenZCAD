import { useEffect, useRef, useState } from 'react';
import { ImageDown } from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import { imageSizeProblem, IMAGE_EXPORT_MAX_SIDE } from '../lib/imageExport';
import { useModalFocus } from '../lib/useModalFocus';

export type ImageExportKind = 'png' | 'svg';

export interface ImageExportSketch {
  sketchId: string;
  name: string;
}

export interface PngExportOptions {
  width: number;
  height: number;
  transparent: boolean;
  showGrid: boolean;
}

export interface SvgExportOptions {
  sketchId: string;
  transparent: boolean;
}

export interface ImageExportDialogProps {
  /** What the PNG draws, e.g. a body name or "visible bodies (2)". */
  viewScopeLabel: string;
  /** The viewport in device pixels: the "View" size, and its aspect. */
  viewSize: { width: number; height: number };
  /** The largest side this device can render. */
  maxSide?: number;
  /** The most pixels an image may have here (the desktop save is smaller). */
  maxPixels?: number;
  /** Null while the view cannot be captured (the model is updating). */
  pngUnavailable?: string | null;
  sketches: ImageExportSketch[];
  /** The sketch being edited or selected, offered first. */
  initialSketchId?: string | null;
  initialKind?: ImageExportKind;
  /** The grid option's starting state: the viewport's own grid setting. */
  initialShowGrid?: boolean;
  units: UnitSystem;
  onClose(): void;
  /** Starts the export; the dialog closes and the host reports the outcome. */
  onExportPng(options: PngExportOptions): void;
  onExportSvg(options: SvgExportOptions): void;
}

const UNIT_NAMES: Record<UnitSystem, string> = {
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',
  inch: 'inches'
};

const FIXED_SIZES = [
  { id: 'hd', label: '1920 × 1080', width: 1920, height: 1080 },
  { id: '4k', label: '3840 × 2160', width: 3840, height: 2160 }
] as const;

type SizePresetId = 'view' | 'view2x' | (typeof FIXED_SIZES)[number]['id'];

/**
 * Image export: the current view as a PNG at a chosen size, or one sketch as
 * an exact SVG at 1:1. Either can leave the background transparent.
 */
export function ImageExportDialog({
  viewScopeLabel,
  viewSize,
  maxSide = IMAGE_EXPORT_MAX_SIDE,
  maxPixels,
  pngUnavailable = null,
  sketches,
  initialSketchId = null,
  initialKind,
  initialShowGrid = true,
  units,
  onClose,
  onExportPng,
  onExportSvg
}: ImageExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  const viewWidth = Math.max(1, Math.round(viewSize.width));
  const viewHeight = Math.max(1, Math.round(viewSize.height));
  const presets: {
    id: SizePresetId;
    label: string;
    width: number;
    height: number;
  }[] = [
    { id: 'view', label: 'View', width: viewWidth, height: viewHeight },
    {
      id: 'view2x',
      label: '2× view',
      width: viewWidth * 2,
      height: viewHeight * 2
    },
    ...FIXED_SIZES
  ];

  const [kind, setKind] = useState<ImageExportKind>(
    initialKind ?? (pngUnavailable && sketches.length > 0 ? 'svg' : 'png')
  );
  const [width, setWidth] = useState(String(viewWidth));
  const [height, setHeight] = useState(String(viewHeight));
  const [transparent, setTransparent] = useState(false);
  const [showGrid, setShowGrid] = useState(initialShowGrid);
  const [sketchId, setSketchId] = useState(
    sketches.find((sketch) => sketch.sketchId === initialSketchId)?.sketchId ??
      sketches[0]?.sketchId ??
      ''
  );

  // Escape still closes when focus has fallen out of the dialog (a click on
  // the backdrop drops it on the body); the workspace keymap stands down.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
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

  const pixelWidth = Number(width);
  const pixelHeight = Number(height);
  const sizeProblem = imageSizeProblem(
    pixelWidth,
    pixelHeight,
    maxSide,
    maxPixels
  );
  const activePreset = presets.find(
    (preset) => preset.width === pixelWidth && preset.height === pixelHeight
  )?.id;
  const sketch = sketches.find((entry) => entry.sketchId === sketchId);
  const blocked =
    kind === 'png'
      ? pngUnavailable !== null || sizeProblem !== null
      : sketch === undefined;

  function runExport() {
    if (blocked) return;
    if (kind === 'png') {
      onExportPng({
        width: pixelWidth,
        height: pixelHeight,
        transparent,
        showGrid
      });
    } else {
      onExportSvg({ sketchId, transparent });
    }
    onClose();
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="image-export-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h2 id="image-export-title">
          <ImageDown size={16} aria-hidden="true" />
          Export image
        </h2>

        <fieldset className="export-dialog-group">
          <legend>Format</legend>
          <label className="export-dialog-option">
            <input
              type="radio"
              name="image-export-format"
              value="png"
              aria-label="PNG"
              aria-describedby="image-export-hint-png"
              checked={kind === 'png'}
              onChange={() => setKind('png')}
            />
            <span aria-hidden="true">PNG</span>
            <small id="image-export-hint-png">
              The current view, at any size
            </small>
          </label>
          <label className="export-dialog-option">
            <input
              type="radio"
              name="image-export-format"
              value="svg"
              aria-label="SVG"
              aria-describedby="image-export-hint-svg"
              checked={kind === 'svg'}
              disabled={sketches.length === 0}
              onChange={() => setKind('svg')}
            />
            <span aria-hidden="true">SVG</span>
            <small id="image-export-hint-svg">
              {sketches.length === 0
                ? 'Needs a sketch — this project has none'
                : 'One sketch, exact curves at 1:1'}
            </small>
          </label>
        </fieldset>

        {kind === 'png' ? (
          <>
            <p className="export-dialog-scope">
              Renders {viewScopeLabel} from the current camera, without gizmos
              or selection highlights.
            </p>
            <fieldset className="export-dialog-group">
              <legend>Size</legend>
              <div className="export-dialog-presets">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={
                      activePreset === preset.id ? 'active' : undefined
                    }
                    aria-pressed={activePreset === preset.id}
                    onClick={() => {
                      setWidth(String(preset.width));
                      setHeight(String(preset.height));
                    }}
                  >
                    {preset.label}
                    {preset.id.startsWith('view') ? (
                      <small>
                        {preset.width} × {preset.height}
                      </small>
                    ) : null}
                  </button>
                ))}
              </div>
              <label className="export-dialog-custom">
                <span>Width (px)</span>
                <input
                  type="number"
                  min={16}
                  max={maxSide}
                  step={1}
                  value={width}
                  onChange={(event) => setWidth(event.target.value)}
                />
              </label>
              <label className="export-dialog-custom">
                <span>Height (px)</span>
                <input
                  type="number"
                  min={16}
                  max={maxSide}
                  step={1}
                  value={height}
                  onChange={(event) => setHeight(event.target.value)}
                />
              </label>
              {sizeProblem ? (
                <p className="export-dialog-error" role="alert">
                  {sizeProblem}
                </p>
              ) : pixelWidth * viewHeight !== pixelHeight * viewWidth ? (
                <p className="export-dialog-hint">
                  A different shape from the view widens the frame; nothing on
                  screen is cropped.
                </p>
              ) : null}
            </fieldset>
            <label className="export-dialog-custom">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(event) => setShowGrid(event.target.checked)}
              />
              Include the grid and axes
            </label>
          </>
        ) : (
          <>
            <p className="export-dialog-scope">
              Draws the sketch&apos;s lines, arcs and circles exactly, at 1:1 in{' '}
              {UNIT_NAMES[units]}. Construction geometry is left out.
            </p>
            <label className="export-dialog-custom">
              <span>Sketch</span>
              <select
                value={sketchId}
                onChange={(event) => setSketchId(event.target.value)}
              >
                {sketches.map((entry) => (
                  <option key={entry.sketchId} value={entry.sketchId}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="export-dialog-custom">
          <input
            type="checkbox"
            checked={transparent}
            onChange={(event) => setTransparent(event.target.checked)}
          />
          Transparent background
        </label>

        <div className="export-dialog-status">
          {kind === 'png' && pngUnavailable ? (
            <p className="export-dialog-error" role="alert">
              {pngUnavailable}
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
            disabled={blocked}
            onClick={runExport}
          >
            <ImageDown size={13} aria-hidden="true" />
            Export {kind === 'png' ? 'PNG' : 'SVG'}
          </button>
        </div>
      </div>
    </div>
  );
}
