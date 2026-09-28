import type {
  SelectionActionId,
  SelectionCapability
} from './interaction/capabilities';
import { renderLabelSegments } from './liveLabels';
import type { LabelSegment } from './topologyLabels';
import {
  TOOL_META,
  toolDisabledReason,
  toolTitle,
  type ToolAvailability,
  type ToolId
} from './tools';

/**
 * The one surface that answers "what did I pick, and what can I do with it":
 * a compact chip anchored to the pick in the viewport. It names the entity,
 * gives its key measurement, and offers the two or three verbs that act on
 * that kind of pick. It replaced three surfaces that each said part of this
 * — a name-only viewport label, a bottom-lane chip with the measurement,
 * and an inspector fallback that only said nothing could be edited.
 *
 * The viewer builds the chip's element (it is a CSS2D label, positioned
 * every frame); this module fills it, so the markup and the verb choice are
 * testable without a WebGL context.
 */

/** A verb is either a selection action the tool card also offers, or a tool. */
export type SelectionCalloutVerbId =
  `action:${SelectionActionId}` | `tool:${ToolId}`;

export interface SelectionCalloutVerb {
  id: SelectionCalloutVerbId;
  label: string;
  /** Tooltip: what the verb does, or why it cannot run. */
  title: string;
  disabled: boolean;
  /** The verb is the operation already armed on the pick. */
  pressed: boolean;
}

export interface SelectionCalloutContent {
  /**
   * The name to show. Null keeps the viewer's own name for the pick (the
   * body, and the face or edge on it).
   */
  label: readonly LabelSegment[] | null;
  /** The key measurement: area or diameter, length, or overall size. */
  detail?: string;
  verbs: readonly SelectionCalloutVerb[];
  /**
   * Where the chip hangs: over the selected body, or over the geometry a
   * History row brought into focus when no body is selected.
   */
  anchor: 'selection' | 'focus';
  onVerb(id: SelectionCalloutVerbId): void;
  /** Clears the selection; absent where there is nothing to clear. */
  onClear?: (() => void) | undefined;
}

export type SelectionCalloutKind = 'face' | 'edges' | 'body' | 'bodies';

export interface SelectionCalloutVerbInput {
  kind: SelectionCalloutKind;
  /**
   * The face's own capabilities while the interaction machine holds the
   * face (the same list the tool card draws its actions from). Absent when
   * the machine is not on the face, so only tools can be offered.
   */
  faceCapabilities?: readonly SelectionCapability[] | null;
  /** The machine holds the picked edges, so Fillet/Chamfer switch its op. */
  edgesArmed?: boolean;
  /** The selection action already armed, drawn pressed. */
  pressedAction?: SelectionActionId | null;
  availability: ToolAvailability;
}

/** Enough to act on the pick without turning the chip into a toolbar. */
export const MAX_SELECTION_VERBS = 3;

/** Shorter names for actions whose tool-card label repeats the pick. */
const ACTION_LABELS: Partial<Record<SelectionActionId, string>> = {
  'offset-face': 'Offset',
  'sketch-on-face': 'Sketch',
  'resize-radial-face': 'Radius'
};

function actionVerb(
  capability: SelectionCapability,
  pressedAction: SelectionActionId | null | undefined
): SelectionCalloutVerb {
  return {
    id: `action:${capability.action}`,
    label: ACTION_LABELS[capability.action] ?? capability.label,
    title: capability.disabledReason ?? capability.note ?? capability.label,
    disabled: !capability.enabled,
    pressed: pressedAction === capability.action
  };
}

function toolVerb(
  tool: ToolId,
  availability: ToolAvailability
): SelectionCalloutVerb {
  return {
    id: `tool:${tool}`,
    label: TOOL_META[tool].label,
    title: toolTitle(tool, availability),
    disabled: toolDisabledReason(tool, availability) !== null,
    pressed: false
  };
}

function edgeVerb(
  op: 'fillet' | 'chamfer',
  input: SelectionCalloutVerbInput
): SelectionCalloutVerb {
  if (!input.edgesArmed) {
    return toolVerb(op, input.availability);
  }
  return {
    id: `action:${op}`,
    label: TOOL_META[op].label,
    title: TOOL_META[op].hint,
    disabled: false,
    pressed: input.pressedAction === op
  };
}

/**
 * The verbs for a pick, in the order they are usually reached for:
 * a face offers its own edit (Offset, or Radius on a cylinder), Sketch and
 * Hole; edges offer Fillet and Chamfer; a body Move and Mirror; several
 * bodies Union first. At most {@link MAX_SELECTION_VERBS}.
 */
export function selectionCalloutVerbs(
  input: SelectionCalloutVerbInput
): SelectionCalloutVerb[] {
  const { availability } = input;
  let verbs: SelectionCalloutVerb[];
  switch (input.kind) {
    case 'face': {
      const capabilities = input.faceCapabilities ?? [];
      if (capabilities.length === 0) {
        verbs = [
          toolVerb('sketch', availability),
          toolVerb('hole', availability)
        ];
        break;
      }
      verbs = capabilities.map((capability) =>
        actionVerb(capability, input.pressedAction)
      );
      // A face that takes a sketch is planar, and a planar face takes a hole.
      if (
        capabilities.some(
          (capability) => capability.action === 'sketch-on-face'
        )
      ) {
        verbs.push(toolVerb('hole', availability));
      }
      break;
    }
    case 'edges':
      verbs = [edgeVerb('fillet', input), edgeVerb('chamfer', input)];
      break;
    case 'body':
      verbs = [
        toolVerb('transform', availability),
        toolVerb('mirror', availability)
      ];
      break;
    case 'bodies':
      verbs = [
        toolVerb('union', availability),
        toolVerb('transform', availability),
        toolVerb('mirror', availability)
      ];
      break;
  }
  return verbs.slice(0, MAX_SELECTION_VERBS);
}

/** Class the viewer's name label takes while it carries the full chip. */
export const SELECTION_CALLOUT_CHIP_CLASS = 'selection-callout-chip';

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
 * became available, or the armed one changed — without rebuilding the
 * viewport overlays around it.
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
  if (!content) {
    element.classList.remove(SELECTION_CALLOUT_CHIP_CLASS);
    element.removeAttribute('role');
    element.removeAttribute('aria-label');
    element.replaceChildren(...children);
    return;
  }
  element.classList.add(SELECTION_CALLOUT_CHIP_CLASS);
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', 'Selection');
  if (content.detail) {
    const detail = owner.createElement('span');
    detail.className = 'selection-callout-detail';
    detail.textContent = content.detail;
    children.push(detail);
  }
  if (content.verbs.length > 0) {
    const verbs = owner.createElement('span');
    verbs.className = 'selection-callout-verbs';
    for (const verb of content.verbs) {
      const button = owner.createElement('button');
      button.type = 'button';
      button.className = 'selection-callout-verb';
      button.textContent = verb.label;
      button.title = verb.title;
      // Named for what it acts on, so it never shares a name with the rail
      // button or tool-card action of the same verb.
      button.setAttribute('aria-label', `Selection: ${verb.label}`);
      button.disabled = verb.disabled;
      button.setAttribute('aria-pressed', String(verb.pressed));
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        content.onVerb(verb.id);
      });
      verbs.append(button);
    }
    children.push(verbs);
  }
  if (content.onClear) {
    const onClear = content.onClear;
    const clear = owner.createElement('button');
    clear.type = 'button';
    clear.className = 'selection-callout-clear';
    clear.title = 'Deselect all (Esc)';
    clear.setAttribute('aria-label', 'Deselect all');
    clear.textContent = '×';
    clear.addEventListener('click', (event) => {
      event.stopPropagation();
      onClear();
    });
    children.push(clear);
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
