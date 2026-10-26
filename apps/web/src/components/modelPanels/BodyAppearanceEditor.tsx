import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  BODY_COLOR_PRESETS,
  DEFAULT_BODY_COLOR,
  type BodyRepresentation
} from '@openzcad/shared';
import { ColorPicker } from '../ColorPicker';
import type { BodyAppearancePreview } from '../ModelViewer';

export interface BodyAppearancePatch {
  color?: string | null;
  opacity?: number | null;
}

/** The Objects row owns the editor; previews never write document history. */
export function BodyAppearanceEditor({
  body,
  anchorRef,
  onPreview,
  onCommit,
  onDismiss
}: {
  body: BodyRepresentation;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onPreview(preview: BodyAppearancePreview | null): void;
  onCommit(patch: BodyAppearancePatch): void;
  onDismiss(restoreFocus: boolean): void;
}) {
  const [color, setColor] = useState(body.color);
  const [opacity, setOpacity] = useState(body.opacity ?? 1);
  const committed = useRef({ color: body.color, opacity: body.opacity ?? 1 });
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 8, y: 8 });

  // Follow the row as its panel moves or scrolls, outside the dock's clipping.
  useLayoutEffect(() => {
    let frame = 0;
    let placed = '';
    function place() {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = anchorRef.current
        ?.closest('.model-panel')
        ?.getBoundingClientRect();
      const editor = contentRef.current?.getBoundingClientRect();
      if (anchor && editor) {
        const edge = panel ?? anchor;
        const roomRight =
          edge.right + 10 + editor.width <= window.innerWidth - 8;
        const roomLeft = edge.left - 10 - editor.width >= 8;
        const x = Math.max(
          8,
          Math.min(
            roomRight
              ? edge.right + 10
              : roomLeft
                ? edge.left - editor.width - 10
                : anchor.right - editor.width,
            window.innerWidth - editor.width - 8
          )
        );
        const y = Math.max(
          8,
          Math.min(
            roomRight || roomLeft ? anchor.top : anchor.bottom + 8,
            window.innerHeight - editor.height - 8
          )
        );
        if (`${x},${y}` !== placed) {
          placed = `${x},${y}`;
          setPosition({ x, y });
        }
      }
      frame = requestAnimationFrame(place);
    }
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchorRef]);

  useEffect(() => {
    committed.current = { color: body.color, opacity: body.opacity ?? 1 };
    setColor(body.color);
    setOpacity(body.opacity ?? 1);
  }, [body.color, body.opacity]);

  function commit(nextColor = color) {
    onPreview(null);
    const patch: BodyAppearancePatch = {};
    if (nextColor.toLowerCase() !== committed.current.color.toLowerCase()) {
      patch.color = nextColor;
    }
    if (opacity !== committed.current.opacity) {
      patch.opacity = opacity >= 1 ? null : opacity;
    }
    if (Object.keys(patch).length === 0) return;
    committed.current = { color: nextColor, opacity };
    onCommit(patch);
  }

  function dismiss(restoreFocus: boolean) {
    commit();
    onDismiss(restoreFocus);
  }
  const latest = useRef({ dismiss, onPreview });
  latest.current = { dismiss, onPreview };

  useEffect(() => {
    contentRef.current?.querySelector('input')?.focus();
    function onPointerDown(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !contentRef.current?.contains(event.target) &&
        !anchorRef.current?.contains(event.target)
      ) {
        latest.current.dismiss(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.dismiss(true);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
      // Filtering, collapsing a folder or closing the panel also ends a preview.
      latest.current.onPreview(null);
    };
  }, [anchorRef]);

  const isDefault =
    color.toLowerCase() === DEFAULT_BODY_COLOR.toLowerCase() && opacity >= 1;
  return createPortal(
    <div
      ref={contentRef}
      id={`body-appearance-${body.bodyId}`}
      className="object-appearance"
      style={{ left: position.x, top: position.y }}
      role="group"
      aria-label={`Appearance of ${body.name}`}
    >
      <div className="object-appearance-heading">
        <span>
          {body.name}
          <small>Color & opacity</small>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label={`Close appearance of ${body.name}`}
          onClick={() => dismiss(true)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <ColorPicker
        color={color}
        presets={BODY_COLOR_PRESETS}
        onChange={(nextColor) => {
          setColor(nextColor);
          onPreview({ bodyId: body.bodyId, color: nextColor });
        }}
        onCommit={(nextColor) => {
          setColor(nextColor);
          commit(nextColor);
        }}
      />
      <label className="appearance-field">
        <span>Opacity</span>
        <span className="appearance-inputs">
          <input
            type="range"
            aria-label={`Opacity of ${body.name}`}
            min={0.05}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(event) => {
              const nextOpacity = Number(event.target.value);
              setOpacity(nextOpacity);
              onPreview({ bodyId: body.bodyId, opacity: nextOpacity });
            }}
            onPointerUp={() => commit()}
            onKeyUp={() => commit()}
            onBlur={() => commit()}
          />
          <span className="appearance-value">{Math.round(opacity * 100)}%</span>
        </span>
      </label>
      <button
        type="button"
        className="appearance-reset"
        disabled={isDefault}
        onClick={() => {
          onPreview(null);
          committed.current = { color: DEFAULT_BODY_COLOR, opacity: 1 };
          setColor(DEFAULT_BODY_COLOR);
          setOpacity(1);
          onCommit({ color: null, opacity: null });
        }}
      >
        Reset to default
      </button>
    </div>,
    document.body
  );
}
