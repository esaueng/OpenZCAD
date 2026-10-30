import { formatDiameter, type LabelSegment } from './topologyLabels';

/**
 * Renders segmented names (see {@link LabelSegment}) so a drag can rewrite the
 * number inside a label without knowing the wording around it.
 *
 * A cylinder radius drag has to move the diameter shown in the viewport
 * callout and the selection chip while the document still holds the old value.
 * It used to do that by running a regex over the rendered text, which silently
 * stopped working for any face whose name took a different branch of
 * `faceLabel` — a through hole, say — and would have broken outright on a
 * wording change. The number now lives in its own node, tagged with the
 * document value it came from, and only that node is rewritten.
 */

/**
 * Marks the node holding a live diameter. Its value is the document diameter,
 * so a finished or cancelled drag restores the label without re-deriving it.
 */
export const LIVE_DIAMETER_ATTRIBUTE = 'data-live-diameter';

/**
 * Marks a measurement line ("Ø 24 mm") whose diameter a drag rewrites. Its
 * value is the document diameter; `data-units` keeps the unit it printed.
 */
export const LIVE_DIAMETER_DETAIL_ATTRIBUTE = 'data-live-diameter-detail';

/** A measurement line's spelling of a diameter, as the readout prints it. */
export function formatDiameterDetail(diameter: number, units: string): string {
  return `Ø ${Math.round(diameter * 100) / 100} ${units}`;
}

/** Tags a measurement line so a drag can rewrite its diameter in place. */
export function tagLiveDiameterDetail(
  element: HTMLElement,
  value: { diameter: number; units: string }
): void {
  element.setAttribute(LIVE_DIAMETER_DETAIL_ATTRIBUTE, String(value.diameter));
  element.dataset.units = value.units;
}

/** Fills `element` with `segments`, tagging the live-diameter node. */
export function renderLabelSegments(
  element: HTMLElement,
  segments: readonly LabelSegment[]
): void {
  const owner = element.ownerDocument;
  element.replaceChildren(
    ...segments.map((segment) => {
      if (segment.kind === 'text') {
        return owner.createTextNode(segment.text);
      }
      const node = owner.createElement('span');
      node.setAttribute(LIVE_DIAMETER_ATTRIBUTE, String(segment.diameter));
      node.textContent = formatDiameter(segment.diameter);
      return node;
    })
  );
}

/**
 * Shows `diameter` in every live-diameter node under `root`; `null` restores
 * the document value each node was rendered with.
 */
export function setLiveDiameter(
  root: ParentNode,
  diameter: number | null
): void {
  for (const node of root.querySelectorAll<HTMLElement>(
    `[${LIVE_DIAMETER_ATTRIBUTE}]`
  )) {
    const value =
      diameter ?? Number(node.getAttribute(LIVE_DIAMETER_ATTRIBUTE));
    if (!Number.isFinite(value)) {
      continue;
    }
    node.textContent = formatDiameter(value);
  }
  // The measurement line beside the name: a hole's name carries no number
  // ("Through hole"), so without this the bar held the old size for the
  // whole of a drag the viewport projected.
  for (const node of root.querySelectorAll<HTMLElement>(
    `[${LIVE_DIAMETER_DETAIL_ATTRIBUTE}]`
  )) {
    const value =
      diameter ?? Number(node.getAttribute(LIVE_DIAMETER_DETAIL_ATTRIBUTE));
    if (!Number.isFinite(value)) {
      continue;
    }
    node.textContent = formatDiameterDetail(value, node.dataset.units ?? '');
  }
}
