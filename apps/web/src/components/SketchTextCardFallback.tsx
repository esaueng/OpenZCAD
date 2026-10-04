/**
 * The text card's stand-in while its chunk loads.
 *
 * `T` opens the card at once, and someone about to type does not wait for a
 * network fetch: on a cold cache the lazy card can arrive after the first
 * letters, which would otherwise reach the workspace's single-key shortcuts
 * and switch tools. This field is synchronous and takes focus immediately; it
 * writes straight into the shared draft, so the card shows what was typed the
 * moment it mounts and takes the caret over from here.
 */
import { useEffect, useRef } from 'react';

interface SketchTextCardFallbackProps {
  text: string;
  onText(text: string): void;
}

export function SketchTextCardFallback({
  text,
  onText
}: SketchTextCardFallbackProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="sketch-entity-dock">
      <div className="sketch-entity-editor sketch-text-card">
        <label className="field">
          <span>Text</span>
          <input
            ref={inputRef}
            type="text"
            value={text}
            spellCheck={false}
            onChange={(event) => onText(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
