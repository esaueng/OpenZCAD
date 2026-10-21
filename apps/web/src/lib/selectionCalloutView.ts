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
  // Armed is the chip's resting state, and the lit verb already says which
  // operation the pick carries: a "Ready" pill beside it said nothing else.
  // Every other phase is news, so it keeps its marker.
  if (operation?.phase && operation.phase !== 'armed') {
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
  // The exact check owns this pick until it answers. Switching to another
  // action or tool would leave the old operation free to commit late.
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
      verbButton.disabled = verb.disabled || validating;
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

/**
 * Every model panel drawn over the viewport: both docks' columns, the
 * floating windows, the unpinned panel beside the rail and the phone lane's
 * panel. Only what is drawn matches — a panel hidden by Hide all or
 * suspended by a sketch or a drag is not rendered — so a closed panel
 * leaves no stale obstacle. A transient panel may cover the model, but
 * nothing interactive or fitted is placed under it.
 */
export const MODEL_PANEL_OBSTACLES =
  '.panel-column, .panel-float, .panel-unpinned, .panel-lane-float';

/** The model panels that stand in the right lane, beside the inspector. */
export const RIGHT_LANE_MODEL_PANELS =
  '.panel-column[data-side="right"], .panel-unpinned, .panel-lane-float';

/**
 * The panels floating over the viewport that a selection chip must not
 * slide under: the right lane (inspector, command card), the model panels,
 * the left column and palette, and the instrument rail. Under one of them
 * the chip's verbs and its operation's way out would be drawn but not
 * pressable — the column-top chip it replaced always sat in the lane, so it
 * never had to avoid it.
 */
export const SELECTION_CALLOUT_OBSTACLES = `.stage-right > *, ${MODEL_PANEL_OBSTACLES}, .palette-float, .workspace-column-float, .instrument-rail`;

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
  // Include combinations: clearing a handle sideways can otherwise put the
  // chip under a panel that was not intersecting its original position.
  const xs = new Set([0, bounds.left - chip.left, bounds.right - chip.right]);
  const ys = new Set([0, bounds.top - chip.top, bounds.bottom - chip.bottom]);
  for (const panel of panels) {
    xs.add(panel.left - gap - chip.right);
    xs.add(panel.right + gap - chip.left);
    ys.add(panel.top - gap - chip.bottom);
    ys.add(panel.bottom + gap - chip.top);
  }
  const candidates = [...xs].flatMap((dx) => [...ys].map((dy) => ({ dx, dy })));
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
 * One offset for viewport, chrome, panels and the drag handle together.
 * The chip is the original projected rectangle, including its CSS margin.
 * On constrained screens, preserve the viewport and minimize covered area.
 */
export function selectionCalloutPlacement(
  chip: ScreenRect,
  bounds: ScreenRect,
  obstacles: readonly ScreenRect[],
  valueChip: ScreenRect | null
): { dx: number; dy: number } {
  const dx = Math.max(
    bounds.left - chip.left,
    Math.min(0, bounds.right - chip.right)
  );
  const dy = Math.max(
    bounds.top - chip.top,
    Math.min(0, bounds.bottom - chip.bottom)
  );
  const panels = valueChip
    ? [
        ...obstacles,
        {
          left: valueChip.left - HANDLE_KEEP_OUT_PX,
          right: valueChip.right + HANDLE_KEEP_OUT_PX,
          top: valueChip.top - HANDLE_KEEP_OUT_PX,
          bottom: valueChip.bottom + HANDLE_KEEP_OUT_PX
        }
      ]
    : obstacles;
  const shift = selectionCalloutObstacleShift(
    {
      left: chip.left + dx,
      right: chip.right + dx,
      top: chip.top + dy,
      bottom: chip.bottom + dy
    },
    panels,
    bounds
  );
  return { dx: dx + shift.dx, dy: dy + shift.dy };
}

/**
 * Places selection chips once after CSS2DRenderer. All constraints use the
 * original projected rectangle, recovered by removing our previous translate.
 * A separate handle translate and viewport margin used to feed each other's
 * corrections back into the next frame, making a stationary chip jump.
 * CSS margins remain part of the anchor; this is its only positioning writer.
 */
export function placeSelectionCallouts(container: HTMLElement): void {
  const elements = container.querySelectorAll<HTMLElement>(
    `.${SELECTION_CALLOUT_CHIP_CLASS}`
  );
  if (elements.length === 0) {
    return;
  }
  const scope = container.closest('.viewer-shell') ?? container.ownerDocument;
  const valueChip =
    scope
      .querySelector<HTMLElement>('.handle-value-chip:not([hidden])')
      ?.getBoundingClientRect() ?? null;
  const rect = container.getBoundingClientRect();
  const topbar = container.ownerDocument.querySelector('.app-shell > .topbar');
  const bounds = {
    left: rect.left + 4,
    right: rect.right - 4,
    top:
      Math.max(rect.top, topbar?.getBoundingClientRect().bottom ?? rect.top) +
      4,
    bottom: rect.bottom - 4
  };
  const obstacles = [
    ...(container
      .closest('.viewer-area')
      ?.querySelectorAll<HTMLElement>(SELECTION_CALLOUT_OBSTACLES) ?? [])
  ].map((element) => element.getBoundingClientRect());
  // Read every rectangle before writing, so multiple chips share one layout.
  const placements = [...elements].map((element) => {
    const [x, y] = element.style.translate.split(/\s+/);
    const dx = Number.parseFloat(x ?? '') || 0;
    const dy = Number.parseFloat(y ?? '') || 0;
    const rect = element.getBoundingClientRect();
    const shift = selectionCalloutPlacement(
      {
        left: rect.left - dx,
        right: rect.right - dx,
        top: rect.top - dy,
        bottom: rect.bottom - dy
      },
      bounds,
      obstacles,
      valueChip
    );
    return { element, shift };
  });
  for (const { element, shift } of placements) {
    const translate = shift.dx || shift.dy ? `${shift.dx}px ${shift.dy}px` : '';
    if (element.style.translate !== translate) {
      element.style.translate = translate;
    }
  }
}
