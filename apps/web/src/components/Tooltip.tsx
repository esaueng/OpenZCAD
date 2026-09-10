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
  placement: 'above' | 'below';
}

let lastClosedTooltip: { id: string; at: number } | null = null;

function setRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null) {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
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
      event.preventDefault();
      event.stopPropagation();
      dismissedRef.current = true;
      closeTooltip();
    };
    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [closeTooltip, open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const updatePosition = () => {
      const triggerBox = triggerRef.current?.getBoundingClientRect();
      const tooltipBox = tooltipRef.current?.getBoundingClientRect();
      if (!triggerBox || !tooltipBox) {
        return;
      }
      const gap = 8;
      const viewportPadding = 8;
      const roomBelow = window.innerHeight - triggerBox.bottom;
      const placement =
        roomBelow < tooltipBox.height + gap &&
        triggerBox.top >= tooltipBox.height + gap
          ? 'above'
          : 'below';
      const halfWidth = tooltipBox.width / 2;
      setPosition({
        left: Math.min(
          window.innerWidth - halfWidth - viewportPadding,
          Math.max(
            halfWidth + viewportPadding,
            triggerBox.left + triggerBox.width / 2
          )
        ),
        top:
          placement === 'above'
            ? triggerBox.top - gap
            : triggerBox.bottom + gap,
        placement
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

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
              {shortcut ? <kbd>{shortcut}</kbd> : null}
              {description ? (
                <span className="tooltip-description">{description}</span>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
