import { useEffect, useRef, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

/**
 * The header's overflow menu.
 *
 * A native disclosure does not close when you click away from it, which for a
 * menu means it sits open over the panel until you click it again. The colour
 * picker already solved that; this uses the same listener rather
 * than inventing a second behaviour for the same gesture.
 */
export function PanelOverflow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      ) {
        menu.open = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        // Stop here: the panel's own Escape handler closes the whole panel,
        // and dismissing a menu should not also dismiss what it belongs to.
        event.stopPropagation();
        ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return (
    <details className="panel-overflow" ref={ref}>
      <summary
        className="icon-button"
        title="More actions"
        aria-label="More actions"
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </summary>
      <div className="panel-overflow-menu">{children}</div>
    </details>
  );
}
