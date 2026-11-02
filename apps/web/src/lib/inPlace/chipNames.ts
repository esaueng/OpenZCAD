import { markKeypadOpener } from '../keypadReturnFocus';

/**
 * Spoken names for command values whose visible label is a glyph. The chip
 * and keypad keep the compact glyph; a screen reader would otherwise read
 * "⌀" as "diameter sign" at best and "R" or "×" as a bare letter.
 */
const GLYPH_NAMES: Readonly<Record<string, string>> = {
  '⌀': 'Diameter',
  R: 'Radius',
  '×': 'Scale'
};

/** A value's label as words. */
export function spokenValueName(label: string): string {
  const trimmed = label.trim();
  return (
    GLYPH_NAMES[trimmed] ??
    trimmed.replace(/⌀/g, 'diameter').replace(/\s+/g, ' ')
  );
}

/**
 * A command chip's accessible name: the value's name and its current value
 * with a spoken unit, e.g. "Diameter 6 mm" or "Angle 270 degrees". The
 * command itself is named by its command bar; leaving the title out also
 * keeps chips from answering to locators and shortcuts aimed at the
 * command's own tool button ("Fillet…").
 */
export function commandChipName(
  label: string,
  value: string,
  unit: string | undefined,
  lengthUnits: string
): string {
  const spokenUnit =
    unit === 'angle' ? 'degrees' : unit === 'length' ? lengthUnits : '';
  return [spokenValueName(label), value, spokenUnit]
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * Makes a viewport command chip a control rather than a readout: a button
 * reachable by Tab (a hidden chip drops out of the order by itself) that
 * opens its keypad on click, Enter or Space.
 */
export function prepareCommandChip(chip: HTMLElement, open: () => void): void {
  chip.setAttribute('role', 'button');
  chip.tabIndex = 0;
  chip.addEventListener('click', () => {
    markKeypadOpener(chip, false);
    open();
  });
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The workspace reads Enter (finish the command) and Space as its own
    // shortcuts; the press belongs to the chip.
    event.preventDefault();
    event.stopPropagation();
    // Opened from the keyboard, the keypad hands focus back here on close.
    markKeypadOpener(chip, true);
    open();
  });
}

/** Keeps a command chip's accessible name in step with its value. */
export function nameCommandChip(
  chip: HTMLElement,
  name: string | undefined
): void {
  if (name === undefined) {
    chip.removeAttribute('aria-label');
  } else if (chip.getAttribute('aria-label') !== name) {
    chip.setAttribute('aria-label', name);
  }
}

/**
 * A drag chip's visible text ("R 2 mm", "Total 30 mm", "12 mm") as words
 * for its accessible name: a glyph prefix is spoken, and a bare number is
 * named as the value it is.
 */
export function spokenChipText(text: string): string {
  const match = /^(.*?)(-?\d[\d.,]*)(\s?\S*)$/.exec(text.trim());
  if (!match) return text.trim();
  const [, prefix = '', number = '', units = ''] = match;
  const name = prefix.trim() ? spokenValueName(prefix) : 'Value';
  return `${name} ${number}${units}`.replace(/\s+/g, ' ').trim();
}

/**
 * The value button inside a drag chip that also holds another control (the
 * offset chip's radius/diameter switch), so the chip itself cannot be a
 * button. Its click bubbles to the chip's own handler, which opens exact
 * entry.
 */
export function createChipEntryButton(): HTMLButtonElement {
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'handle-value-entry';
  entry.addEventListener('pointerdown', () => markKeypadOpener(entry, false));
  entry.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The workspace reads Enter and Space as its own shortcuts; the
    // button's own activation still opens exact entry.
    event.stopPropagation();
    markKeypadOpener(entry, true);
  });
  return entry;
}
