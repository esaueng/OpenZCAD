import { useLayoutEffect, useRef, useState } from 'react';
import { fitMiddleEllipsis } from '../lib/middleEllipsis';

/** A tile name never takes more than this many lines. */
const TILE_NAME_LINES = 2;

let probe: HTMLDivElement | null = null;

/**
 * One hidden element, kept in the document for good, measures every tile's
 * candidates. Only its text node's data changes between measurements: a
 * character-data mutation, which no `:has()` rule observes, where inserting
 * and removing a probe per tile would be child-list churn under `body`.
 */
function measuringProbe(): HTMLDivElement {
  if (probe?.isConnected) return probe;
  probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  Object.assign(probe.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    display: 'block',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    contain: 'layout style'
  });
  probe.append(document.createTextNode(''));
  document.body.append(probe);
  return probe;
}

/**
 * The longest middle-shortened form of `name` that lays out within two lines
 * at `element`'s width and font. Lines are counted against the height of one
 * line of the same font, so a `line-height: normal` needs no arithmetic.
 */
function fitToElement(element: HTMLElement, name: string): string {
  const width = element.clientWidth;
  if (width <= 0) return name;
  const style = getComputedStyle(element);
  const box = measuringProbe();
  Object.assign(box.style, {
    width: `${width}px`,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    fontStretch: style.fontStretch,
    lineHeight: style.lineHeight,
    letterSpacing: style.letterSpacing,
    fontFeatureSettings: style.fontFeatureSettings,
    textTransform: style.textTransform
  });
  const text = box.firstChild as Text;
  text.data = 'X';
  const line = box.getBoundingClientRect().height;
  if (line <= 0) return name;
  const limit = line * (TILE_NAME_LINES + 0.5);
  const fitted = fitMiddleEllipsis(name, (candidate) => {
    text.data = candidate;
    return box.getBoundingClientRect().height <= limit;
  });
  text.data = '';
  return fitted;
}

/**
 * A library tile's name, shortened in the middle to two lines. Series names
 * ("PiKVM v3.3 Enclosure V4", "… V5") differ at their ends, which an end
 * ellipsis hid; the middle is what they share. The stylesheet's two-line
 * clamp stays as the fallback before the first measurement.
 *
 * The full name stays in the title (hover) and in the tile button's own
 * label, and it is the element's only text: the short form is drawn by the
 * stylesheet from `data-short`. A list row's keyboard focus shows it whole.
 */
export function TileName({ name }: { name: string }) {
  const ref = useRef<HTMLElement>(null);
  // Keyed by the name it was fitted for, so a rename never shows the
  // previous name's short form while the new one is measured.
  const [fitted, setFitted] = useState({ name, text: name });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let width = -1;
    const fit = () => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      const text = fitToElement(element, name);
      setFitted((previous) =>
        previous.name === name && previous.text === text
          ? previous
          : { name, text }
      );
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    // A web font arriving after the first measurement changes every width.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      width = -1;
      fit();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [name]);

  const text = fitted.name === name ? fitted.text : name;
  const shortened = text !== name;
  // The short form is drawn from `data-short` by the stylesheet, so the
  // element's text stays the full name for every reader of `textContent`.
  return (
    <strong
      ref={ref}
      className="start-tile-name"
      title={name}
      data-short={shortened ? text : undefined}
    >
      {shortened ? <span className="start-tile-name-full">{name}</span> : name}
    </strong>
  );
}
