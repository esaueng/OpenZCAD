import {
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
  children
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  id: string;
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

  return createPortal(
    <div
      ref={ref}
      id={id}
      className="sketch-modify-flyout"
      role="group"
      aria-label="More modify tools"
      data-rail-flyout=""
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>,
    document.body
  );
}
