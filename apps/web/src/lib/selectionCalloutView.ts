import type { OperationPhase } from './interaction/machine';
import { renderLabelSegments } from './liveLabels';
import type {
  SelectionCalloutContent,
  SelectionCalloutOperation
} from './selectionCallout';
import type { LabelSegment } from './topologyLabels';

/**
 * Builds the selection chip `selectionCallout` describes. Only the viewer
 * (a lazy chunk) imports this, so none of the markup rides the entry chunk.
 */

/** Class the viewer's name label takes while it carries the full chip. */
export const SELECTION_CALLOUT_CHIP_CLASS = 'selection-callout-chip';

/** What an operation's phase is called wherever it is shown. */
export const OPERATION_PHASE_LABELS: Record<OperationPhase, string> = {
  armed: 'Ready',
  dragging: 'Dragging',
  'exact-entry': 'Exact entry',
  validating: 'Validating',
  failed: 'Failed'
};

const fallbackLabels = new WeakMap<HTMLElement, readonly LabelSegment[]>();

/**
 * Fills a freshly built selection label. `fallbackLabel` is the viewer's own
 * name for the pick, used whenever the content does not name it.
 */
export function renderSelectionCallout(
  element: HTMLElement,
  fallbackLabel: readonly LabelSegment[],
  content: SelectionCalloutContent | null | undefined
): void {
  fallbackLabels.set(element, fallbackLabel);
  fill(element, fallbackLabel, content);
}

/**
 * Refills a label already on screen when only the content changed — a verb
 * became available, the armed one changed, the operation moved to its next
 * phase — without rebuilding the viewport overlays around it.
 */
export function refreshSelectionCallout(
  element: HTMLElement,
  content: SelectionCalloutContent | null | undefined
): void {
  const fallback = fallbackLabels.get(element);
  if (fallback) {
    fill(element, fallback, content);
  }
}

function button(
  owner: Document,
  className: string,
  label: string,
  onClick: () => void
): HTMLButtonElement {
  const element = owner.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

/** The phase marker: a named pill, or a bare dot while the drag is live. */
function phaseMarker(owner: Document, phase: OperationPhase): HTMLElement {
  const label = OPERATION_PHASE_LABELS[phase];
  const marker = owner.createElement('span');
  if (phase === 'dragging') {
    // Collapsed while the hand is on the handle, as the card did: the value
    // chip on the handle is what is being read then.
    marker.className = 'selection-callout-phase-dot';
    marker.setAttribute('aria-label', label);
    marker.title = label;
    return marker;
  }
  marker.className = `selection-callout-phase phase-${phase}`;
  marker.textContent = label;
  return marker;
}

/** The refusal and its ways out, on a row of its own under the chip. */
function diagnostic(
  owner: Document,
  operation: SelectionCalloutOperation
): HTMLElement | null {
  const error = operation.error;
  if (!error) {
    return null;
  }
  const row = owner.createElement('span');
  row.className = 'selection-callout-diagnostic';
  row.setAttribute('role', 'alert');
  const message = owner.createElement('span');
  message.className = 'selection-callout-error';
  message.textContent = error.message;
  row.append(message);
  const culprit = error.culprit;
  if (culprit) {
    row.append(
      button(
        owner,
        'selection-callout-recovery',
        `Edit ${culprit.featureName}`,
        () => operation.onEditCulprit(culprit.featureId)
      )
    );
  }
  if (operation.keepLastValidLabel) {
    row.append(
      button(
        owner,
        'selection-callout-recovery',
        operation.keepLastValidLabel,
        operation.onKeepLastValid
      )
    );
  }
  if (error.detail) {
    row.append(
      button(
        owner,
        'selection-callout-recovery',
        'View details',
        operation.onViewDetails
      )
    );
  }
  return row;
}

function fill(
  element: HTMLElement,
  fallbackLabel: readonly LabelSegment[],
  content: SelectionCalloutContent | null | undefined
) {
  const owner = element.ownerDocument;
  const name = owner.createElement('span');
  name.className = 'selection-callout-name';
  renderLabelSegments(name, content?.label ?? fallbackLabel);
  const children: HTMLElement[] = [name];
  element.removeAttribute('aria-busy');
  if (!content) {
    element.classList.remove(SELECTION_CALLOUT_CHIP_CLASS);
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    element.replaceChildren(...children);
    return;
  }
  element.classList.add(SELECTION_CALLOUT_CHIP_CLASS);
  const operation = content.operation;
  if (operation) {
    // Announced as the operation it now carries, under the name the
    // column-top chip had, so "the Resize Body operation" is still one
    // region whichever surface draws it.
    element.setAttribute('role', 'region');
    element.setAttribute('aria-label', `${operation.title} operation`);
    if (operation.phase === 'validating') {
      element.setAttribute('aria-busy', 'true');
    }
  } else {
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Selection');
  }
  if (content.detail) {
    const detail = owner.createElement('span');
    detail.className = 'selection-callout-detail';
    detail.textContent = content.detail;
    children.push(detail);
  }
  if (operation?.phase) {
    children.push(phaseMarker(owner, operation.phase));
  }
  if (operation?.badge) {
    const badge = owner.createElement('span');
    badge.className = 'selection-callout-badge';
    badge.tabIndex = 0;
    badge.setAttribute('aria-label', operation.badge.label);
    badge.title = operation.badge.detail;
    badge.textContent = 'Anchored';
    children.push(badge);
  }
  // A running check cannot be switched mid-flight, as the card's switch
  // could not be; tools (Sketch, Hole) open their own card and stay live.
  const validating = operation?.phase === 'validating';
  if (content.verbs.length > 0 || operation?.selectAllEdgesCount) {
    const verbs = owner.createElement('span');
    verbs.className = 'selection-callout-verbs';
    for (const verb of content.verbs) {
      const verbButton = button(
        owner,
        'selection-callout-verb',
        verb.label,
        () => content.onVerb(verb.id)
      );
      verbButton.title = verb.title;
      // Named for what it acts on, so it never shares a name with the rail
      // button or tool-card action of the same verb.
      verbButton.setAttribute('aria-label', `Selection: ${verb.label}`);
      verbButton.disabled =
        verb.disabled || (validating && verb.id.startsWith('action:'));
      verbButton.setAttribute('aria-pressed', String(verb.pressed));
      verbs.append(verbButton);
    }
    const count = operation?.selectAllEdgesCount;
    if (operation && count) {
      const selectAll = button(
        owner,
        'selection-callout-verb',
        `All ${count} edges`,
        operation.onSelectAllEdges
      );
      selectAll.setAttribute('aria-label', `Select all ${count} edges`);
      selectAll.disabled = validating;
      verbs.append(selectAll);
    }
    children.push(verbs);
  }
  if (content.onClear) {
    const clear = button(
      owner,
      'selection-callout-clear',
      '×',
      content.onClear
    );
    clear.title = 'Deselect all (Esc)';
    clear.setAttribute('aria-label', 'Deselect all');
    // A value being validated stays locked: the commit owns the model until
    // it answers (escapeTarget gives Escape nothing to do then), as the
    // card's close button did. Clearing here mid-check let the answer land
    // after the pick was dismissed — committing it and reselecting the body.
    clear.disabled = validating;
    children.push(clear);
  }
  const refusal = operation ? diagnostic(owner, operation) : null;
  if (refusal) {
    children.push(refusal);
  }
  element.replaceChildren(...children);
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

/**
 * The panels floating over the viewport that a selection chip must not
 * slide under: the right lane (inspector, drawer, command card), the left
 * column and palette, and the instrument rail. Under one of them the chip's
 * verbs and its operation's way out would be drawn but not pressable — the
 * column-top chip it replaced always sat in the lane, so it never had to
 * avoid it.
 */
export const SELECTION_CALLOUT_OBSTACLES =
  '.stage-right > *, .palette-float, .workspace-column-float, .instrument-rail';

/**
 * The smallest move that takes a chip out from under every obstacle and
 * keeps it inside `bounds`: sideways off the panel's edge, or above or
 * below it when the panel spans the viewport (a phone's drawer). Zero when
 * the chip is already clear, or when no single move clears it.
 */
export function selectionCalloutObstacleShift(
  chip: ScreenRect,
  obstacles: readonly ScreenRect[],
  bounds: ScreenRect,
  gap = 6
): { dx: number; dy: number } {
  const panels = obstacles.filter(
    (obstacle) =>
      obstacle.right > obstacle.left && obstacle.bottom > obstacle.top
  );
  const moved = ({ dx, dy }: { dx: number; dy: number }): ScreenRect => ({
    left: chip.left + dx,
    right: chip.right + dx,
    top: chip.top + dy,
    bottom: chip.bottom + dy
  });
  // How much of the chip panels cover: on a phone not every panel can be
  // cleared at once, and the least covered place is the best one left.
  const covered = (rect: ScreenRect) =>
    panels.reduce(
      (area, panel) =>
        area +
        Math.max(
          0,
          Math.min(rect.right, panel.right) - Math.max(rect.left, panel.left)
        ) *
          Math.max(
            0,
            Math.min(rect.bottom, panel.bottom) - Math.max(rect.top, panel.top)
          ),
      0
    );
  const stay = { dx: 0, dy: 0 };
  const now = covered(chip);
  if (now === 0) {
    return stay;
  }
  const candidates: { dx: number; dy: number }[] = [];
  for (const panel of panels.filter((candidate) => overlaps(chip, candidate))) {
    candidates.push(
      { dx: panel.left - gap - chip.right, dy: 0 },
      { dx: panel.right + gap - chip.left, dy: 0 },
      { dx: 0, dy: panel.top - gap - chip.bottom },
      { dx: 0, dy: panel.bottom + gap - chip.top }
    );
  }
  let best = stay;
  let bestCovered = now;
  for (const candidate of candidates) {
    const rect = moved(candidate);
    if (
      rect.left < bounds.left ||
      rect.right > bounds.right ||
      rect.top < bounds.top ||
      rect.bottom > bounds.bottom
    ) {
      continue;
    }
    const area = covered(rect);
    if (
      area < bestCovered ||
      (area === bestCovered &&
        best !== stay &&
        Math.hypot(candidate.dx, candidate.dy) < Math.hypot(best.dx, best.dy))
    ) {
      best = candidate;
      bestCovered = area;
    }
  }
  return best;
}

/**
 * How far the drag handle's arrow can reach from its value chip: the chip
 * sits 44 px from the arrow's pin and the shaft runs back from the pin, so
 * this much margin around the value chip covers the whole arrow.
 */
export const HANDLE_KEEP_OUT_PX = 100;

/**
 * The vertical shift that keeps the selection chip off a drag handle.
 *
 * The chip hangs over the pick and the handle grows out of it, so in some
 * views they land on the same pixels — and a verb button over the arrow
 * takes the press meant for the drag. `chip` is the chip's box without any
 * shift, `valueChip` the handle's value chip. The chip moves above the
 * keep-out zone, or below it when above would leave the viewport; zero when
 * they do not meet.
 */
export function selectionCalloutClearance(
  chip: ScreenRect,
  valueChip: ScreenRect,
  viewport: ScreenRect,
  keepOut = HANDLE_KEEP_OUT_PX
): number {
  const zone = {
    left: valueChip.left - keepOut,
    top: valueChip.top - keepOut,
    right: valueChip.right + keepOut,
    bottom: valueChip.bottom + keepOut
  };
  const meets =
    chip.left < zone.right &&
    chip.right > zone.left &&
    chip.top < zone.bottom &&
    chip.bottom > zone.top;
  if (!meets) {
    return 0;
  }
  const gap = 4;
  const up = zone.top - gap - chip.bottom;
  if (chip.top + up >= viewport.top + gap) {
    return up;
  }
  return zone.bottom + gap - chip.top;
}

/**
 * Applies {@link selectionCalloutClearance} to a chip on screen. Run after
 * the label renderer places the chip each frame; the shift rides the CSS
 * `translate` property, which composes with the renderer's inline transform
 * and the edge clamp's margins instead of fighting them.
 */
export function keepSelectionCalloutClear(element: HTMLElement): void {
  if (!element.classList.contains(SELECTION_CALLOUT_CHIP_CLASS)) {
    return;
  }
  const scope = element.closest('.viewer-shell') ?? element.ownerDocument;
  const valueChip = scope.querySelector<HTMLElement>(
    '.handle-value-chip:not([hidden])'
  );
  const current = Number.parseFloat(
    element.style.translate.split(' ')[1] ?? '0'
  );
  const shift = Number.isFinite(current) ? current : 0;
  let next = 0;
  const container = element.parentElement;
  if (valueChip && container) {
    const rect = element.getBoundingClientRect();
    next = selectionCalloutClearance(
      {
        left: rect.left,
        right: rect.right,
        top: rect.top - shift,
        bottom: rect.bottom - shift
      },
      valueChip.getBoundingClientRect(),
      container.getBoundingClientRect()
    );
  }
  if (Math.abs(next - shift) > 0.5) {
    element.style.translate = next ? `0 ${next}px` : '';
  }
}
