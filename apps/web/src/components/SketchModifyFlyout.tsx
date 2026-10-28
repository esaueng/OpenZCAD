import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';

/** Follows its rail slot even when the tools scroll inside a transformed column. */
export function SketchModifyFlyout({
  anchorRef,
  id,
  onClose,
  children
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  id: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );

  useLayoutEffect(() => {
    let frame = 0;
    let placed = '';
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = ref.current?.getBoundingClientRect();
      if (anchor && panel) {
        const x = Math.max(
          8,
          Math.min(anchor.right + 10, window.innerWidth - panel.width - 8)
        );
        const y = Math.max(
          8,
          Math.min(anchor.top, window.innerHeight - panel.height - 8)
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
      if (ref.current?.contains(target) || anchorRef.current?.contains(target))
        return;
      onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [anchorRef, onClose]);

  // A portal is last in document order. Enter its tools immediately and
  // return to the rail when it closes, without stealing a later dialog's focus.
  useLayoutEffect(() => {
    const panel = ref.current;
    const anchor = anchorRef.current;
    if (!panel) return;
    (
      panel.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? panel
    ).focus({ preventScroll: true });
    return () => {
      if (panel.contains(document.activeElement)) {
        anchor?.focus({ preventScroll: true });
      }
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      className="sketch-modify-flyout"
      role="group"
      aria-label="More modify tools"
      tabIndex={-1}
      data-rail-flyout=""
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button:not(:disabled)'
          )
        );
        const active = document.activeElement;
        const boundary = event.shiftKey ? buttons[0] : buttons.at(-1);
        if (active !== event.currentTarget && active !== boundary) return;
        anchorRef.current?.focus({ preventScroll: true });
        onClose();
        // Back from the first item stops on the trigger. Forward from the
        // last lets the browser continue to the next tool after that trigger.
        if (event.shiftKey) event.preventDefault();
      }}
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        opacity: position ? 1 : 0
      }}
    >
      {children}
    </div>,
    document.body
  );
}
