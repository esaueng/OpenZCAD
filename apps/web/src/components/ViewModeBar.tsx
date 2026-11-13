import { useEffect, useId, useRef, useState } from 'react';
import {
  Camera,
  Grid3x3,
  Maximize2,
  Orbit,
  Ruler,
  SquareSplitVertical
} from 'lucide-react';
import {
  SavedViewsSection,
  type SavedViewsSectionProps
} from './SavedViewsSection';
import { VIEW_LABELS } from '@openzcad/viewport';
import type {
  DisplayMode,
  ProjectionMode,
  StandardView,
  ViewerSettings
} from '@openzcad/viewport';
import { AxisTriadIcon } from './ViewerRailIcons';
import { DisplayModeMenu, isWorkspaceShortcutKey } from './DisplayModeMenu';
import { SECTION_PLANE_LABELS } from '../lib/sectionPlaneLabels';
import { Tooltip } from './Tooltip';
import { labelWithKey, useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';

const VIEWS: { id: StandardView; command?: string }[] = [
  { id: 'front', command: 'view-front' },
  { id: 'back', command: 'view-back' },
  { id: 'left', command: 'view-left' },
  { id: 'right', command: 'view-right' },
  { id: 'top', command: 'view-top' },
  { id: 'bottom', command: 'view-bottom' },
  { id: 'iso', command: 'view-iso' }
];

const ORBIT_MODE_LABELS = {
  free: 'Free',
  turntable: 'Turntable'
} as const;

/** What each orbit mode does, for the button's help. */
const ORBIT_MODE_DETAILS = {
  free: 'tumbles over the top and bottom',
  turntable: 'Z stays up, stops at the top and bottom'
} as const;

/** Cased like the display modes the bar's other "Now:" lines name. */
const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: 'Perspective',
  orthographic: 'Orthographic'
};

interface ViewModeBarProps {
  settings: ViewerSettings;
  projection: ProjectionMode;
  /** True while the View-only measurement workbench owns measurement picks. */
  measuring: boolean;
  onMeasure(measuring: boolean): void;
  onFit(): void;
  onToggleGrid(): void;
  onView(view: StandardView): void;
  /** The project's saved views, listed under the standard view tiles. */
  savedViews?: SavedViewsSectionProps;
  /** Shows the model in a display mode, from the Display menu. */
  onDisplayMode(mode: DisplayMode): void;
  /** Turns X-ray on or off (Shift+X), from the Display menu. */
  onToggleXray(): void;
  onToggleProjection(): void;
  /**
   * Flips orbiting between Free and Turntable, the account preference
   * `settings.orbitMode` reports. Absent, no orbit button is drawn.
   */
  onToggleOrbitMode?(): void;
  /**
   * Turns the section cut on or off. Its plane and offset are Build's to
   * set; here the cut's chip names it. Absent, no Section button is drawn.
   */
  onToggleSection?(): void;
  /** No body on screen to cut; Section is greyed. */
  nothingToSection?: boolean;
}

/**
 * View mode's one piece of chrome: a bar of viewport controls floated at the
 * bottom of the viewport, where the modeling tool palette would otherwise be.
 *
 * It carries what someone reading a model needs — measure, fit, grid,
 * projection, orbit mode, section, display (with X-ray), standard views: the
 * order Build's viewer bar keeps, so a control stands in the same place in
 * every mode (I52) — and nothing that writes to the document. Build mode
 * keeps its own right-hand `ViewerToolbar`; the two never render together.
 */
export function ViewModeBar({
  settings,
  projection,
  measuring,
  onMeasure,
  onFit,
  onToggleGrid,
  onView,
  savedViews,
  onDisplayMode,
  onToggleXray,
  onToggleProjection,
  onToggleOrbitMode,
  onToggleSection,
  nothingToSection = false
}: ViewModeBarProps) {
  const keymap = useKeymap();
  const [viewsOpen, setViewsOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const sectionOn = Boolean(settings.sectionView);
  const sectionLabel = settings.sectionView
    ? SECTION_PLANE_LABELS[settings.sectionView.plane]
    : 'Off';
  const projectionLabel = PROJECTION_LABELS[projection];
  // Saved views from before the preference existed carry none: free.
  const orbitMode = settings.orbitMode ?? 'free';
  const orbitKey = keymap.label('view-orbit-mode');

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
        return;
      }
      // A shortcut goes on to arm its tool; the flyout steps aside rather
      // than stand over it (I54). A saved view's name field keeps its keys.
      if (isWorkspaceShortcutKey(event)) setViewsOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [viewsOpen]);

  // The same styled help as Build's viewer bar, which carries the same
  // controls: switching modes used to swap it for the browser's own titles,
  // without the keys.
  return (
    <div className="view-mode-bar" role="toolbar" aria-label="View tools">
      <Tooltip
        label="Measure"
        shortcut={keymap.label('view-measure')}
        description="Inspect geometry, distance, and angle"
      >
        <button
          type="button"
          className={`view-mode-button wide${measuring ? ' active' : ''}`}
          aria-pressed={measuring}
          aria-label="Measure"
          onClick={() => onMeasure(!measuring)}
        >
          <Ruler size={16} aria-hidden="true" />
          <span className="view-mode-button-label">Measure</span>
        </button>
      </Tooltip>
      <span className="view-mode-divider" aria-hidden="true" />
      <Tooltip
        label="Fit view"
        shortcut={keymap.label('view-fit')}
        description="Double-click the viewport to fit"
      >
        <button
          type="button"
          className="view-mode-button"
          onClick={onFit}
          aria-label={labelWithKey('Fit view', keymap.label('view-fit'))}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label="Toggle grid" shortcut={keymap.label('view-grid')}>
        <button
          type="button"
          className={`view-mode-button${settings.showGrid ? ' active' : ''}`}
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
          className={`view-mode-button${projection === 'orthographic' ? ' active' : ''}`}
          onClick={onToggleProjection}
          aria-label={`${labelWithKey('Orthographic projection', keymap.label('view-projection'))} — now: ${projectionLabel}`}
          aria-pressed={projection === 'orthographic'}
        >
          <Camera size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      {onToggleOrbitMode && (
        <Tooltip
          label="Orbit mode"
          shortcut={orbitKey}
          description={`Now: ${ORBIT_MODE_LABELS[orbitMode]} · ${ORBIT_MODE_DETAILS[orbitMode]}`}
        >
          <button
            type="button"
            className={`view-mode-button view-orbit-mode${orbitMode === 'turntable' ? ' active' : ''}`}
            onClick={onToggleOrbitMode}
            aria-label={`${labelWithKey('Turntable orbit', orbitKey)} — now: ${ORBIT_MODE_LABELS[orbitMode]}`}
            aria-pressed={orbitMode === 'turntable'}
          >
            <Orbit size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      {onToggleSection && (
        <Tooltip
          label="Section view"
          description={`Now: ${sectionLabel} · ${
            sectionOn
              ? 'click to turn off'
              : nothingToSection
                ? 'nothing to cut yet'
                : 'cuts the display only'
          }`}
        >
          <button
            type="button"
            className={`view-mode-button view-mode-section-toggle${
              sectionOn ? ' active' : ''
            }`}
            onClick={() => {
              // Greyed by aria, as on Build's rail: a disabled button
              // cannot take focus or show the tooltip that says why.
              if (!sectionOn && nothingToSection) return;
              onToggleSection();
            }}
            aria-label={`Section view — now: ${sectionLabel}`}
            aria-pressed={sectionOn}
            aria-disabled={!sectionOn && nothingToSection ? true : undefined}
          >
            <SquareSplitVertical size={16} aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <DisplayModeMenu
        variant="bar"
        settings={settings}
        onDisplayMode={onDisplayMode}
        onToggleXray={onToggleXray}
        onOpenChange={(open) => {
          if (open) setViewsOpen(false);
        }}
      />
      <div className="view-mode-views-anchor" ref={anchorRef}>
        <Tooltip label="Standard views">
          <button
            type="button"
            ref={triggerRef}
            className={`view-mode-button${viewsOpen ? ' open' : ''}`}
            onClick={() => setViewsOpen((open) => !open)}
            aria-label="Standard views"
            aria-expanded={viewsOpen}
            aria-controls={viewsOpen ? panelId : undefined}
          >
            <AxisTriadIcon />
          </button>
        </Tooltip>
        {viewsOpen && (
          <div
            className="view-mode-views-panel"
            data-rail-flyout=""
            id={panelId}
            role="group"
            aria-label="Standard views"
          >
            {VIEWS.map((view) => {
              const label = `${VIEW_LABELS[view.id]} view`;
              return (
                <button
                  key={view.id}
                  type="button"
                  className={
                    view.id === 'iso' ? 'view-mode-view-wide' : undefined
                  }
                  onClick={() => {
                    onView(view.id);
                    setViewsOpen(false);
                    // The chosen tile unmounts with the panel; the keyboard
                    // returns to the button that opened it, not to <body>.
                    triggerRef.current?.focus();
                  }}
                  aria-label={labelWithKey(
                    label,
                    view.command && keymap.label(view.command)
                  )}
                >
                  {VIEW_LABELS[view.id]}
                  {view.command && keymap.label(view.command) ? (
                    <kbd aria-hidden="true">
                      {platformShortcutLabel(keymap.label(view.command)!)}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
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
