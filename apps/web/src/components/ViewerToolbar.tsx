import { useEffect, useId, useRef, useState } from 'react';
import { Camera, Grid3x3, Maximize2, Redo2, Slice, Undo2 } from 'lucide-react';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  ProjectionMode,
  SectionPlaneId,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon, DisplayModeIcon } from './ViewerRailIcons';
import { DISPLAY_MODE_LABELS } from '../lib/displayMode';

/**
 * Every standard view, in reading order down the flyout. Back, left and
 * bottom were previously reachable only by orbiting the cube; only the four
 * with a shortcut ever had a button of their own.
 */
const VIEWS: { id: StandardView; shortcut?: string }[] = [
  { id: 'front', shortcut: '1' },
  { id: 'back' },
  { id: 'left' },
  { id: 'right', shortcut: '3' },
  { id: 'top', shortcut: '2' },
  { id: 'bottom' },
  { id: 'iso', shortcut: '4' }
];

function viewTitle(view: { id: StandardView; shortcut?: string }): string {
  const label = `${VIEW_LABELS[view.id]} view`;
  return view.shortcut ? `${label} (${view.shortcut})` : label;
}

interface ViewerToolbarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  canUndo: boolean;
  canRedo: boolean;
  /** Slider bounds for the active section plane's axis; null with no bodies. */
  sectionRange: { min: number; max: number } | null;
  onUndo(): void;
  onRedo(): void;
  onToggleGrid(): void;
  onFit(): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
  /** Advances the section view: off → XY → XZ → YZ → off. */
  onCycleSection(): void;
  onSectionOffset(offset: number): void;
}

const SECTION_PLANE_LABELS: Record<SectionPlaneId, string> = {
  XY: 'XY plane',
  XZ: 'XZ plane',
  YZ: 'YZ plane'
};

/**
 * Right-hand utility rail, centred against the viewport edge: fit, grid,
 * projection, and display mode as icons, with the standard views behind a
 * flyout. Navigation stays with the orientation cube above — the rail keeps
 * viewport state — so the two no longer duplicate each other, and the icons
 * carry their own state rather than needing a label beside each row.
 */
export function ViewerToolbar({
  settings,
  projection,
  canUndo,
  canRedo,
  sectionRange,
  onUndo,
  onRedo,
  onToggleGrid,
  onFit,
  onView,
  onCycleDisplayMode,
  onToggleProjection,
  onCycleSection,
  onSectionOffset
}: ViewerToolbarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const displayModeLabel = DISPLAY_MODE_LABELS[settings.displayMode];
  const sectionLabel = settings.sectionView
    ? SECTION_PLANE_LABELS[settings.sectionView.plane]
    : 'off';

  // Close on an outside pointer or Escape; Escape hands focus back to the
  // control that opened the flyout, so the rail stays keyboard-navigable.
  useEffect(() => {
    if (!viewsOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (!anchorRef.current?.contains(event.target as Node)) {
        setViewsOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setViewsOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [viewsOpen]);

  function selectView(view: StandardView) {
    onView(view);
    setViewsOpen(false);
  }

  return (
    <div className="viewer-rail" role="toolbar" aria-label="Quick actions">
      <button
        type="button"
        className="rail-button"
        onClick={onUndo}
        title="Undo (Ctrl+Z)"
        aria-label="Undo"
        disabled={!canUndo}
      >
        <Undo2 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rail-button"
        onClick={onRedo}
        title="Redo (Ctrl+Shift+Z)"
        aria-label="Redo"
        disabled={!canRedo}
      >
        <Redo2 size={15} aria-hidden="true" />
      </button>
      <span className="rail-divider" aria-hidden="true" />
      <button
        type="button"
        className="rail-button"
        onClick={onFit}
        title="Fit view (F) — double-click the viewport also fits"
        aria-label="Fit view (F)"
      >
        <Maximize2 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`rail-button ${settings.showGrid ? 'active' : ''}`}
        onClick={onToggleGrid}
        title="Toggle grid (G)"
        aria-label="Toggle grid (G)"
        aria-pressed={settings.showGrid}
      >
        <Grid3x3 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`rail-button ${projection === 'orthographic' ? 'active' : ''}`}
        onClick={onToggleProjection}
        title={`Projection (P) — now: ${projection}`}
        aria-label={`Orthographic projection (P) — now: ${projection}`}
        aria-pressed={projection === 'orthographic'}
      >
        <Camera size={15} aria-hidden="true" />
      </button>
      <div className="rail-views-anchor">
        <button
          type="button"
          className={`rail-button ${settings.sectionView ? 'active' : ''}`}
          onClick={onCycleSection}
          title={`Section view — now: ${sectionLabel}`}
          aria-label={`Section view — now: ${sectionLabel}`}
          aria-pressed={settings.sectionView !== undefined}
        >
          <Slice size={15} aria-hidden="true" />
        </button>
        {settings.sectionView && sectionRange && (
          <div
            className="rail-section-panel"
            role="group"
            aria-label="Section plane offset"
          >
            <input
              type="range"
              className="rail-section-slider"
              min={sectionRange.min}
              max={sectionRange.max}
              step={(sectionRange.max - sectionRange.min) / 200 || 0.1}
              value={settings.sectionView.offset}
              onChange={(event) => onSectionOffset(Number(event.target.value))}
              aria-label="Section plane offset"
            />
          </div>
        )}
      </div>
      <button
        type="button"
        className="rail-button"
        onClick={onCycleDisplayMode}
        title={`Display mode (W) — now: ${displayModeLabel}`}
        aria-label={`Display mode (W) — now: ${displayModeLabel}`}
      >
        <DisplayModeIcon mode={settings.displayMode} />
      </button>
      <span className="rail-divider" aria-hidden="true" />
      <div className="rail-views-anchor" ref={anchorRef}>
        <button
          type="button"
          ref={triggerRef}
          className={`rail-button ${viewsOpen ? 'open' : ''}`}
          onClick={() => setViewsOpen((open) => !open)}
          title="Standard views"
          aria-label="Standard views"
          aria-haspopup="true"
          aria-expanded={viewsOpen}
          aria-controls={viewsOpen ? panelId : undefined}
        >
          <AxisTriadIcon />
        </button>
        {viewsOpen && (
          <div
            className="rail-views-panel"
            id={panelId}
            role="group"
            aria-label="Standard views"
          >
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                className={view.id === 'iso' ? 'rail-view-wide' : undefined}
                onClick={() => selectView(view.id)}
                title={viewTitle(view)}
                // The visible text is just the view name; the accessible name
                // keeps the "<View> view (n)" wording used everywhere else.
                aria-label={viewTitle(view)}
              >
                {VIEW_LABELS[view.id]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
