import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { Check, LayoutPanelLeft } from 'lucide-react';
import {
  PANEL_COLUMN_WIDTHS,
  PANEL_PRESET_IDS,
  type PanelLayoutOptions,
  type PanelPresetId,
  type PanelWidth
} from '../../lib/panelLayout';
import { platformShortcutLabel } from '../../lib/platformShortcut';
import { useMenuKeyboard } from '../../lib/useMenuKeyboard';

/** What a locked layout's presets and width say instead of what they do. */
export const LAYOUT_LOCKED_DETAIL = 'Unlock the layout to change it';

const PRESETS: Readonly<
  Record<PanelPresetId, { label: string; detail: string }>
> = {
  essentials: {
    label: 'Essentials',
    detail: 'Objects left, Parameters right'
  },
  full: {
    label: 'Full workspace',
    detail: 'Objects over History left, Parameters over Revisions right'
  },
  modeling: {
    label: 'Modeling',
    detail: 'Objects over a taller History left, Parameters right'
  },
  review: { label: 'Review', detail: 'History over Revisions, right' },
  'model-only': { label: 'Model only', detail: 'No panels open' }
};

const WIDTHS: ReadonlyArray<{ id: PanelWidth; label: string }> = [
  { id: 'narrow', label: 'Small' },
  { id: 'regular', label: 'Medium' },
  { id: 'wide', label: 'Large' }
];

export type ViewOptionsToggle = 'hidden' | 'locked' | 'compact' | 'fit';

export interface ViewOptionsMenuProps {
  options: PanelLayoutOptions;
  /** The preset the layout is arranged as, if it still is one. */
  preset: PanelPresetId | null;
  /** Hide all's live chord, in the stored grammar; none when unbound. */
  hideShortcut?: string | undefined;
  onPreset(id: PanelPresetId): void;
  onToggle(key: ViewOptionsToggle): void;
  onWidth(width: PanelWidth): void;
}

/**
 * The panel rail's View options button and its menu: the presets, Hide all,
 * Lock, Compact rows and the column width. Picking an item keeps the menu
 * open, so a setting reads back at once; Escape, a press outside, the button
 * again or Tab close it. A locked layout disables the presets and the width,
 * which would rearrange or resize every panel, and says why.
 */
export function ViewOptionsMenu(props: ViewOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`rail-button${open ? ' active' : ''}`}
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="View options · presets, Hide all, Lock, Compact, Width"
        onClick={() => setOpen((current) => !current)}
      >
        <LayoutPanelLeft size={16} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <ViewOptionsList
            {...props}
            anchorRef={buttonRef}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </>
  );
}

function ViewOptionsList({
  options,
  preset,
  hideShortcut,
  onPreset,
  onToggle,
  onWidth,
  anchorRef,
  onClose
}: ViewOptionsMenuProps & {
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  useMenuKeyboard(ref);

  // To the rail's left, level with the button, and inside the window. It
  // follows the button every frame while open: Hide all, Model only or a
  // width change moves the rail, which slides to its new place.
  useLayoutEffect(() => {
    let frame = 0;
    let placed = '';
    const place = () => {
      const menu = ref.current?.getBoundingClientRect();
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (menu && anchor) {
        const x = Math.max(
          8,
          Math.min(anchor.left - 10 - menu.width, window.innerWidth - 8)
        );
        const y = Math.max(
          8,
          Math.min(anchor.top - 4, window.innerHeight - menu.height - 8)
        );
        if (`${x},${y}` !== placed) {
          placed = `${x},${y}`;
          setPosition({ x, y });
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchorRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // The button toggles the menu itself.
      if (
        ref.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchorRef, onClose]);

  // Tab leaves the menu as it would leave the button: focus goes back to
  // the button first, and the key's own move carries on from there.
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    anchorRef.current?.focus({ preventScroll: true });
    onClose();
  };

  const locked = options.locked;
  return (
    <div
      ref={ref}
      className="context-menu view-options-menu"
      role="menu"
      aria-labelledby={`${id}-heading`}
      tabIndex={-1}
      // Unseen until measured, but not `visibility: hidden`: the menu takes
      // focus as it mounts, and a hidden element cannot.
      style={
        position
          ? { left: position.x, top: position.y }
          : { left: 0, top: 0, opacity: 0 }
      }
      onKeyDown={onMenuKeyDown}
    >
      <div id={`${id}-heading`} className="context-menu-heading">
        View options
      </div>
      <div role="group" aria-labelledby={`${id}-layouts`}>
        <div id={`${id}-layouts`} className="view-options-group-label">
          Layout
        </div>
        {PANEL_PRESET_IDS.map((name) => (
          <ViewOptionsItem
            key={name}
            role="menuitemradio"
            label={PRESETS[name].label}
            detail={locked ? LAYOUT_LOCKED_DETAIL : PRESETS[name].detail}
            checked={preset === name}
            disabled={locked}
            onSelect={() => onPreset(name)}
          />
        ))}
      </div>
      <div
        role="group"
        aria-labelledby={`${id}-settings`}
        className="context-menu-section"
      >
        <div id={`${id}-settings`} className="view-options-group-label">
          Settings
        </div>
        <ViewOptionsItem
          role="menuitemcheckbox"
          label="Hide all panels"
          checked={options.hidden}
          shortcut={hideShortcut && platformShortcutLabel(hideShortcut)}
          onSelect={() => onToggle('hidden')}
        />
        <ViewOptionsItem
          role="menuitemcheckbox"
          label="Lock layout"
          checked={locked}
          onSelect={() => onToggle('locked')}
        />
        <ViewOptionsItem
          role="menuitemcheckbox"
          label="Compact rows"
          checked={options.compact}
          onSelect={() => onToggle('compact')}
        />
        <ViewOptionsItem
          role="menuitemcheckbox"
          label="Fit panels to content"
          checked={options.fit}
          onSelect={() => onToggle('fit')}
        />
      </div>
      <div
        role="group"
        aria-labelledby={`${id}-width`}
        className="context-menu-section"
      >
        <div id={`${id}-width`} className="view-options-group-label">
          Panel width
        </div>
        {WIDTHS.map((width) => (
          <ViewOptionsItem
            key={width.id}
            role="menuitemradio"
            label={width.label}
            detail={
              locked
                ? LAYOUT_LOCKED_DETAIL
                : `${PANEL_COLUMN_WIDTHS[width.id]} px`
            }
            checked={options.width === width.id}
            disabled={locked}
            onSelect={() => onWidth(width.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ViewOptionsItem({
  role,
  label,
  detail,
  shortcut,
  checked,
  disabled = false,
  onSelect
}: {
  role: 'menuitemradio' | 'menuitemcheckbox';
  label: string;
  detail?: string;
  shortcut?: string | undefined;
  checked: boolean;
  disabled?: boolean;
  onSelect(): void;
}) {
  const detailId = useId();
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      // The label alone names it; the detail describes it.
      aria-label={label}
      aria-describedby={detail ? detailId : undefined}
      className="context-menu-item"
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="context-menu-icon view-options-check" aria-hidden="true">
        {checked && <Check size={13} />}
      </span>
      <span className="context-menu-label">
        {label}
        {detail && (
          <span id={detailId} className="context-menu-detail">
            {detail}
          </span>
        )}
      </span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

/**
 * While Hide all is on, what says so and brings the panels back. The
 * layout is kept, so Show returns every panel where it was.
 */
export function PanelsHiddenPill({ onShow }: { onShow(): void }) {
  return (
    <div className="panels-hidden-pill">
      <span role="status">Panels hidden</span>
      <span aria-hidden="true">·</span>
      <button type="button" aria-label="Show panels" onClick={onShow}>
        Show
      </button>
    </div>
  );
}
