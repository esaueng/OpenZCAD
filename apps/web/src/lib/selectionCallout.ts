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
import { activeKeymap, toolCommandId } from './keymap';

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

/**
 * A verb is a selection action the tool card also offers, a tool, or
 * `edit-face`: an imported face's own edits (resize a hole, remove a
 * blend), which have no History step to open them from.
 */
export type SelectionCalloutVerbId =
  `action:${SelectionActionId}` | `tool:${ToolId}` | 'edit-face';

/**
 * An imported face with no edit of its own (a blind hole, a boss, a pocket):
 * its card still says what recognition found, or why it declined. Reading
 * needs no edit access, so it is never disabled.
 */
export function faceDetailsVerb(open: boolean): SelectionCalloutVerb {
  return {
    id: 'edit-face',
    label: 'Face details',
    title: 'What this imported face was recognized as, with its dimensions',
    disabled: false,
    pressed: open
  };
}

/**
 * The imported face's edit verb, drawn pressed while its card is open, and
 * disabled with the reason while the project cannot be edited here.
 */
export function editFaceVerb(
  open: boolean,
  disabledReason: string | null = null
): SelectionCalloutVerb {
  return {
    id: 'edit-face',
    label: 'Edit face',
    title:
      disabledReason ??
      'Resize a hole or remove a fillet on this imported face',
    disabled: disabledReason !== null,
    pressed: open
  };
}

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

export type SelectionCalloutKind =
  'face' | 'faces' | 'edges' | 'body' | 'bodies' | 'region' | 'regions';

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
  /**
   * Why the pick cannot be a datum's source (Plane on a flat face, Axis on
   * a round face or an edge): a face or edge with no identity a rebuild can
   * find again, or a curved edge. The datum verb is then disabled with it.
   */
  datumRefusal?: string | null;
  /**
   * The picked face's kind, read from its topology: what the tools are
   * chosen by when the machine does not hold the face (direct manipulation
   * off). Absent, a face is offered the tools any face takes a start from.
   */
  faceSurface?: 'planar' | 'cylindrical' | 'other';
  availability: ToolAvailability;
}

/**
 * The verbs the card shows as buttons: enough to act on the pick without
 * turning it into a toolbar. The rest of the pick's verbs (U09 §5) wait
 * behind its More disclosure, in the same order.
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

/** Shorter names for tools whose palette label is long for a pick's card. */
const TOOL_VERB_LABELS: Partial<Record<ToolId, string>> = {
  'axis-rotate': 'Rotate',
  'linear-pattern': 'Pattern',
  'datum-plane': 'Plane',
  'datum-axis': 'Axis'
};

function toolVerb(
  tool: ToolId,
  availability: ToolAvailability
): SelectionCalloutVerb {
  return {
    id: `tool:${tool}`,
    label: TOOL_VERB_LABELS[tool] ?? TOOL_META[tool].label,
    title: toolTitle(
      tool,
      availability,
      activeKeymap().label(toolCommandId(tool)) ?? null
    ),
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
 * The verbs for a pick, in the order they are usually reached for (U09 §5):
 * a face offers its own edit (Resize and Offset on a primitive, Offset, or
 * Radius on a cylinder) and the tools that take it — Sketch, Hole, Shell,
 * Draft, Thicken and Plane for a flat face, Axis and Shell for a round one;
 * several faces (a box sweep) Shell and Draft; edges Fillet, Chamfer and
 * Axis; a body Move, Rotate, Scale, Mirror, Split, Pattern and Solid
 * offset; several bodies the booleans and Move; a sketch region Extrude,
 * Revolve, Sweep and Loft. The card shows the first
 * {@link MAX_SELECTION_VERBS} and keeps the rest behind More.
 */
export function selectionCalloutVerbs(
  input: SelectionCalloutVerbInput
): SelectionCalloutVerb[] {
  const { availability } = input;
  const tools = (...ids: ToolId[]) =>
    ids.map((tool) => {
      const verb = toolVerb(tool, availability);
      return (tool === 'datum-plane' || tool === 'datum-axis') &&
        input.datumRefusal
        ? { ...verb, disabled: true, title: input.datumRefusal }
        : verb;
    });
  switch (input.kind) {
    case 'face': {
      const capabilities = input.faceCapabilities ?? [];
      if (capabilities.length === 0) {
        switch (input.faceSurface) {
          case 'planar':
            return tools(
              'sketch',
              'hole',
              'shell',
              'draft',
              'thicken',
              'datum-plane'
            );
          case 'cylindrical':
            return tools('datum-axis', 'shell');
          case 'other':
            return tools('shell');
          default:
            return tools('sketch', 'hole', 'shell');
        }
      }
      const verbs = capabilities.map((capability) =>
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
      // A face that takes a sketch is flat, and a flat face takes every tool
      // that starts from one.
      if (
        capabilities.some(
          (capability) => capability.action === 'sketch-on-face'
        )
      ) {
        verbs.push(
          ...tools('hole', 'shell', 'draft', 'thicken', 'datum-plane')
        );
      } else if (
        capabilities.some(
          (capability) => capability.action === 'resize-radial-face'
        )
      ) {
        verbs.push(...tools('datum-axis', 'shell'));
      }
      return verbs;
    }
    case 'faces':
      return tools('shell', 'draft');
    case 'edges':
      return [
        edgeVerb('fillet', input),
        edgeVerb('chamfer', input),
        ...tools('datum-axis')
      ];
    // No Shell: it starts from the faces it opens, so a face's card offers
    // it, and from a body it would have no body to keep.
    case 'body':
      return tools(
        'transform',
        'axis-rotate',
        'scale',
        'mirror',
        'split',
        'linear-pattern',
        'solid-offset'
      );
    case 'bodies':
      return tools('union', 'subtract', 'intersect', 'transform');
    // A region's tools that start from one profile; Loft takes it as its
    // first section and asks for the next (a pick never spans two
    // sketches, so two picked regions are never a loft's sections). Pattern
    // and Move take bodies: a sketch moves from its own History row.
    case 'region':
      return tools('extrude', 'revolve', 'sweep', 'loft');
    // Several regions of one sketch: only Extrude takes them together.
    case 'regions':
      return tools('extrude');
  }
}
