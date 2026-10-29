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
import {
  SavedViewsSection,
  type SavedViewsSectionProps
} from './SavedViewsSection';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  ProjectionMode,
  SectionPlaneId,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon, DisplayModeIcon } from './ViewerRailIcons';
import type { SectionOutlineState } from '../lib/sectionOutline';
import { SectionToolbox } from './SectionToolbox';
import { DISPLAY_MODE_LABELS } from '../lib/displayMode';
import { UNDO_FLOOR_TRIMMED_REASON } from '../lib/toasts';
import { Tooltip } from './Tooltip';
import { labelWithKey, useKeymap, type Keymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';

/**
 * Every standard view, in reading order down the flyout. Back, left and
 * bottom were previously reachable only by orbiting the cube; only the four
 * with a shortcut ever had a button of their own.
 */
const VIEWS: { id: StandardView; command?: string }[] = [
  { id: 'front', command: 'view-front' },
  { id: 'back', command: 'view-back' },
  { id: 'left', command: 'view-left' },
  { id: 'right', command: 'view-right' },
  { id: 'top', command: 'view-top' },
  { id: 'bottom', command: 'view-bottom' },
  { id: 'iso', command: 'view-iso' }
];

function viewTitle(
  view: { id: StandardView; command?: string },
  keymap: Keymap
): string {
  return labelWithKey(
    `${VIEW_LABELS[view.id]} view`,
    view.command && keymap.label(view.command)
  );
}

interface ViewerToolbarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  canUndo: boolean;
  /**
   * Undo is spent because older steps were dropped to keep the history within
   * its limits: the button's help says so instead of leaving a bare "Undo".
   */
  undoFloorTrimmed?: boolean;
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
  /** The project's saved views, listed under the standard view tiles. */
  savedViews?: SavedViewsSectionProps;
  onCycleDisplayMode(): void;
  onToggleProjection(): void;
  /** Switches the section view on (at the last plane used) or off. */
  onToggleSection(): void;
  /**
   * Whether the section controls show while the cut is on. Owned by the
   * workspace so hiding them survives this bar remounting (a workspace mode
   * or dock layout change); uncontrolled when omitted.
   */
  sectionPanelOpen?: boolean;
  onSectionPanelOpenChange?(open: boolean): void;
  /** Cuts on another plane; chosen inside the section panel. */
  onSectionPlane(plane: SectionPlaneId): void;
  onSectionOffset(offset: number): void;
  /** The section plane came to rest; the exact section can be computed. */
  onSectionCommit(offset?: number): void;
  onSectionFlip?(): void;
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

const SECTION_PLANE_LABELS: Record<SectionPlaneId, string> = {
  XY: 'XY plane',
  XZ: 'XZ plane',
  YZ: 'YZ plane'
};

/** Cased like the display modes the rail's other "Now:" lines name. */
const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: 'Perspective',
  orthographic: 'Orthographic'
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
  undoFloorTrimmed = false,
  canRedo,
  sectionRange,
  onUndo,
  onRedo,
  onToggleGrid,
  onFit,
  measuring = false,
  onMeasure,
  onView,
  savedViews,
  onCycleDisplayMode,
  onToggleProjection,
  onToggleSection,
  sectionPanelOpen: sectionPanelOpenProp,
  onSectionPanelOpenChange,
  onSectionPlane,
  onSectionOffset,
  onSectionCommit,
  onSectionFlip,
  onExportSectionDxf,
  sectionOutline,
  units
}: ViewerToolbarProps) {
  const keymap = useKeymap();
  const [viewsOpen, setViewsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sectionAnchorRef = useRef<HTMLDivElement | null>(null);
  const sectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The cut and its panel are two things: the cut stays on while the panel
  // is hidden (the section button or Escape), so a look from a standard view
  // can still be a sectioned one. Hiding is remembered by the workspace,
  // which opens the panel again whenever the cut is switched on. The panel's
  // switch ends the cut and leaves the panel up, showing the last cut so the
  // switch or a plane brings it straight back. The views flyout only covers
  // the panel (one rail popover at a time) until the section button brings
  // it back, and covering it is not remembered.
  const sectionOn = settings.sectionView !== undefined;
  const [localSectionPanelOpen, setLocalSectionPanelOpen] = useState(true);
  const sectionPanelOpen = sectionPanelOpenProp ?? localSectionPanelOpen;
  const setSectionPanelOpen =
    onSectionPanelOpenChange ?? setLocalSectionPanelOpen;
  const [sectionCovered, setSectionCovered] = useState(false);
  // Held up by the panel's own switch: switched off anywhere else (the
  // palette, a reload), the cut takes its panel with it.
  const [heldOff, setHeldOff] = useState(false);
  const [lastCut, setLastCut] = useState(
    settings.sectionView && sectionRange
      ? { section: settings.sectionView, range: sectionRange }
      : null
  );
  if (
    settings.sectionView &&
    sectionRange &&
    (lastCut?.section !== settings.sectionView ||
      lastCut.range.min !== sectionRange.min ||
      lastCut.range.max !== sectionRange.max)
  ) {
    setLastCut({ section: settings.sectionView, range: sectionRange });
  }
  const [sectionWasOn, setSectionWasOn] = useState(sectionOn);
  if (sectionWasOn !== sectionOn) {
    setSectionWasOn(sectionOn);
    if (sectionOn) {
      setViewsOpen(false);
      setSectionCovered(false);
      setHeldOff(false);
      if (sectionPanelOpenProp === undefined) setLocalSectionPanelOpen(true);
    }
  }
  const sectionPanelShown =
    !sectionCovered && (sectionOn ? sectionPanelOpen : heldOff);
  const panelId = useId();
  // X-ray rides over the display mode, so the mode button says when it is
  // on. It has no rail button of its own: the rail is sized to centre on the
  // stage (and to fit beside the cube) down to a phone's height, and another
  // 38px lifted it off centre there. Shift+X, the command bar and the view
  // menu reach it, and View mode's bar has room for its button.
  const displayModeLabel = `${DISPLAY_MODE_LABELS[settings.displayMode]}${
    settings.xray ? ' · X-ray' : ''
  }`;
  const xrayKey = keymap.label('view-xray');
  const sectionLabel = settings.sectionView
    ? SECTION_PLANE_LABELS[settings.sectionView.plane]
    : 'Off';
  const projectionLabel = PROJECTION_LABELS[projection];
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
      if (sectionOn) setSectionPanelOpen(false);
      setHeldOff(false);
      sectionTriggerRef.current?.focus();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sectionPanelShown, sectionOn, setSectionPanelOpen]);

  function selectView(view: StandardView) {
    onView(view);
    setViewsOpen(false);
    // The chosen tile unmounts with the panel; the keyboard returns to the
    // control that opened it, as it does on Escape, rather than to <body>.
    triggerRef.current?.focus();
  }

  function toggleViews() {
    const next = !viewsOpen;
    setViewsOpen(next);
    if (next) {
      setSectionCovered(true);
    }
  }

  /**
   * Switches the cut on with its panel; after that the button shows and
   * hides the panel, like the views flyout's, and never ends the cut. The
   * panel's own switch is what turns it off, so putting the controls away is
   * always safe.
   */
  function pressSection(button: HTMLButtonElement) {
    // Safari does not focus a clicked button; Escape reads the focus.
    button.focus();
    if (sectionPanelShown) {
      if (sectionOn) setSectionPanelOpen(false);
      setHeldOff(false);
      return;
    }
    if (!sectionOn) {
      onToggleSection();
      return;
    }
    setSectionPanelOpen(true);
    setSectionCovered(false);
    setViewsOpen(false);
  }

  return (
    // The viewer bar: undo/redo and the viewport toggles. Still `.viewer-rail`
    // in the stylesheets; the name is what people call it.
    <div className="viewer-rail" role="toolbar" aria-label="Viewer bar">
      <Tooltip
        label="Undo"
        shortcut={keymap.label('edit-undo')}
        {...(!canUndo && undoFloorTrimmed
          ? { description: UNDO_FLOOR_TRIMMED_REASON }
          : {})}
      >
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
      <Tooltip label="Redo" shortcut={keymap.label('edit-redo')}>
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
        shortcut={keymap.label('view-fit')}
        description="Double-click the viewport to fit"
      >
        <button
          type="button"
          className="rail-button"
          onClick={onFit}
          aria-label={labelWithKey('Fit view', keymap.label('view-fit'))}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Toggle grid" shortcut={keymap.label('view-grid')}>
        <button
          type="button"
          className={`rail-button ${settings.showGrid ? 'active' : ''}`}
          onClick={onToggleGrid}
          aria-label={labelWithKey('Toggle grid', keymap.label('view-grid'))}
          aria-pressed={settings.showGrid}
        >
          <Grid3x3 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip
        label="Projection"
        shortcut={keymap.label('view-projection')}
        description={`Now: ${projectionLabel}`}
      >
        <button
          type="button"
          className={`rail-button ${projection === 'orthographic' ? 'active' : ''}`}
          onClick={onToggleProjection}
          aria-label={`${labelWithKey('Orthographic projection', keymap.label('view-projection'))} — now: ${projectionLabel}`}
          aria-pressed={projection === 'orthographic'}
        >
          <Camera size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="rail-views-anchor" ref={sectionAnchorRef}>
        <Tooltip
          label="Section view"
          // Short enough to show whole: the state is the part that matters,
          // and the 320px tooltip cut the old sentence off before it.
          description={`Now: ${sectionLabel} · ${
            !sectionOn
              ? 'cuts the display only'
              : sectionPanelShown
                ? 'click to hide controls'
                : 'click for controls'
          }`}
        >
          <button
            type="button"
            ref={sectionTriggerRef}
            className={`rail-button ${settings.sectionView ? 'active' : ''} ${
              sectionPanelShown ? 'open' : ''
            }`}
            onClick={(event) => pressSection(event.currentTarget)}
            aria-label={`Section view — now: ${sectionLabel}`}
            aria-pressed={sectionOn}
            aria-expanded={sectionPanelShown}
          >
            <Slice size={16} aria-hidden="true" />
          </button>
        </Tooltip>
        {sectionPanelShown && lastCut && (
          <SectionToolbox
            key={lastCut.section.plane}
            section={lastCut.section}
            range={lastCut.range}
            active={sectionOn}
            outline={sectionOutline}
            units={units}
            onSwitch={() => {
              if (sectionOn) setHeldOff(true);
              onToggleSection();
            }}
            onPlane={onSectionPlane}
            onOffset={onSectionOffset}
            onCommit={onSectionCommit}
            onFlip={onSectionFlip}
            onExport={onExportSectionDxf}
          />
        )}
      </div>
      <Tooltip
        label="Display mode"
        shortcut={keymap.label('view-display')}
        description={`Now: ${displayModeLabel}${
          xrayKey ? ` · ${platformShortcutLabel(xrayKey)} for X-ray` : ''
        }`}
      >
        <button
          type="button"
          className="rail-button"
          onClick={onCycleDisplayMode}
          aria-label={`${labelWithKey('Display mode', keymap.label('view-display'))} — now: ${displayModeLabel}`}
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
            {/* The key is on the tile itself: a tooltip below each tile
                covered the next one and, for the views without a key, only
                repeated its name. */}
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                className={view.id === 'iso' ? 'rail-view-wide' : undefined}
                onClick={() => selectView(view.id)}
                // The visible text is just the view name; the accessible
                // name keeps the "<View> view (n)" wording used elsewhere.
                aria-label={viewTitle(view, keymap)}
              >
                {VIEW_LABELS[view.id]}
                {view.command && keymap.label(view.command) ? (
                  <kbd aria-hidden="true">
                    {platformShortcutLabel(keymap.label(view.command)!)}
                  </kbd>
                ) : null}
              </button>
            ))}
            {savedViews && (
              <SavedViewsSection
                {...savedViews}
                onApply={(viewId) => {
                  savedViews.onApply(viewId);
                  setViewsOpen(false);
                  triggerRef.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
