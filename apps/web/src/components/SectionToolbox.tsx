import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Crosshair, Download, Info, X } from 'lucide-react';
import type { SectionPlaneId, SectionViewSettings } from '@openzcad/viewport';
import {
  describeSectionOutline,
  sectionOutlineExportable,
  type SectionOutlineState
} from '../lib/sectionOutline';
import { Tooltip } from './Tooltip';

const PLANES = [
  { id: 'XY', name: 'Top' },
  { id: 'XZ', name: 'Front' },
  { id: 'YZ', name: 'Side' }
] as const;

const STATUS_LABELS = {
  clipping: 'Preview',
  computing: 'Computing…',
  exact: 'Exact',
  refused: 'Preview'
} as const;

interface SectionToolboxProps {
  section: SectionViewSettings;
  range: { min: number; max: number };
  outline: SectionOutlineState;
  units: string;
  onClose(): void;
  onPlane(plane: SectionPlaneId): void;
  onOffset(offset: number): void;
  onCommit(offset?: number): void;
  onFlip?(): void;
  onExport(): void;
}

/** Small live-view controls; putting them away never changes the cut. */
export function SectionToolbox({
  section,
  range,
  outline,
  units,
  onClose,
  onPlane,
  onOffset,
  onCommit,
  onFlip,
  onExport
}: SectionToolboxProps) {
  const positionId = useId();
  const detailId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sourceOffset, setSourceOffset] = useState(section.offset);
  const [draft, setDraft] = useState(String(section.offset));
  const cancelEdit = useRef(false);
  const pendingSliderOffset = useRef<number | null>(null);
  if (sourceOffset !== section.offset) {
    setSourceOffset(section.offset);
    setDraft(String(section.offset));
  }
  const status = describeSectionOutline(outline, units);
  const exportable = sectionOutlineExportable(outline);
  const partial = outline.kind === 'exact' && outline.unsectioned > 0;

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
      className="rail-section-panel"
      data-rail-flyout=""
      role="group"
      aria-label="Section view"
    >
      <div className="rail-section-heading">
        <strong>Section view</strong>
        <Tooltip
          label="Close section controls"
          description="The cut stays active"
        >
          <button
            type="button"
            className="rail-section-icon"
            onClick={onClose}
            aria-label="Close section controls"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div
        className="rail-section-planes"
        role="group"
        aria-label="Section plane"
      >
        {PLANES.map(({ id, name }) => (
          <button
            key={id}
            type="button"
            className="rail-section-plane"
            aria-label={`${name} (${id} plane)`}
            aria-pressed={section.plane === id}
            onClick={() => {
              if (section.plane !== id) onPlane(id);
            }}
          >
            <span>{name}</span>
            <small>{id}</small>
          </button>
        ))}
      </div>
      <div className="rail-section-position">
        <label htmlFor={positionId}>Cut position</label>
        <div className="rail-section-value">
          <input
            id={positionId}
            type="number"
            min={range.min}
            max={range.max}
            step="any"
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
      <input
        type="range"
        className="rail-section-slider"
        min={range.min}
        max={range.max}
        step="any"
        value={section.offset}
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
      <div className="rail-section-footer">
        <Tooltip
          label="Flip cut direction"
          description="Show the other side of the plane"
        >
          <button
            type="button"
            className="rail-section-action"
            onClick={onFlip}
            disabled={!onFlip}
            aria-label="Flip cut direction"
            aria-pressed={section.flipped === true}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
            Flip
          </button>
        </Tooltip>
        <Tooltip
          label="Center cut"
          description="Move the plane to the middle of the model"
        >
          <button
            type="button"
            className="rail-section-action"
            onClick={() => {
              const center = (range.min + range.max) / 2;
              onOffset(center);
              onCommit(center);
            }}
            aria-label="Center cut"
          >
            <Crosshair size={14} aria-hidden="true" />
            Center
          </button>
        </Tooltip>
        <span
          className={`rail-section-state is-${partial ? 'refused' : status.kind}`}
          role="status"
        >
          <span className="rail-section-state-kind">
            {partial ? 'Partial' : STATUS_LABELS[status.kind]}
          </span>
        </span>
        <button
          type="button"
          className="rail-section-icon"
          aria-label="Section details"
          aria-expanded={detailsOpen}
          aria-controls={detailId}
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <Info size={14} aria-hidden="true" />
        </button>
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
      <p
        id={detailId}
        className="rail-section-state-detail"
        hidden={!detailsOpen}
      >
        {status.detail}
      </p>
    </div>
  );
}
