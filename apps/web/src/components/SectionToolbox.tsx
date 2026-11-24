import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react';
import {
  ArrowLeftRight,
  Crosshair,
  Download,
  SquareSplitVertical
} from 'lucide-react';
import type { SectionPlaneId, SectionViewSettings } from '@openzcad/viewport';
import {
  describeSectionOutline,
  sectionOutlineExportable,
  type SectionOutlineState
} from '../lib/sectionOutline';
import { Tooltip } from './Tooltip';
import { formatMeasuredQuantity } from '../lib/model';

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
  // The kernel's section with chords where curves belong: not the display
  // preview, and not exact.
  approximate: 'Approximate',
  refused: 'Preview'
} as const;

/** Slider ends: enough digits to place the cut, not a float's tail. */
function formatEnd(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * The cut position as the field shows it: twelve significant digits, so a
 * rescaled offset (12.7 mm converted to inches is 0.49999999999999994)
 * reads 0.5. Display only: the stored offset keeps its full precision.
 */
export function formatSectionOffset(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/**
 * The slider's step: the smallest round value (1, 2, 2.5 or 5 times a power
 * of ten) giving at most about 200 positions across the model. A step of
 * "any" moved the plane by 1% of the range, to cuts like 17.775 mm (I54).
 */
export function sectionSliderStep(range: { min: number; max: number }): number {
  const span = range.max - range.min;
  if (!(span > 0)) return 1;
  const target = span / 200;
  const power = 10 ** Math.floor(Math.log10(target));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * power >= target) return factor * power;
  }
  return 10 * power;
}

/** `value` on the step's grid, clamped to the range, without float tails. */
export function snapSectionOffset(
  value: number,
  range: { min: number; max: number },
  step = sectionSliderStep(range)
): number {
  const snapped = Number((Math.round(value / step) * step).toPrecision(12));
  return Math.min(range.max, Math.max(range.min, snapped));
}

/** Two bodies whose display caps overlap inside the cut, by name. */
export interface SectionOverlapNote {
  a: string;
  b: string;
  /** Overlap area in the cut, model units², from the display meshes. */
  area: number;
}

/**
 * M09 first slice, in words. Always says what it is: display evidence from
 * the meshes on screen, not an exact clash check.
 */
export function describeSectionOverlap(
  overlap: readonly SectionOverlapNote[],
  units: string
): string | null {
  if (overlap.length === 0) return null;
  const listed = overlap
    .slice(0, 3)
    .map(
      (pair) =>
        `${pair.a} and ${pair.b} (about ${formatMeasuredQuantity(pair.area)} ${units}²)`
    );
  const more = overlap.length > 3 ? `, and ${overlap.length - 3} more` : '';
  return `Overlap in this cut: ${listed.join('; ')}${more}. Display evidence from the meshes on screen, not an exact clash check.`;
}

interface SectionToolboxProps {
  section: SectionViewSettings;
  range: { min: number; max: number };
  outline: SectionOutlineState;
  /** M09: bodies overlapping inside the cut, from the display meshes. */
  overlap?: readonly SectionOverlapNote[];
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

/**
 * Where the stage's free space starts, in viewport pixels: the stage's top
 * plus its `--stage-top` clearance under the workspace toolbar. That custom
 * property holds unresolved CSS math (`calc(40px + 10px * 2)`), which
 * `parseFloat` reads as NaN, so the controls fell back to 8 px and opened
 * under the toolbar (#1629). A probe lets layout resolve the length.
 */
function stageTopEdge(panel: HTMLElement, stage: Element | null): number {
  const host = stage instanceof HTMLElement ? stage : panel.parentElement;
  if (!host) return 8;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;top:0;left:0;width:0;height:var(--stage-top, 8px);visibility:hidden;pointer-events:none';
  host.appendChild(probe);
  const clearance = probe.getBoundingClientRect().height;
  probe.remove();
  return (
    host.getBoundingClientRect().top +
    (Number.isFinite(clearance) && clearance > 0 ? clearance : 8)
  );
}

export function SectionToolbox({
  section,
  range,
  outline,
  overlap = [],
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
  const [draft, setDraft] = useState(formatSectionOffset(section.offset));
  const cancelEdit = useRef(false);
  // Set by typing in the field: a value typed back to what it shows is
  // still an edit, and is committed exactly.
  const edited = useRef(false);
  const pendingSliderOffset = useRef<number | null>(null);
  if (sourceOffset !== section.offset) {
    setSourceOffset(section.offset);
    setDraft(formatSectionOffset(section.offset));
  }
  const status = describeSectionOutline(outline, units);
  const overlapText = describeSectionOverlap(overlap, units);
  const exportable = active && sectionOutlineExportable(outline);
  const partial = active && outline.kind === 'exact' && outline.unsectioned > 0;
  const stateKind = !active ? 'off' : partial ? 'refused' : status.kind;
  const stateLabel = !active
    ? 'Off'
    : partial
      ? 'Partial'
      : STATUS_LABELS[status.kind];
  const span = range.max - range.min;
  // A drag or a key lands on this grid. The element's own step stays "any":
  // a stepped range input would also round a position typed in the field
  // (3.125) to the grid, and a typed cut is exact on purpose.
  const step = sectionSliderStep(range);
  const fill =
    span > 0
      ? Math.min(100, Math.max(0, ((section.offset - range.min) / span) * 100))
      : 50;

  // A pinned column can put the rail near the opposite edge on a phone.
  // Keep its toolbox on screen even when there is no room to its left.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame: number | null = null;
    function place() {
      if (!panel) return;
      panel.style.translate = '';
      panel.style.maxHeight = '';
      const stage = panel.closest('.viewer-area');
      const rail = panel.closest('.instrument-rail')?.getBoundingClientRect();
      const footer = stage
        ?.querySelector('.command-bar-lane')
        ?.getBoundingClientRect();
      const stageTop = stageTopEdge(panel, stage);
      const right = rail?.left ?? window.innerWidth;
      const bottom = footer?.top ?? window.innerHeight;
      // Below the toolbar and clear of the footer's guidance on a short
      // screen (844 × 390): the controls scroll rather than cover either.
      const room = Math.floor(bottom - 48 - stageTop);
      if (room > 0 && panel.getBoundingClientRect().height > room) {
        panel.style.maxHeight = `${room}px`;
      }
      const box = panel.getBoundingClientRect();
      const x = Math.max(8, Math.min(box.x, right - box.width - 8));
      // Beside its button the controls hang mid-stage. Where they would also
      // stand across the canvas's middle (a stage narrower than about three
      // of them), they lay over the cut they control (I6), so on a tablet or
      // laptop stage they hang from its top and the model is framed below.
      const canvas = stage
        ?.querySelector('.viewer-host canvas')
        ?.getBoundingClientRect();
      // Not on a phone, whose short stage and own rails place them already.
      const middle =
        canvas && canvas.width > 520 && canvas.height > 600
          ? canvas.left + canvas.width / 2
          : null;
      const across = middle !== null && x < middle && x + box.width > middle;
      const y = across
        ? stageTop
        : Math.max(stageTop, Math.min(box.y, bottom - box.height - 48));
      panel.style.translate = `${x - box.x}px ${y - box.y}px`;
    }
    function schedulePlacement() {
      place();
      // Resize callbacks can precede the parent's responsive positioning.
      // Measure again after that layout settles, without a permanent loop.
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        place();
      });
    }
    schedulePlacement();
    const observer = new ResizeObserver(schedulePlacement);
    observer.observe(panel);
    // Dock changes move the anchor without changing the toolbox's own size.
    const stage = panel.closest('.viewer-area');
    if (stage) observer.observe(stage);
    // Compact rails can reflow inside an unchanged stage on a short screen.
    for (const selector of ['.viewer-rail', '.instrument-rail']) {
      const anchor = panel.closest(selector);
      if (anchor) observer.observe(anchor);
    }
    const dockObserver = new MutationObserver(schedulePlacement);
    // Position and responsive CSS variables can change without resizing an
    // ancestor. Observe the anchor chain, excluding our own placement style.
    for (
      let anchor = panel.parentElement;
      anchor;
      anchor = anchor.parentElement
    ) {
      dockObserver.observe(anchor, {
        attributes: true,
        attributeFilter: ['style', 'class']
      });
      if (anchor.classList.contains('workspace')) break;
    }
    window.addEventListener('resize', schedulePlacement);
    window.addEventListener('scroll', schedulePlacement, true);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      dockObserver.disconnect();
      window.removeEventListener('resize', schedulePlacement);
      window.removeEventListener('scroll', schedulePlacement, true);
    };
  }, []);

  function commitPosition() {
    if (cancelEdit.current) {
      cancelEdit.current = false;
      edited.current = false;
      return;
    }
    // Left untouched, the field keeps the stored offset: committing its
    // rounded text would nudge the cut by the digits it does not show.
    if (!edited.current) return;
    edited.current = false;
    const parsed = draft.trim() === '' ? NaN : Number(draft);
    const next = Number.isFinite(parsed)
      ? Math.min(range.max, Math.max(range.min, parsed))
      : section.offset;
    setDraft(formatSectionOffset(next));
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
        <SquareSplitVertical
          size={14}
          className="rail-section-glyph"
          aria-hidden="true"
        />
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
              const center = snapSectionOffset(
                (range.min + range.max) / 2,
                range,
                step
              );
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
            onChange={(event) => {
              edited.current = true;
              setDraft(event.target.value);
            }}
            onBlur={commitPosition}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelEdit.current = true;
                setDraft(formatSectionOffset(section.offset));
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
            const offset = snapSectionOffset(
              Number(event.target.value),
              range,
              step
            );
            pendingSliderOffset.current = offset;
            onOffset(offset);
          }}
          onKeyDown={(event) => {
            const moves: Record<string, number> = {
              ArrowRight: step,
              ArrowUp: step,
              ArrowLeft: -step,
              ArrowDown: -step,
              PageUp: step * 10,
              PageDown: -step * 10
            };
            const ends: Record<string, number> = {
              Home: range.min,
              End: range.max
            };
            const move = moves[event.key];
            const end = ends[event.key];
            if (move === undefined && end === undefined) return;
            event.preventDefault();
            const offset =
              end ?? snapSectionOffset(section.offset + move!, range, step);
            if (offset === section.offset) return;
            pendingSliderOffset.current = offset;
            onOffset(offset);
          }}
          onPointerUp={commitSlider}
          onPointerCancel={commitSlider}
          onKeyUp={commitSlider}
          onBlur={commitSlider}
          aria-label="Section plane offset"
          aria-valuetext={`${formatSectionOffset(section.offset)} ${units}`}
        />
        <div className="rail-section-ends" aria-hidden="true">
          <span>{formatEnd(range.min)}</span>
          <span>{formatEnd(range.max)}</span>
        </div>
      </div>
      {active && overlapText ? (
        <p className="rail-section-overlap" role="note">
          <span className="rail-section-overlap-swatch" aria-hidden="true" />
          {overlapText}
        </p>
      ) : null}
      <div className="rail-section-footer">
        <p id={detailId} className="rail-section-state-detail">
          {active
            ? status.detail
            : 'The cut is off. Switch it on or pick a plane.'}
        </p>
        <Tooltip
          label="Export section"
          description={
            !exportable
              ? 'Needs an exact section of every body the plane cuts'
              : status.kind === 'exact'
                ? 'Writes the exact section curves as DXF'
                : 'Writes the section as DXF, curved edges as straight segments'
          }
        >
          <button
            type="button"
            className="rail-section-export"
            onClick={onExport}
            disabled={!exportable}
            aria-label="Export the section as DXF"
          >
            <Download size={14} aria-hidden="true" />
            DXF
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
