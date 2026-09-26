import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type PointerEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react';
import { platformShortcutLabel } from '../lib/platformShortcut';
import { createPortal } from 'react-dom';

export const TOOLTIP_OPEN_DELAY_MS = 300;
export const TOOLTIP_HANDOFF_MS = 200;

interface TooltipTriggerProps {
  ref?: Ref<HTMLElement>;
  'aria-describedby'?: string;
  onPointerEnter?: PointerEventHandler<HTMLElement>;
  onPointerLeave?: PointerEventHandler<HTMLElement>;
  onFocus?: FocusEventHandler<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
}

interface TooltipProps {
  children: ReactElement;
  label: ReactNode;
  shortcut?: ReactNode;
  description?: ReactNode;
}

interface TooltipPosition {
  left: number;
  top: number;
  placement: 'above' | 'below' | 'left' | 'right';
  /** Beside an open rail flyout: label and shortcut only, no description. */
  compact?: boolean;
}

/** Marks a rail's flyout container; its children are the open flyouts. */
const RAIL_FLYOUTS_ATTRIBUTE = 'data-rail-flyouts';

/** Sub-pixel moves are not worth a re-render. */
const POSITION_EPSILON_PX = 0.5;

let lastClosedTooltip: { id: string; at: number } | null = null;

function setRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null) {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

/**
 * The vertical icon rail the trigger sits in, if any. Orientation comes from
 * the rail's live layout so a rail that a narrow viewport lays out in a row
 * keeps the above/below placement. A trigger outside the rail's column (a
 * flyout nested in the toolbar) does not count as on the rail.
 */
function verticalRailBox(trigger: HTMLElement): DOMRect | null {
  const rail = trigger.closest<HTMLElement>('[role="toolbar"]');
  if (!rail) {
    return null;
  }
  const vertical =
    rail.getAttribute('aria-orientation') === 'vertical' ||
    window.getComputedStyle(rail).flexDirection.startsWith('column');
  if (!vertical) {
    return null;
  }
  const railBox = rail.getBoundingClientRect();
  const triggerBox = trigger.getBoundingClientRect();
  const slack = 1;
  return triggerBox.left >= railBox.left - slack &&
    triggerBox.right <= railBox.right + slack
    ? railBox
    : null;
}

/**
 * Whether an open flyout starts right beside the rail on `side`, level with
 * the tooltip. Only the gap-wide band next to the rail is probed, so the
 * answer does not depend on the tooltip's own (description-dependent) width.
 */
function flyoutBesideRail(
  railBox: DOMRect,
  side: 'left' | 'right',
  top: number,
  bottom: number,
  gap: number
): boolean {
  const bandLeft = side === 'right' ? railBox.right : railBox.left - gap - 1;
  const bandRight = side === 'right' ? railBox.right + gap + 1 : railBox.left;
  return Array.from(
    document.querySelectorAll(`[${RAIL_FLYOUTS_ATTRIBUTE}] > *`)
  ).some((flyout) => {
    const box = flyout.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.left < bandRight &&
      box.right > bandLeft &&
      box.top < bottom &&
      box.bottom > top
    );
  });
}

/** Styled, portal-mounted help for a single control or readout. */
export function Tooltip({
  children,
  label,
  shortcut,
  description
}: TooltipProps) {
  const tooltipId = useId();
  const trigger = children as ReactElement<TooltipTriggerProps>;
  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRef = useRef(false);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const dismissedRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const openTooltip = useCallback(() => {
    clearOpenTimer();
    openRef.current = true;
    setOpen(true);
  }, [clearOpenTimer]);

  const closeTooltip = useCallback(() => {
    clearOpenTimer();
    if (openRef.current) {
      lastClosedTooltip = { id: tooltipId, at: Date.now() };
    }
    openRef.current = false;
    setOpen(false);
    setPosition(null);
  }, [clearOpenTimer, tooltipId]);

  const schedulePointerOpen = useCallback(() => {
    if (dismissedRef.current || openRef.current) {
      return;
    }
    clearOpenTimer();
    const handoff =
      lastClosedTooltip !== null &&
      lastClosedTooltip.id !== tooltipId &&
      Date.now() - lastClosedTooltip.at <= TOOLTIP_HANDOFF_MS;
    if (handoff) {
      openTooltip();
      return;
    }
    openTimerRef.current = setTimeout(openTooltip, TOOLTIP_OPEN_DELAY_MS);
  }, [clearOpenTimer, openTooltip, tooltipId]);

  const onPointerEnter: PointerEventHandler<HTMLElement> = (event) => {
    trigger.props.onPointerEnter?.(event);
    if (event.defaultPrevented) {
      return;
    }
    hoveredRef.current = true;
    if (!focusedRef.current) {
      dismissedRef.current = false;
    }
    schedulePointerOpen();
  };

  const onPointerLeave: PointerEventHandler<HTMLElement> = (event) => {
    trigger.props.onPointerLeave?.(event);
    hoveredRef.current = false;
    if (!focusedRef.current) {
      dismissedRef.current = false;
      closeTooltip();
    }
  };

  const onFocus: FocusEventHandler<HTMLElement> = (event) => {
    trigger.props.onFocus?.(event);
    if (event.defaultPrevented) {
      return;
    }
    focusedRef.current = true;
    dismissedRef.current = false;
    openTooltip();
  };

  const onBlur: FocusEventHandler<HTMLElement> = (event) => {
    trigger.props.onBlur?.(event);
    focusedRef.current = false;
    if (!hoveredRef.current) {
      dismissedRef.current = false;
      closeTooltip();
    }
  };

  useEffect(
    () => () => {
      clearOpenTimer();
    },
    [clearOpenTimer]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      // Escape still belongs to the workspace's command ladder. Closing help
      // must not consume the same key that cancels the active CAD operation.
      dismissedRef.current = true;
      closeTooltip();
    };
    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [closeTooltip, open]);

  // Bails out on an unchanged position so the per-render re-measure below
  // settles instead of re-rendering forever.
  const applyPosition = useCallback((next: TooltipPosition) => {
    setPosition((previous) =>
      previous &&
      previous.placement === next.placement &&
      previous.compact === next.compact &&
      Math.abs(previous.left - next.left) < POSITION_EPSILON_PX &&
      Math.abs(previous.top - next.top) < POSITION_EPSILON_PX
        ? previous
        : next
    );
  }, []);

  const updatePosition = useCallback(() => {
    const triggerBox = triggerRef.current?.getBoundingClientRect();
    const tooltipBox = tooltipRef.current?.getBoundingClientRect();
    if (!triggerBox || !tooltipBox) {
      return;
    }
    const gap = 8;
    const viewportPadding = 8;
    // On a vertical rail, open beside the rail rather than below the
    // button: below, the tooltip covers the rail's next buttons and, once
    // clamped into the viewport, whatever panel sits beside the rail.
    const railBox = triggerRef.current
      ? verticalRailBox(triggerRef.current)
      : null;
    if (railBox) {
      const needed = tooltipBox.width + gap + viewportPadding;
      const side =
        window.innerWidth - railBox.right >= needed
          ? 'right'
          : railBox.left >= needed
            ? 'left'
            : null;
      if (side) {
        const halfHeight = tooltipBox.height / 2;
        const top = Math.min(
          window.innerHeight - halfHeight - viewportPadding,
          Math.max(
            halfHeight + viewportPadding,
            triggerBox.top + triggerBox.height / 2
          )
        );
        applyPosition({
          left: side === 'right' ? railBox.right + gap : railBox.left - gap,
          top,
          placement: side,
          // An open flyout already fills that side; a label-only tooltip
          // covers as little of it as possible.
          compact: flyoutBesideRail(
            railBox,
            side,
            top - halfHeight,
            top + halfHeight,
            gap
          )
        });
        return;
      }
    }
    const roomBelow = window.innerHeight - triggerBox.bottom;
    const placement =
      roomBelow < tooltipBox.height + gap &&
      triggerBox.top >= tooltipBox.height + gap
        ? 'above'
        : 'below';
    const halfWidth = tooltipBox.width / 2;
    applyPosition({
      left: Math.min(
        window.innerWidth - halfWidth - viewportPadding,
        Math.max(
          halfWidth + viewportPadding,
          triggerBox.left + triggerBox.width / 2
        )
      ),
      top:
        placement === 'above' ? triggerBox.top - gap : triggerBox.bottom + gap,
      placement
    });
  }, [applyPosition]);

  // Re-measured after every render while open, not only on opening: the
  // trigger's own click can mount or unmount the flyout beside the rail (and
  // change the description) while the tooltip stays up.
  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const describedBy = [
    trigger.props['aria-describedby'],
    open ? tooltipId : undefined
  ]
    .filter(Boolean)
    .join(' ');
  const child = cloneElement(trigger, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      setRef(trigger.props.ref, node);
    },
    'aria-describedby': describedBy || undefined,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur
  });

  return (
    <>
      {child}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              className="tooltip"
              data-placement={position?.placement ?? 'below'}
              style={{
                left: position?.left ?? 0,
                top: position?.top ?? 0,
                visibility: position ? 'visible' : 'hidden'
              }}
            >
              <span className="tooltip-label">{label}</span>
              {shortcut ? (
                <kbd>
                  {typeof shortcut === 'string'
                    ? platformShortcutLabel(shortcut)
                    : shortcut}
                </kbd>
              ) : null}
              {description && !position?.compact ? (
                <span className="tooltip-description">{description}</span>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
