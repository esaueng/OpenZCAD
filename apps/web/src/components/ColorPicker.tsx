import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react';
import { hexToHsv, hsvToHex, normalizeHex, type HsvColor } from '../lib/color';

/**
 * In-app HSV color picker: saturation/value pad, hue slider, hex entry, and
 * optional preset swatches. Drags stream through `onChange` and commit once
 * on pointer-up via `onCommit`, so callers can preview at pointer rate and
 * persist a single value.
 */
export function ColorPicker({
  color,
  presets = [],
  onChange,
  onCommit
}: {
  color: string;
  presets?: string[];
  onChange(color: string): void;
  onCommit(color: string): void;
}) {
  const [hsv, setHsv] = useState<HsvColor>(
    () => hexToHsv(color) ?? { h: 210, s: 0.65, v: 1 }
  );
  const [hexDraft, setHexDraft] = useState(color);
  const hsvRef = useRef(hsv);
  const draggingRef = useRef(false);
  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  // External changes (reset, undo, another body) resync the controls, except
  // mid-drag where the pointer owns the value.
  useEffect(() => {
    if (draggingRef.current) {
      return;
    }
    const parsed = hexToHsv(color);
    if (parsed) {
      hsvRef.current = parsed;
      setHsv(parsed);
    }
    setHexDraft(color);
  }, [color]);

  function emit(next: HsvColor, commit: boolean) {
    hsvRef.current = next;
    setHsv(next);
    const hex = hsvToHex(next);
    setHexDraft(hex);
    if (commit) {
      onCommit(hex);
    } else {
      onChange(hex);
    }
  }

  function padFraction(
    event: PointerEvent<HTMLDivElement>,
    el: HTMLDivElement
  ) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  }

  function updateFromSv(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    if (!svRef.current) {
      return;
    }
    const { x, y } = padFraction(event, svRef.current);
    emit({ ...hsvRef.current, s: x, v: 1 - y }, commit);
  }

  function updateFromHue(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    if (!hueRef.current) {
      return;
    }
    const { x } = padFraction(event, hueRef.current);
    emit({ ...hsvRef.current, h: x * 360 }, commit);
  }

  function commitHex() {
    const normalized = normalizeHex(hexDraft);
    if (!normalized) {
      setHexDraft(hsvToHex(hsvRef.current));
      return;
    }
    const parsed = hexToHsv(normalized);
    if (parsed) {
      hsvRef.current = parsed;
      setHsv(parsed);
    }
    setHexDraft(normalized);
    onCommit(normalized);
  }

  const svDragging = useRef(false);
  const hueDragging = useRef(false);
  // Arrow keys preview each step and commit once on release, as a pointer
  // drag does: a held key otherwise wrote one history entry per repeat.
  const keyStepped = useRef(false);
  // The arrows still down: releasing Shift, or one of two arrows, mid-step
  // committed while the other went on repeating.
  const heldArrows = useRef(new Set<string>());

  function onSliderKeyDown(
    event: KeyboardEvent<HTMLDivElement>,
    step: (current: HsvColor, dx: number, dy: number) => HsvColor
  ) {
    const amount = event.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowDown: [0, -amount],
      ArrowUp: [0, amount]
    };
    const move = delta[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    heldArrows.current.add(event.key);
    keyStepped.current = true;
    // Like a drag, the keys own the value until release: resyncing from the
    // previewed hex loses the hue of a grey.
    draggingRef.current = true;
    emit(step(hsvRef.current, move[0], move[1]), false);
  }

  function onSliderKeyUp(event: KeyboardEvent<HTMLDivElement>) {
    heldArrows.current.delete(event.key);
    if (heldArrows.current.size === 0) {
      finishKeyStep();
    }
  }

  /** Also on blur: focus leaving mid-step takes the key release with it. */
  function finishKeyStep() {
    heldArrows.current.clear();
    if (!keyStepped.current) {
      return;
    }
    keyStepped.current = false;
    draggingRef.current = false;
    onCommit(hsvToHex(hsvRef.current));
  }

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  return (
    <div className="color-picker">
      <div
        ref={svRef}
        className="color-picker-sv"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        // A two-axis pad on a one-axis role: the value is the saturation
        // (left/right), and the text names both.
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
        style={{ background: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onKeyDown={(event) =>
          onSliderKeyDown(event, (current, dx, dy) => ({
            ...current,
            s: clamp01(current.s + dx / 100),
            v: clamp01(current.v + dy / 100)
          }))
        }
        onKeyUp={onSliderKeyUp}
        onBlur={finishKeyStep}
        onPointerDown={(event) => {
          svDragging.current = true;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromSv(event, false);
        }}
        onPointerMove={(event) => {
          if (svDragging.current) {
            updateFromSv(event, false);
          }
        }}
        onPointerUp={(event) => {
          if (!svDragging.current) {
            return;
          }
          svDragging.current = false;
          draggingRef.current = false;
          updateFromSv(event, true);
        }}
      >
        <div className="color-picker-sv-white" />
        <div className="color-picker-sv-black" />
        <span
          className="color-picker-cursor"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hsvToHex(hsv)
          }}
        />
      </div>
      <div
        ref={hueRef}
        className="color-picker-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuenow={Math.round(hsv.h)}
        aria-valuemin={0}
        aria-valuemax={360}
        onKeyDown={(event) =>
          onSliderKeyDown(event, (current, dx, dy) => ({
            ...current,
            h: Math.min(360, Math.max(0, current.h + dx + dy))
          }))
        }
        onKeyUp={onSliderKeyUp}
        onBlur={finishKeyStep}
        onPointerDown={(event) => {
          hueDragging.current = true;
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromHue(event, false);
        }}
        onPointerMove={(event) => {
          if (hueDragging.current) {
            updateFromHue(event, false);
          }
        }}
        onPointerUp={(event) => {
          if (!hueDragging.current) {
            return;
          }
          hueDragging.current = false;
          draggingRef.current = false;
          updateFromHue(event, true);
        }}
      >
        <span
          className="color-picker-cursor"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            background: hsvToHex({ h: hsv.h, s: 1, v: 1 })
          }}
        />
      </div>
      <label className="color-picker-hex">
        <span>hex</span>
        <input
          value={hexDraft}
          spellCheck={false}
          onChange={(event) => {
            const raw = event.target.value;
            setHexDraft(raw);
            const normalized = normalizeHex(raw);
            if (!normalized) {
              return;
            }
            const parsed = hexToHsv(normalized);
            if (parsed) {
              hsvRef.current = parsed;
              setHsv(parsed);
            }
            onChange(normalized);
          }}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitHex();
            }
          }}
        />
      </label>
      {presets.length > 0 && (
        <div className="color-picker-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-label={`Use color ${preset}`}
              className={
                preset.toLowerCase() === color.toLowerCase() ? 'active' : ''
              }
              style={{ background: preset }}
              onClick={() => {
                const parsed = hexToHsv(preset);
                if (parsed) {
                  hsvRef.current = parsed;
                  setHsv(parsed);
                }
                setHexDraft(preset);
                onCommit(preset);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
