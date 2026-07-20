import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Circle,
  Hexagon,
  MousePointer2,
  RotateCcw,
  ScanLine,
  Square,
  X
} from 'lucide-react';
import type {
  PlaneId,
  SketchObjectData,
  SketchObjectKind
} from '@openzcad/shared';
import { PLANE_LABELS } from '../lib/model';
import type { SketchFormValue } from './forms/FeatureForms';

type SketchTool = SketchObjectKind;

interface SketchPoint {
  x: number;
  y: number;
}

interface SketchWorkspaceProps {
  sketchNumber: number;
  units: string;
  snapStep: number | null;
  onCancel(): void;
  onFinish(value: SketchFormValue): void;
}

const SNAP_STEP = 1;
const MIN_PROFILE_SIZE = 0.5;

const TOOL_LABELS: Record<SketchTool, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  polygon: 'Polygon'
};

const TOOL_HINTS: Record<SketchTool, string> = {
  rectangle: 'Drag corner to corner to make a closed profile.',
  circle: 'Place the center, then drag outward to set the radius.',
  polygon: 'Place the center, then drag outward to make a hexagon.'
};

export function snapSketchPoint(
  point: SketchPoint,
  step = SNAP_STEP
): SketchPoint {
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step
  };
}

export function sketchObjectFromDrag(
  tool: SketchTool,
  start: SketchPoint,
  end: SketchPoint
): SketchObjectData | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (tool === 'rectangle') {
    const width = Math.abs(dx);
    const height = Math.abs(dy);
    if (width < MIN_PROFILE_SIZE || height < MIN_PROFILE_SIZE) {
      return null;
    }
    return {
      objectKind: 'rectangle',
      width,
      height,
      centerX: (start.x + end.x) / 2,
      centerY: (start.y + end.y) / 2
    };
  }

  const radius = Math.hypot(dx, dy);
  if (radius < MIN_PROFILE_SIZE) {
    return null;
  }
  if (tool === 'circle') {
    return {
      objectKind: 'circle',
      radius,
      centerX: start.x,
      centerY: start.y
    };
  }
  return {
    objectKind: 'polygon',
    sides: 6,
    radius,
    centerX: start.x,
    centerY: start.y
  };
}

function numberValue(value: SketchObjectData[keyof SketchObjectData]): number {
  return typeof value === 'number' ? value : Number(value);
}

function profileSummary(object: SketchObjectData, units: string): string {
  if (object.objectKind === 'rectangle') {
    return `${numberValue(object.width).toFixed(1)} × ${numberValue(object.height).toFixed(1)} ${units}`;
  }
  const radius = numberValue(object.radius);
  return object.objectKind === 'circle'
    ? `Ø ${(radius * 2).toFixed(1)} ${units}`
    : `6 sides · R ${radius.toFixed(1)} ${units}`;
}

function drawProfile(
  context: CanvasRenderingContext2D,
  object: SketchObjectData,
  center: SketchPoint,
  scale: number
) {
  const x = center.x + numberValue(object.centerX) * scale;
  const y = center.y - numberValue(object.centerY) * scale;
  context.beginPath();
  if (object.objectKind === 'rectangle') {
    const width = numberValue(object.width) * scale;
    const height = numberValue(object.height) * scale;
    context.rect(x - width / 2, y - height / 2, width, height);
  } else if (object.objectKind === 'circle') {
    context.arc(x, y, numberValue(object.radius) * scale, 0, Math.PI * 2);
  } else {
    const radius = numberValue(object.radius) * scale;
    const sides = Math.max(3, Math.round(numberValue(object.sides)));
    for (let index = 0; index < sides; index += 1) {
      const angle = -Math.PI / 2 + (index / sides) * Math.PI * 2;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (index === 0) {
        context.moveTo(px, py);
      } else {
        context.lineTo(px, py);
      }
    }
    context.closePath();
  }
  context.fillStyle = 'rgba(59, 130, 246, 0.13)';
  context.fill();
  context.lineWidth = 2;
  context.strokeStyle = '#f59e0b';
  context.stroke();
}

export function SketchWorkspace({
  sketchNumber,
  units,
  snapStep,
  onCancel,
  onFinish
}: SketchWorkspaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [tool, setTool] = useState<SketchTool>('circle');
  const [plane, setPlane] = useState<PlaneId>('XY');
  const [scale, setScale] = useState(10);
  const [draft, setDraft] = useState<SketchObjectData | null>(null);
  const [dragStart, setDragStart] = useState<SketchPoint | null>(null);
  const [dragEnd, setDragEnd] = useState<SketchPoint | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });

  const currentObject = useMemo(
    () =>
      dragStart && dragEnd
        ? sketchObjectFromDrag(tool, dragStart, dragEnd)
        : draft,
    [draft, dragEnd, dragStart, tool]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ratio = Math.min(window.devicePixelRatio, 2);
    canvas.width = Math.max(1, Math.round(canvasSize.width * ratio));
    canvas.height = Math.max(1, Math.round(canvasSize.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = canvasSize.width;
    const height = canvasSize.height;
    const center = { x: width / 2, y: height / 2 };

    context.fillStyle = '#090b0e';
    context.fillRect(0, 0, width, height);

    const minor = scale;
    const majorEvery = 5;
    const leftSteps = Math.ceil(center.x / minor);
    const rightSteps = Math.ceil((width - center.x) / minor);
    const topSteps = Math.ceil(center.y / minor);
    const bottomSteps = Math.ceil((height - center.y) / minor);

    context.lineWidth = 1;
    for (let step = -leftSteps; step <= rightSteps; step += 1) {
      const x = center.x + step * minor;
      context.strokeStyle = step % majorEvery === 0 ? '#242a31' : '#171c22';
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let step = -topSteps; step <= bottomSteps; step += 1) {
      const y = center.y + step * minor;
      context.strokeStyle = step % majorEvery === 0 ? '#242a31' : '#171c22';
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }

    context.lineWidth = 1.5;
    context.strokeStyle = '#b83c4a';
    context.beginPath();
    context.moveTo(0, center.y + 0.5);
    context.lineTo(width, center.y + 0.5);
    context.stroke();
    context.strokeStyle = '#2f6ea8';
    context.beginPath();
    context.moveTo(center.x + 0.5, 0);
    context.lineTo(center.x + 0.5, height);
    context.stroke();

    context.fillStyle = '#5da9ff';
    context.beginPath();
    context.arc(center.x, center.y, 3, 0, Math.PI * 2);
    context.fill();

    if (currentObject) {
      drawProfile(context, currentObject, center, scale);
    }
  }, [canvasSize, currentObject, scale]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        event.preventDefault();
        if (dragStart || draft) {
          setDragStart(null);
          setDragEnd(null);
          setDraft(null);
        } else {
          onCancel();
        }
      } else if (key === 'enter' && draft) {
        event.preventDefault();
        onFinish({
          name: `Sketch ${String(sketchNumber).padStart(2, '0')}`,
          plane,
          offset: 0,
          object: draft
        });
      } else if (key === 'r') {
        setTool('rectangle');
      } else if (key === 'c') {
        setTool('circle');
      } else if (key === 'p') {
        setTool('polygon');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draft, dragStart, onCancel, onFinish, plane, sketchNumber]);

  function pointFromPointer(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left - rect.width / 2) / scale,
      y: -(event.clientY - rect.top - rect.height / 2) / scale
    };
    return snapStep === null ? point : snapSketchPoint(point, snapStep);
  }

  function finish() {
    if (!draft) {
      return;
    }
    onFinish({
      name: `Sketch ${String(sketchNumber).padStart(2, '0')}`,
      plane,
      offset: 0,
      object: draft
    });
  }

  return (
    <div className="sketch-workspace" aria-label="Sketch workspace">
      <canvas
        ref={canvasRef}
        className="sketch-canvas"
        aria-label={`Draw ${TOOL_LABELS[tool].toLowerCase()} profile`}
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return;
          }
          const point = pointFromPointer(event);
          setDragStart(point);
          setDragEnd(point);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragStart) {
            setDragEnd(pointFromPointer(event));
          }
        }}
        onPointerUp={(event) => {
          if (!dragStart) {
            return;
          }
          const object = sketchObjectFromDrag(
            tool,
            dragStart,
            pointFromPointer(event)
          );
          if (object) {
            setDraft(object);
          }
          setDragStart(null);
          setDragEnd(null);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onWheel={(event) => {
          event.preventDefault();
          setScale((current) =>
            Math.min(24, Math.max(4, current * (event.deltaY > 0 ? 0.9 : 1.1)))
          );
        }}
      />

      <div className="sketch-instruction" role="status">
        <span className="sketch-instruction-icon">
          {tool === 'rectangle' ? (
            <Square size={18} aria-hidden="true" />
          ) : tool === 'circle' ? (
            <Circle size={18} aria-hidden="true" />
          ) : (
            <Hexagon size={18} aria-hidden="true" />
          )}
        </span>
        <span>
          <strong>
            {TOOL_LABELS[tool]} (
            {tool === 'rectangle' ? 'R' : tool === 'circle' ? 'C' : 'P'})
          </strong>
          <small>{TOOL_HINTS[tool]}</small>
        </span>
      </div>

      <div className="sketch-tools" role="toolbar" aria-label="Sketch tools">
        <button type="button" title="Select profile">
          <MousePointer2 size={17} aria-hidden="true" />
          <span>Select</span>
        </button>
        {(['rectangle', 'circle', 'polygon'] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={tool === id ? 'active' : ''}
            aria-pressed={tool === id}
            onClick={() => setTool(id)}
          >
            {id === 'rectangle' ? (
              <Square size={17} aria-hidden="true" />
            ) : id === 'circle' ? (
              <Circle size={17} aria-hidden="true" />
            ) : (
              <Hexagon size={17} aria-hidden="true" />
            )}
            <span>{TOOL_LABELS[id]}</span>
            <kbd>{id === 'rectangle' ? 'R' : id === 'circle' ? 'C' : 'P'}</kbd>
          </button>
        ))}
        <div className="sketch-tools-separator" />
        <button type="button" disabled={!draft} onClick={() => setDraft(null)}>
          <RotateCcw size={17} aria-hidden="true" />
          <span>Clear profile</span>
        </button>
      </div>

      <aside className="sketch-setup" aria-label="Sketch setup">
        <div className="sketch-setup-header">
          <span>
            <ScanLine size={15} aria-hidden="true" />
            Sketch plane
          </span>
          <button type="button" aria-label="Cancel sketch" onClick={onCancel}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="plane-picker" role="group" aria-label="Sketch plane">
          {(Object.keys(PLANE_LABELS) as PlaneId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={plane === id ? 'active' : ''}
              aria-pressed={plane === id}
              onClick={() => setPlane(id)}
            >
              {PLANE_LABELS[id].replace(/\s\(.+\)$/, '')}
              <small>{id}</small>
            </button>
          ))}
        </div>
        <div className="sketch-setup-row">
          <span>Snap</span>
          <b>1 {units}</b>
        </div>
        <div className="sketch-setup-row">
          <span>Closed profiles</span>
          <b className={draft ? 'ready' : ''}>{draft ? '1 ready' : 'None'}</b>
        </div>
        {draft && (
          <p className="sketch-profile-summary">
            {profileSummary(draft, units)}
          </p>
        )}
        <button
          type="button"
          className="primary wide sketch-finish"
          disabled={!draft}
          onClick={finish}
        >
          <Check size={15} aria-hidden="true" />
          Finish sketch
        </button>
        <small className="sketch-enter-hint">
          Press Enter to finish · Esc to clear
        </small>
      </aside>
    </div>
  );
}
