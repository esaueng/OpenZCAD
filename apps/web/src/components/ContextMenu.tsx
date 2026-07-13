import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a separator line above this item. */
  section?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuProps {
  menu: ContextMenuState;
  onSelect(itemId: string): void;
  onClose(): void;
}

/** Positioned right-click menu; closes on outside pointer, Esc, or selection. */
export function ContextMenu({ menu, onSelect, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    setPosition({
      x: Math.min(menu.x, window.innerWidth - rect.width - 8),
      y: Math.min(menu.y, window.innerHeight - rect.height - 8)
    });
  }, [menu]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: position.x, top: position.y }}
    >
      {menu.items.map((item) => (
        <div key={item.id} className={item.section ? 'context-menu-section' : undefined}>
          <button
            type="button"
            role="menuitem"
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              onSelect(item.id);
              onClose();
            }}
          >
            {item.icon && <span className="context-menu-icon">{item.icon}</span>}
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
