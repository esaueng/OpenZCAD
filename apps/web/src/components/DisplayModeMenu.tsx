import { useEffect, useId, useRef, useState } from 'react';
import { Check, Rows3, ScanEye, Spline, Triangle } from 'lucide-react';
import type { DisplayMode, ViewerSettings } from '@openzcad/viewport';
import { DisplayModeIcon } from './ViewerRailIcons';
import { DISPLAY_MODE_LABELS, DISPLAY_MODE_ORDER } from '../lib/displayMode';
import { Tooltip } from './Tooltip';
import { labelWithKey, useKeymap } from '../lib/keymap';
import { platformShortcutLabel } from '../lib/platformShortcut';
import {
  ANALYSIS_LABELS,
  analysisRuntime,
  useAnalysisRuntime
} from '../lib/analysis/analysisRuntime';
import type { SurfaceAnalysisKind } from '@openzcad/shared';

/** The M09 analyses the menu offers, in order, with their icons. */
const ANALYSIS_ITEMS: { kind: SurfaceAnalysisKind; icon: typeof Triangle }[] = [
  { kind: 'draft', icon: Triangle },
  { kind: 'curvature', icon: Spline },
  { kind: 'zebra', icon: Rows3 }
];

/**
 * Whether a key press is a workspace shortcut that acts on its own: a bare
 * printable key, not one typed into a field. An open flyout steps aside for
 * one, so it never lingers over the tool the key armed (I54).
 */
export function isWorkspaceShortcutKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key.length !== 1 || event.key === ' ') return false;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable="true"]'))
  ) {
    return false;
  }
  return true;
}

interface DisplayModeMenuProps {
  settings: Pick<ViewerSettings, 'displayMode' | 'xray'>;
  onDisplayMode(mode: DisplayMode): void;
  onToggleXray(): void;
  /**
   * Build's viewer bar (`rail`) or View's and Tweak's bar (`bar`): the
   * classes of the rail it stands in, so it matches its neighbours.
   */
  variant: 'rail' | 'bar';
  /** Told when the menu opens or closes; the rail moves its other panels. */
  onOpenChange?(open: boolean): void;
}

/**
 * The rail's Display button and the small menu it opens: the three display
 * modes and X-ray, which rides over whichever mode is on (I52). X-ray had
 * only Shift+X and the command bar: nothing on screen named it. W still
 * cycles the modes without opening anything.
 */
export function DisplayModeMenu({
  settings,
  onDisplayMode,
  onToggleXray,
  variant,
  onOpenChange
}: DisplayModeMenuProps) {
  const keymap = useKeymap();
  const [open, setOpenState] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const xray = settings.xray === true;
  const analysisKind = useAnalysisRuntime((s) => s.request?.kind ?? null);
  const displayModeLabel = `${DISPLAY_MODE_LABELS[settings.displayMode]}${
    xray ? ' · X-ray' : ''
  }${analysisKind ? ` · ${ANALYSIS_LABELS[analysisKind]} analysis` : ''}`;
  const displayKey = keymap.label('view-display');
  const xrayKey = keymap.label('view-xray');

  function setOpen(next: boolean) {
    setOpenState(next);
    onOpenChangeRef.current?.(next);
  }

  // Close on an outside pointer, on Escape (handing the keyboard back to the
  // button), and on a workspace shortcut, which goes on to do its own work.
  useEffect(() => {
    if (!open) return;
    function close() {
      setOpenState(false);
      onOpenChangeRef.current?.(false);
    }
    function onPointerDown(event: PointerEvent) {
      if (!anchorRef.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (isWorkspaceShortcutKey(event)) close();
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const rail = variant === 'rail';
  const buttonClass = rail
    ? `rail-button${open ? ' open' : ''}${xray ? ' active' : ''}`
    : `view-mode-button${open ? ' open' : ''}${xray ? ' active' : ''}`;

  return (
    <div
      className={rail ? 'rail-views-anchor' : 'view-mode-views-anchor'}
      ref={anchorRef}
    >
      <Tooltip
        label="Display mode"
        shortcut={displayKey}
        description={`Now: ${displayModeLabel} · modes, X-ray and analysis`}
      >
        <button
          type="button"
          ref={triggerRef}
          className={buttonClass}
          onClick={() => setOpen(!open)}
          aria-label={`${labelWithKey('Display mode', displayKey)} — now: ${displayModeLabel}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
        >
          <DisplayModeIcon mode={settings.displayMode} />
        </button>
      </Tooltip>
      {open && (
        <div
          className={`${rail ? 'rail-views-panel' : 'view-mode-views-panel'} display-menu`}
          data-rail-flyout=""
          id={panelId}
          role="group"
          aria-label="Display"
        >
          {DISPLAY_MODE_ORDER.map((mode) => {
            const on = settings.displayMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className="display-menu-item"
                aria-pressed={on}
                onClick={() => {
                  onDisplayMode(mode);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <DisplayModeIcon mode={mode} size={14} />
                <span className="display-menu-label">
                  {DISPLAY_MODE_LABELS[mode]}
                </span>
                {on && (
                  <Check
                    size={14}
                    className="display-menu-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
          <span className="display-menu-divider" aria-hidden="true" />
          <button
            type="button"
            className="display-menu-item"
            aria-pressed={xray}
            aria-label={labelWithKey('X-ray', xrayKey)}
            // A switch over the mode, not a choice of one: the menu stays
            // open so the mode can be picked under it as well.
            onClick={onToggleXray}
          >
            <ScanEye size={14} aria-hidden="true" />
            <span className="display-menu-label">X-ray</span>
            {xrayKey ? (
              <kbd aria-hidden="true">{platformShortcutLabel(xrayKey)}</kbd>
            ) : null}
            {xray && (
              <Check
                size={14}
                className="display-menu-check"
                aria-hidden="true"
              />
            )}
          </button>
          <span className="display-menu-divider" aria-hidden="true" />
          {/* M09: analysis overlays. One at a time, over whichever mode is
              on; each opens its panel (legend, provenance, limits) over the
              viewport, so the menu closes on a choice. */}
          <span className="display-menu-heading" aria-hidden="true">
            Analysis
          </span>
          {ANALYSIS_ITEMS.map(({ kind, icon: Icon }) => {
            const on = analysisKind === kind;
            return (
              <button
                key={kind}
                type="button"
                className="display-menu-item"
                aria-pressed={on}
                aria-label={`${ANALYSIS_LABELS[kind]} analysis`}
                onClick={() => {
                  analysisRuntime.toggle(kind);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <Icon size={14} aria-hidden="true" />
                <span className="display-menu-label">
                  {ANALYSIS_LABELS[kind]}
                </span>
                {on && (
                  <Check
                    size={14}
                    className="display-menu-check"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
