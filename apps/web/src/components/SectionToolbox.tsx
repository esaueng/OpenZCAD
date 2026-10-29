import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react';
import { ArrowLeftRight, Crosshair, Download, Slice } from 'lucide-react';
import type { SectionPlaneId, SectionViewSettings } from '@openzcad/viewport';
import {
  describeSectionOutline,
  sectionOutlineExportable,
  type SectionOutlineState
} from '../lib/sectionOutline';
import { Tooltip } from './Tooltip';

/** Each plane's swatch takes the colour of the axis it cuts across. */
const PLANES = [
  { id: 'XY', name: 'Top', axis: 'z' },
  { id: 'XZ', name: 'Front', axis: 'y' },
  { id: 'YZ', name: 'Side', axis: 'x' }
] as const;

const STATUS_LABELS = {
  clipping: 'Preview',
  computing: 'Computing…',
  exact: 'Exact',
  refused: 'Preview'
} as const;

/** Slider ends: enough digits to place the cut, not a float's tail. */
function formatEnd(value: number): string {
  return String(Number(value.toFixed(2)));
}

interface SectionToolboxProps {
  section: SectionViewSettings;
  range: { min: number; max: number };
  outline: SectionOutlineState;
  units: string;
  /**
   * False once the header switch has ended the cut: the panel stays up on
   * the last cut, so the switch or a plane brings it straight back.
   */
  active?: boolean;
  /** Turns the cut off or back on; the rail button hides the controls. */
  onSwitch(): void;
  onPlane(plane: SectionPlaneId): void;
  onOffset(offset: number): void;
  onCommit(offset?: number): void;
  onFlip?(): void;
  onExport(): void;
}

/**
 * Small live-view controls. The header switch is the only thing in them that
 * ends the cut; the rail button and Escape put them away and leave it on.
 */
export function SectionToolbox({
  section,
  range,
  outline,
  units,
  active = true,
  onSwitch,
  onPlane,
  onOffset,
  onCommit,
  onFlip,
  onExport
}: SectionToolboxProps) {
  const headingId = useId();
  const positionId = useId();
  const detailId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [sourceOffset, setSourceOffset] = useState(section.offset);
  const [draft, setDraft] = useState(String(section.offset));
  const cancelEdit = useRef(false);
  const pendingSliderOffset = useRef<number | null>(null);
  if (sourceOffset !== section.offset) {
    setSourceOffset(section.offset);
    setDraft(String(section.offset));
  }
  const status = describeSectionOutline(outline, units);
  const exportable = active && sectionOutlineExportable(outline);
  const partial = active && outline.kind === 'exact' && outline.unsectioned > 0;
  const stateKind = !active ? 'off' : partial ? 'refused' : status.kind;
  const stateLabel = !active
    ? 'Off'
    : partial
      ? 'Partial'
      : STATUS_LABELS[status.kind];
  const span = range.max - range.min;
  const fill =
    span > 0
      ? Math.min(100, Math.max(0, ((section.offset - range.min) / span) * 100))
      : 50;

  // A pinned column can put the rail near the opposite edge on a phone.
  // Keep its toolbox on screen even when there is no room to its left.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function place() {
      if (!panel) return;
      panel.style.translate = '';
      const box = panel.getBoundingClientRect();
      const x = Math.max(8, Math.min(box.x, window.innerWidth - box.width - 8));
      const y = Math.max(
        8,
        Math.min(box.y, window.innerHeight - box.height - 8)
      );
      panel.style.translate = `${x - box.x}px ${y - box.y}px`;
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    // Dock changes move the anchor without changing the toolbox's own size.
    const stage = panel.closest('.viewer-area');
    if (stage) observer.observe(stage);
    const dockObserver = new MutationObserver(place);
    const workspace = panel.closest('.workspace');
    if (workspace) {
      dockObserver.observe(workspace, {
        attributes: true,
        attributeFilter: ['style']
      });
    }
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      dockObserver.disconnect();
      window.removeEventListener('resize', place);
    };
  }, []);

  function commitPosition() {
    if (cancelEdit.current) {
      cancelEdit.current = false;
      return;
    }
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(range.max, Math.max(range.min, parsed))
      : section.offset;
    setDraft(String(next));
    if (next !== section.offset) {
      onOffset(next);
      // Pass the committed value: React has not rendered the new offset yet.
      onCommit(next);
    }
  }

  function commitSlider() {
    const offset = pendingSliderOffset.current;
    if (offset === null) return;
    pendingSliderOffset.current = null;
    onCommit(offset);
  }

  return (
    <div
      ref={panelRef}
      className={`rail-section-panel${active ? '' : ' is-off'}`}
      data-rail-flyout=""
      role="group"
      aria-labelledby={headingId}
    >
      <div className="rail-section-heading">
        <Slice size={14} className="rail-section-glyph" aria-hidden="true" />
        <strong id={headingId}>Section view</strong>
        <span
          className={`rail-section-state is-${stateKind}`}
          role="status"
          aria-describedby={detailId}
        >
          <span className="rail-section-state-kind">{stateLabel}</span>
        </span>
        <Tooltip
          label={active ? 'Turn section view off' : 'Turn section view on'}
          description="The section button hides these controls"
        >
          <button
            type="button"
            role="switch"
            className="rail-section-switch"
            aria-checked={active}
            aria-label="Section cut"
            onClick={onSwitch}
          >
            <span aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div className="rail-section-planes-row">
        <div
          className="rail-section-planes"
          role="group"
          aria-label="Section plane"
        >
          {PLANES.map(({ id, name, axis }) => (
            <button
              key={id}
              type="button"
              className="rail-section-plane"
              data-axis={axis}
              aria-label={`${name} (${id} plane)`}
              aria-pressed={active && section.plane === id}
              onClick={() => {
                // Off, the last cut's plane switches that cut back on.
                if (section.plane !== id) onPlane(id);
                else if (!active) onSwitch();
              }}
            >
              <span className="rail-section-swatch" aria-hidden="true" />
              <span>{name}</span>
              <small>{id}</small>
            </button>
          ))}
        </div>
        <Tooltip
          label="Flip cut direction"
          description="Show the other side of the plane"
        >
          <button
            type="button"
            className="rail-section-flip"
            onClick={onFlip}
            disabled={!onFlip || !active}
            aria-label="Flip cut direction"
            aria-pressed={section.flipped === true}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div className="rail-section-position">
        <label htmlFor={positionId}>Cut position</label>
        <Tooltip
          label="Center cut"
          description="Move the plane to the middle of the model"
        >
          <button
            type="button"
            className="rail-section-icon"
            disabled={!active}
            onClick={() => {
              const center = (range.min + range.max) / 2;
              onOffset(center);
              onCommit(center);
            }}
            aria-label="Center cut"
          >
            <Crosshair size={14} aria-hidden="true" />
          </button>
        </Tooltip>
        <div className="rail-section-value">
          <input
            id={positionId}
            type="number"
            min={range.min}
            max={range.max}
            step="any"
            disabled={!active}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitPosition}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelEdit.current = true;
                setDraft(String(section.offset));
                event.currentTarget.blur();
              }
            }}
            aria-label="Cut position"
          />
          <span>{units}</span>
        </div>
      </div>
      <div className="rail-section-track">
        <input
          type="range"
          className="rail-section-slider"
          min={range.min}
          max={range.max}
          step="any"
          disabled={!active}
          value={section.offset}
          style={{ '--section-fill': `${fill}%` } as CSSProperties}
          onChange={(event) => {
            const offset = Number(event.target.value);
            pendingSliderOffset.current = offset;
            onOffset(offset);
          }}
          onPointerUp={commitSlider}
          onPointerCancel={commitSlider}
          onKeyUp={commitSlider}
          onBlur={commitSlider}
          aria-label="Section plane offset"
          aria-valuetext={`${section.offset} ${units}`}
        />
        <div className="rail-section-ends" aria-hidden="true">
          <span>{formatEnd(range.min)}</span>
          <span>{formatEnd(range.max)}</span>
        </div>
      </div>
      <div className="rail-section-footer">
        <p id={detailId} className="rail-section-state-detail">
          {active
            ? status.detail
            : 'The cut is off. Switch it on or pick a plane.'}
        </p>
        <Tooltip
          label="Export section"
          description={
            exportable
              ? 'Writes the exact section curves as DXF'
              : 'Needs an exact section of every body the plane cuts'
          }
        >
          <button
            type="button"
            className="rail-section-export"
            onClick={onExport}
            disabled={!exportable}
            aria-label="Export the exact section as DXF"
          >
            <Download size={14} aria-hidden="true" />
            DXF
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
