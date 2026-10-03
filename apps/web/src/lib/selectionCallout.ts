import type {
  SelectionActionId,
  SelectionCapability
} from './interaction/capabilities';
import type { CommandDiagnostic, OperationPhase } from './interaction/machine';
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
 * A pick that arms an operation (a face's offset or resize, an edge's
 * fillet) also carries that operation here: its phase, its refusal and the
 * way out of it. That used to be a second chip at the top of the column,
 * one more surface lit for the same pick (design review F11).
 *
 * This module chooses what the chip says; `selectionCalloutView` builds it
 * (it is a CSS2D label the viewer positions every frame), so the markup is
 * testable without a WebGL context and stays out of the entry chunk.
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
  /** The operation the pick has armed, when it has armed one. */
  operation?: SelectionCalloutOperation | undefined;
}

/**
 * What the column-top operation chip used to say, said on the pick instead:
 * which phase the operation is in, why it refused and how to recover. Its
 * Fillet/Chamfer or Resize/Offset switch is the chip's own pressed verbs.
 */
export interface SelectionCalloutOperation {
  /** "Resize Body": the chip is announced as the "Resize Body operation". */
  title: string;
  phase?: OperationPhase | undefined;
  /** Context behind a named marker, such as a hash-anchored offset. */
  badge?: { label: string; detail: string } | undefined;
  error?: CommandDiagnostic | undefined;
  /** "Keep 4 mm": commits the value the last passing preview showed. */
  keepLastValidLabel?: string | undefined;
  /** Edges on the body, when not all of them are picked yet. */
  selectAllEdgesCount?: number | undefined;
  onEditCulprit(featureId: string): void;
  onViewDetails(): void;
  onKeepLastValid(): void;
  onSelectAllEdges(): void;
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
  /**
   * The face's body can be resized from it (a primitive's face), which is
   * the edit a face drag makes first; Offset then moves the face alone.
   */
  resizeBody?: boolean;
  /** The selection action already armed, drawn pressed. */
  pressedAction?: SelectionActionId | null;
  availability: ToolAvailability;
}

/**
 * Enough to act on the pick without turning the chip into a toolbar: a
 * primitive's face needs four (Resize, Offset, Sketch, Hole), every other
 * pick three or fewer.
 */
export const MAX_SELECTION_VERBS = 4;

/** Shorter names for actions whose tool-card label repeats the pick. */
const ACTION_LABELS: Partial<Record<SelectionActionId, string>> = {
  'resize-body': 'Resize',
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
 * a face offers its own edit (Resize and Offset on a primitive, Offset, or
 * Radius on a cylinder), Sketch and Hole; edges offer Fillet and Chamfer;
 * a body Move and Mirror; several
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
      if (input.resizeBody) {
        // The switch the column-top chip carried as "Resize body | Offset
        // Face": pressed here, it is the one the drag will make.
        verbs.unshift({
          id: 'action:resize-body',
          label: ACTION_LABELS['resize-body']!,
          title: 'Resize the body from this face',
          disabled: false,
          pressed: input.pressedAction === 'resize-body'
        });
      }
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
