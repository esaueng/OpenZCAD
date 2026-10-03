import { ArrowBigUp, Command, Option, type LucideIcon } from 'lucide-react';

/**
 * Apple's modifier glyphs, drawn rather than typeset. No Geist subset carries
 * ⌘, ⌥ or ⇧, so as text they lean on system font fallback, and a browser that
 * restricts which local fonts a page may use draws the missing-glyph box
 * instead ("2318" in a square where ⌘ belongs).
 */
const MODIFIER_ICONS: Record<string, LucideIcon> = {
  '⌘': Command,
  '⌥': Option,
  '⇧': ArrowBigUp
};

/**
 * A shortcut label as `platformShortcutLabel` writes it ("⇧⌘Z", "Ctrl+K"),
 * for the inside of a `<kbd>`. Each modifier glyph is an icon; the character
 * itself stays in the text, visually hidden, so the label still reads, copies
 * and matches as "⇧⌘Z".
 */
export function ShortcutKeys({ label }: { label: string }) {
  return (
    <>
      {Array.from(label).map((char, index) => {
        const Icon = MODIFIER_ICONS[char];
        if (!Icon) return char;
        return (
          <span key={index} className="shortcut-glyph">
            <Icon aria-hidden="true" strokeWidth={2.25} />
            <span className="visually-hidden">{char}</span>
          </span>
        );
      })}
    </>
  );
}
