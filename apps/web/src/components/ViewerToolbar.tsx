import { useEffect, useId, useRef, useState } from 'react';
import {
  Camera,
  Grid3x3,
  Maximize2,
  Redo2,
  Ruler,
  Slice,
  Undo2
} from 'lucide-react';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  ProjectionMode,
  SectionPlaneId,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon, DisplayModeIcon } from './ViewerRailIcons';
import {
  describeSectionOutline,
  sectionOutlineExportable,
  type SectionOutlineState
} from '../lib/sectionOutline';
import { DISPLAY_MODE_LABELS } from '../lib/displayMode';
import { Tooltip } from './Tooltip';

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
  /** Measure is switched on: the rail's ruler reads pressed. */
  measuring?: boolean;
  /**
   * Switches Measure on or off — the same workbench View mode's rail opens.
   * Absent, no ruler is drawn.
   */
  onMeasure?(next: boolean): void;
  onView(view: StandardView): void;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
  /** Switches the section view on (at the last plane used) or off. */
  onToggleSection(): void;
  /** Cuts on another plane; chosen inside the section panel. */
  onSectionPlane(plane: SectionPlaneId): void;
  onSectionOffset(offset: number): void;
  /** The section plane came to rest; the exact section can be computed. */
  onSectionCommit(): void;
  /** Writes the exact section as a DXF drawing. */
  onExportSectionDxf(): void;
  /**
   * What the viewport is showing for the active cut, which is two different
   * things: the clipped preview that keeps up with a drag, and the kernel's
   * exact section, which is the geometry the DXF export writes. The user is
   * told which one is on screen, because only one of them is a drawing.
   */
  sectionOutline: SectionOutlineState;
  /** Document units, for the cut area this reports. */
  units: string;
}

const SECTION_OUTLINE_LABELS: Record<SectionOutlineState['kind'], string> = {
  clipping: 'Clipping preview',
  computing: 'Computing section…',
  exact: 'Exact section',
  refused: 'No exact section'
};

const SECTION_PLANE_LABELS: Record<SectionPlaneId, string> = {
  XY: 'XY plane',
  XZ: 'XZ plane',
  YZ: 'YZ plane'
};

const SECTION_PLANES: readonly SectionPlaneId[] = ['XY', 'XZ', 'YZ'];

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
  measuring = false,
  onMeasure,
  onView,
  onCycleDisplayMode,
  onToggleProjection,
  onToggleSection,
  onSectionPlane,
  onSectionOffset,
  onSectionCommit,
  onExportSectionDxf,
  sectionOutline,
  units
}: ViewerToolbarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sectionAnchorRef = useRef<HTMLDivElement | null>(null);
  const sectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The cut and its panel are two things: the cut stays on while the panel
  // is put away (Escape, or the views flyout taking its place), so a look
  // from a standard view can still be a sectioned one. The panel opens
  // whenever the cut is switched on, from the rail or the palette alike.
  const sectionOn = settings.sectionView !== undefined;
  const [sectionPanelOpen, setSectionPanelOpen] = useState(sectionOn);
  const [sectionWasOn, setSectionWasOn] = useState(sectionOn);
  if (sectionWasOn !== sectionOn) {
    setSectionWasOn(sectionOn);
    setSectionPanelOpen(sectionOn);
    // One rail popover at a time: they open into the same space.
    if (sectionOn) {
      setViewsOpen(false);
    }
  }
  const sectionPanelShown = sectionPanelOpen && sectionOn;
  const panelId = useId();
  const displayModeLabel = DISPLAY_MODE_LABELS[settings.displayMode];
  const sectionLabel = settings.sectionView
    ? SECTION_PLANE_LABELS[settings.sectionView.plane]
    : 'off';
  const sectionStatus = describeSectionOutline(sectionOutline, units);
  // Live only when the export can actually write every body the plane cuts.
  // An exact section beside a body the kernel refused is still on screen and
  // still worth showing — it just is not a drawing.
  const canExportSection = sectionOutlineExportable(sectionOutline);

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

  // Escape puts the section panel away while it is what the user is working
  // in — the keyboard is on its button, plane choice or slider, or the last
  // press landed there and nothing else has taken the focus since — and
  // hands focus back to the button. Anywhere else Escape keeps its workspace
  // meaning (cancel the command, clear the pick): the panel stays up for as
  // long as the cut is on, and claiming every Escape would cost a press each
  // time. The press is tracked as well as the focus because Safari does not
  // focus a clicked button.
  const sectionEngagedRef = useRef(false);
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      sectionEngagedRef.current = Boolean(
        sectionAnchorRef.current?.contains(event.target as Node)
      );
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);
  useEffect(() => {
    if (!sectionPanelShown) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      const focused = document.activeElement;
      const inPanel = Boolean(sectionAnchorRef.current?.contains(focused));
      const unfocused = !focused || focused === document.body;
      if (!inPanel && !(sectionEngagedRef.current && unfocused)) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      setSectionPanelOpen(false);
      sectionTriggerRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sectionPanelShown]);

  function selectView(view: StandardView) {
    onView(view);
    setViewsOpen(false);
  }

  function toggleViews() {
    const next = !viewsOpen;
    setViewsOpen(next);
    if (next) {
      setSectionPanelOpen(false);
    }
  }

  /**
   * On and off, one click each. A cut whose panel was put away comes back
   * to the panel first, so its plane and slider are never out of reach.
   */
  function pressSection(button: HTMLButtonElement) {
    // Safari does not focus a clicked button; Escape reads the focus.
    button.focus();
    if (sectionOn && !sectionPanelOpen) {
      setSectionPanelOpen(true);
      setViewsOpen(false);
      return;
    }
    onToggleSection();
  }

  return (
    // The viewer bar: undo/redo and the viewport toggles. Still `.viewer-rail`
    // in the stylesheets; the name is what people call it.
    <div className="viewer-rail" role="toolbar" aria-label="Viewer bar">
      <Tooltip label="Undo" shortcut="Ctrl+Z">
        <button
          type="button"
          className="rail-button"
          onClick={onUndo}
          aria-label="Undo"
          disabled={!canUndo}
        >
          <Undo2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Redo" shortcut="Ctrl+Shift+Z">
        <button
          type="button"
          className="rail-button"
          onClick={onRedo}
          aria-label="Redo"
          disabled={!canRedo}
        >
          <Redo2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <span className="rail-divider" aria-hidden="true" />
      {onMeasure && (
        // First of the viewport group, as on View mode's rail: a reading
        // tool, so it stands with the instruments rather than among the
        // modeling verbs on the left.
        <Tooltip
          label="Measure"
          description="Inspect geometry, distance, and angle"
        >
          <button
            type="button"
            className={`rail-button ${measuring ? 'active' : ''}`}
            onClick={() => onMeasure(!measuring)}
            aria-label="Measure"
            aria-pressed={measuring}
          >
            <Ruler size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <Tooltip
        label="Fit view"
        shortcut="F"
        description="Double-click the viewport to fit"
      >
        <button
          type="button"
          className="rail-button"
          onClick={onFit}
          aria-label="Fit view (F)"
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Toggle grid" shortcut="G">
        <button
          type="button"
          className={`rail-button ${settings.showGrid ? 'active' : ''}`}
          onClick={onToggleGrid}
          aria-label="Toggle grid (G)"
          aria-pressed={settings.showGrid}
        >
          <Grid3x3 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Projection"
        shortcut="P"
        description={`Now: ${projection}`}
      >
        <button
          type="button"
          className={`rail-button ${projection === 'orthographic' ? 'active' : ''}`}
          onClick={onToggleProjection}
          aria-label={`Orthographic projection (P) — now: ${projection}`}
          aria-pressed={projection === 'orthographic'}
        >
          <Camera size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="rail-views-anchor" ref={sectionAnchorRef}>
        <Tooltip
          label="Section view"
          description={`Cuts the display only; the model is untouched. Now: ${sectionLabel}. Choose the plane in its panel.`}
        >
          <button
            type="button"
            ref={sectionTriggerRef}
            className={`rail-button ${settings.sectionView ? 'active' : ''}`}
            onClick={(event) => pressSection(event.currentTarget)}
            aria-label={`Section view — now: ${sectionLabel}`}
            aria-pressed={sectionOn}
          >
            <Slice size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {settings.sectionView && sectionRange && sectionPanelShown && (
          <div
            className="rail-section-panel"
            data-rail-flyout=""
            role="group"
            aria-label="Section plane offset"
          >
            <div
              className="rail-section-planes"
              role="group"
              aria-label="Section plane"
            >
              {SECTION_PLANES.map((plane) => {
                const current = settings.sectionView?.plane === plane;
                return (
                  <button
                    key={plane}
                    type="button"
                    className="rail-section-plane"
                    aria-label={SECTION_PLANE_LABELS[plane]}
                    aria-pressed={current}
                    onClick={() => {
                      if (!current) {
                        onSectionPlane(plane);
                      }
                    }}
                  >
                    {plane}
                  </button>
                );
              })}
            </div>
            <input
              type="range"
              className="rail-section-slider"
              min={sectionRange.min}
              max={sectionRange.max}
              step={(sectionRange.max - sectionRange.min) / 200 || 0.1}
              value={settings.sectionView.offset}
              onChange={(event) => onSectionOffset(Number(event.target.value))}
              // The drag itself stays on the clipped preview; the exact
              // section is computed once the plane comes to rest.
              onPointerUp={onSectionCommit}
              onKeyUp={onSectionCommit}
              aria-label="Section plane offset"
            />
            <p
              className={`rail-section-state is-${sectionStatus.kind}`}
              role="status"
            >
              <span className="rail-section-state-kind">
                {SECTION_OUTLINE_LABELS[sectionStatus.kind]}
              </span>
              <span className="rail-section-state-detail">
                {sectionStatus.detail}
              </span>
            </p>
            <Tooltip
              label="Export section"
              description={
                canExportSection
                  ? 'Writes the exact section curves as DXF'
                  : 'Needs an exact section of every body the plane cuts'
              }
            >
              <button
                type="button"
                className="rail-section-export"
                onClick={onExportSectionDxf}
                disabled={!canExportSection}
                aria-label="Export the exact section as DXF"
              >
                DXF
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      <Tooltip
        label="Display mode"
        shortcut="W"
        description={`Now: ${displayModeLabel}`}
      >
        <button
          type="button"
          className="rail-button"
          onClick={onCycleDisplayMode}
          aria-label={`Display mode (W) — now: ${displayModeLabel}`}
        >
          <DisplayModeIcon mode={settings.displayMode} />
        </button>
      </Tooltip>
      <span className="rail-divider" aria-hidden="true" />
      <div className="rail-views-anchor" ref={anchorRef}>
        <Tooltip label="Standard views">
          <button
            type="button"
            ref={triggerRef}
            className={`rail-button ${viewsOpen ? 'open' : ''}`}
            onClick={toggleViews}
            aria-label="Standard views"
            aria-haspopup="true"
            aria-expanded={viewsOpen}
            aria-controls={viewsOpen ? panelId : undefined}
          >
            <AxisTriadIcon />
          </button>
        </Tooltip>
        {viewsOpen && (
          <div
            className="rail-views-panel"
            data-rail-flyout=""
            id={panelId}
            role="group"
            aria-label="Standard views"
          >
            {VIEWS.map((view) => (
              <Tooltip
                key={view.id}
                label={`${VIEW_LABELS[view.id]} view`}
                shortcut={view.shortcut}
              >
                <button
                  type="button"
                  className={view.id === 'iso' ? 'rail-view-wide' : undefined}
                  onClick={() => selectView(view.id)}
                  // The visible text is just the view name; the accessible
                  // name keeps the "<View> view (n)" wording used elsewhere.
                  aria-label={viewTitle(view)}
                >
                  {VIEW_LABELS[view.id]}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
