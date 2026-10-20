import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react';
import {
  computePanelGeometry,
  PANEL_SLOT,
  resizeGap,
  splitGapEvenly,
  type GapGeometry,
  type PanelId,
  type PanelLayout,
  type PanelStage,
  unpinnedSlotReserves
} from '../../lib/panelLayout';
import type { PanelPlacement } from './PanelFrame';
import { PANEL_TITLES } from './panelMeta';

export interface PanelDockProps {
  layout: PanelLayout;
  /**
   * A sketch or a drag has the stage (and nothing released it): no panel
   * draws, and the dock gives its width back to the rail and the lanes.
   */
  hidden: boolean;
  /** The stage the dock measured, whenever it changes size. */
  onStage(stage: PanelStage): void;
  /** A gap resize or even split, committed once at the end of the gesture. */
  onLayout(next: PanelLayout): void;
  renderPanel(id: PanelId, placement: PanelPlacement): ReactNode;
}

/** Equal sizes and insets are the same stage: no re-render for a no-op. */
function sameStage(a: PanelStage | null, b: PanelStage): boolean {
  return (
    a !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.insets?.gap === b.insets?.gap &&
    a.insets?.rail === b.insets?.rail
  );
}

function pixels(value: string, fallback: number): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface GapDrag {
  pointerId: number;
  startY: number;
  lastY: number;
  start: PanelLayout;
  gap: GapGeometry;
  frame: number | null;
}

/**
 * The right dock: its columns against the screen edge, the panels stacked in
 * them and the gaps between, and the unpinned panel beside the rail's inner
 * edge. The layer it draws in spans the band between the top islands and the
 * bottom-right corner (CSS), and that band is the stage the layout is
 * projected onto, so the cube and the scale bar never sit under a panel.
 *
 * A gap drag runs on a local copy of the layout and commits once on
 * release, so the App does not re-render on every pointer move. At a
 * phone-width stage nothing draws here: the App shows one panel in the
 * phone lane instead.
 *
 * The dock's width (`--right-dock-w`) and the unpinned panel's
 * (`--right-peek-w`) are published on `.workspace`, where the rail, the
 * right lane and the stage's other right-hand islands read them.
 */
export function PanelDock({
  layout,
  hidden,
  onStage,
  onLayout,
  renderPanel
}: PanelDockProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<PanelStage | null>(null);
  const [dragLayout, setDragLayout] = useState<PanelLayout | null>(null);
  /** The lane's card width (`--context-w`) the unpinned slot must leave. */
  const [laneMin, setLaneMin] = useState(330);
  const dragRef = useRef<GapDrag | null>(null);
  const onStageRef = useRef(onStage);
  onStageRef.current = onStage;

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => {
      const rect = layer.getBoundingClientRect();
      const style = getComputedStyle(layer);
      const next: PanelStage = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        insets: {
          top: 0,
          bottom: 0,
          gap: pixels(style.getPropertyValue('--island-gap'), 10),
          rail: pixels(style.getPropertyValue('--rail-w'), 40)
        }
      };
      setStage((current) => (sameStage(current, next) ? current : next));
      setLaneMin(pixels(style.getPropertyValue('--context-w'), 330));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (stage) onStageRef.current(stage);
  }, [stage]);

  const shown = dragLayout ?? layout;
  const geometry = stage && !hidden ? computePanelGeometry(shown, stage) : null;
  const docked = geometry && !geometry.phone ? geometry : null;
  const columns = docked
    ? docked.columns.filter((column) => column.side === 'right')
    : [];
  const slot = docked
    ? Object.values(docked.panels).find(
        (rect) => rect && (rect.mode === 'unpinned' || rect.mode === 'revealed')
      )
    : undefined;
  const dockWidth = docked ? docked.dockWidth.right : 0;
  const slotWidth = docked && slot ? docked.columnWidth + docked.insets.gap : 0;
  const peekWidth =
    stage &&
    slotWidth > 0 &&
    unpinnedSlotReserves(stage, dockWidth, slotWidth, laneMin)
      ? slotWidth
      : 0;

  useLayoutEffect(() => {
    const workspace = layerRef.current?.closest<HTMLElement>('.workspace');
    workspace?.style.setProperty('--right-dock-w', `${dockWidth}px`);
    workspace?.style.setProperty('--right-peek-w', `${peekWidth}px`);
  }, [dockWidth, peekWidth]);

  useLayoutEffect(() => {
    const workspace = layerRef.current?.closest<HTMLElement>('.workspace');
    return () => {
      workspace?.style.removeProperty('--right-dock-w');
      workspace?.style.removeProperty('--right-peek-w');
    };
  }, []);

  useEffect(
    () => () => {
      const drag = dragRef.current;
      if (drag?.frame != null) cancelAnimationFrame(drag.frame);
    },
    []
  );

  const startGapDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    gap: GapGeometry
  ) => {
    if (!gap.enabled || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      lastY: event.clientY,
      start: layout,
      gap,
      frame: null
    };
  };

  const resized = (drag: GapDrag, y: number) =>
    resizeGap(
      drag.start,
      drag.gap.above,
      drag.gap.below,
      // Measured from the drag's start against its starting layout, so a
      // long drag never accumulates rounding.
      y - drag.startY,
      drag.gap.pxPerWeight
    );

  const moveGapDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.lastY = event.clientY;
    if (drag.frame === null) {
      drag.frame = requestAnimationFrame(() => {
        drag.frame = null;
        if (dragRef.current === drag) setDragLayout(resized(drag, drag.lastY));
      });
    }
  };

  const endGapDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    commit: boolean
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    dragRef.current = null;
    setDragLayout(null);
    if (commit) {
      const next = resized(drag, event.clientY);
      if (next !== drag.start) onLayout(next);
    }
  };

  return (
    <div
      className={`panel-dock-layer${slotWidth > 0 && peekWidth === 0 ? ' slot-over-lane' : ''}`}
      ref={layerRef}
    >
      {columns.map((column) => (
        <div
          key={`${column.side}-${column.column}`}
          className={`panel-column${column.overflowing ? ' is-scrolling' : ''}`}
          data-side={column.side}
          style={{
            left: column.x,
            top: column.y,
            width: column.w,
            height: column.h
          }}
        >
          <div
            className="panel-column-stack"
            style={{ height: column.contentHeight }}
          >
            {column.panels.map((id) => {
              const rect = docked!.panels[id];
              if (!rect || id === PANEL_SLOT) return null;
              return (
                <div
                  key={id}
                  className="panel-slot"
                  style={{ top: rect.y - column.y, height: rect.h }}
                >
                  {renderPanel(id, 'docked')}
                </div>
              );
            })}
            {docked!.gaps
              .filter(
                (gap) =>
                  gap.container.kind === 'column' &&
                  gap.container.side === column.side &&
                  gap.container.column === column.column
              )
              .map((gap) => {
                const total =
                  shown.weights[gap.above] + shown.weights[gap.below];
                return (
                  <div
                    key={`${gap.above}-${gap.below}`}
                    className={`panel-gap${gap.enabled ? '' : ' is-off'}`}
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`Resize ${PANEL_TITLES[gap.above]} and ${PANEL_TITLES[gap.below]}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(
                      (100 * shown.weights[gap.above]) / total
                    )}
                    aria-disabled={gap.enabled ? undefined : true}
                    title={
                      gap.enabled
                        ? 'Drag to resize · double-click to split evenly'
                        : undefined
                    }
                    style={{ top: gap.y - column.y, height: gap.h }}
                    onPointerDown={(event) => startGapDrag(event, gap)}
                    onPointerMove={moveGapDrag}
                    onPointerUp={(event) => endGapDrag(event, true)}
                    onPointerCancel={(event) => endGapDrag(event, false)}
                    onDoubleClick={() => {
                      if (!gap.enabled) return;
                      const next = splitGapEvenly(layout, gap.above, gap.below);
                      if (next !== layout) onLayout(next);
                    }}
                  >
                    <span className="panel-gap-grip" aria-hidden="true" />
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      {slot && slot.id !== PANEL_SLOT && (
        <div
          className={`panel-unpinned${slot.mode === 'revealed' ? ' is-revealed' : ''}`}
          style={{ width: slot.w }}
        >
          {renderPanel(
            slot.id,
            slot.mode === 'revealed' ? 'revealed' : 'unpinned'
          )}
        </div>
      )}
    </div>
  );
}
