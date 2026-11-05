import {
  escapeTarget,
  isStaleSelectionError,
  refusalRulesOutSize,
  type CommandDiagnostic,
  type InteractionState
} from './machine';
import { activeKeymap, keyHint } from '../keymap';
import type { DimensionMode, EditControlState } from '../keypad';

/**
 * What the workspace should be telling you to do right now.
 *
 * Direct modeling is modal whether or not it admits to being modal: an armed
 * face, a drag in flight, and open exact entry all take the same keys and
 * mean different things by them. The one key that has to stay predictable is
 * Escape, because it is what you press when you are lost — and the ladder it
 * climbs already exists in `escapeTarget`. This turns that ladder into
 * something the user can read before pressing it, from the same source, so
 * the two cannot drift apart.
 */
export interface CommandPrompt {
  /** The next move, in the imperative. */
  step: string;
  /**
   * What Escape leaves from here, phrased to complete "Esc ___". Null when
   * Escape is deliberately inert, so nothing promises an exit that is not
   * there.
   */
  escape: string | null;
}

/** What the workspace knows that the interaction state alone does not. */
export interface CommandPromptContext {
  /**
   * The refusal is already on screen (on the edit control, or as the
   * guidance row's compact "Not built · Why?"), with its ways out, so the
   * prompt says only which keys do what instead of repeating it.
   */
  refusalShown?: boolean;
  /**
   * The edit control is open at the pick: the prompt is its key hints, true
   * to what Enter and Escape do in its present state.
   */
  editor?: {
    state: EditControlState;
    /** An explanation is open, which Escape closes first. */
    explaining: boolean;
  };
  /**
   * How the picked edges read when they are not a plain count — a rim the
   * boolean split into four arcs is the one "closed edge" the user clicked.
   */
  edgeNoun?: string;
}

/** How each rung of the Escape ladder reads to someone about to press it. */
const ESCAPE_LABELS: Record<ReturnType<typeof escapeTarget>, string | null> = {
  'close-keypad': 'closes exact entry',
  'cancel-drag': 'cancels the drag',
  'cancel-move': 'cancels the move',
  'end-drawing': 'ends the chain',
  'cancel-constraint': 'cancels the constraint',
  'cancel-edit': 'cancels the modify tool',
  'exit-drawing-tool': 'returns to selection',
  'clear-sketch-selection': 'deselects',
  'clear-selection': 'clears the selection',
  'exit-sketch': 'leaves the sketch',
  none: null
};

const SKETCH_TOOL_STEPS: Record<string, string> = {
  select: 'Click an entity to edit it, or pick a draw tool',
  line: 'Click to start a line, then click each point',
  arc: 'Click the centre, then the start and end of the arc',
  circle: 'Drag from the centre to set the radius',
  rectangle: 'Drag from one corner to the other'
};

/** The armed step for an operation, before any drag has begun. */
function armedStep(
  state: InteractionState,
  dimensionMode: DimensionMode,
  edgeNoun?: string
): string {
  if (state.mode === 'face') {
    switch (state.op) {
      case 'resize-cylinder-radius':
        return `Drag the radial handle to adjust the ${dimensionMode}, or type an exact ${dimensionMode}`;
      case 'edit-fillet':
        return 'Drag the arrow to edit the fillet, or type an exact radius · R0 removes it';
      case 'remove-face-feature':
        return 'Remove this proven imported blend, or pick another face';
      case 'offset-face':
        if (state.target.resizeBodyFeatureId && !state.target.localFaceOffset) {
          return 'Drag the arrow to resize the body, or type an exact distance · The opposite side stays fixed';
        }
        // The key is the user's: a remap is named, an unbound one omitted.
        // Kept short: the lane is one line, and at a common bar width the
        // longer wording ellipsized the Escape rung off its end.
        return [
          'Drag to push or pull the face, or type an exact distance',
          keyHint(activeKeymap(), 'view-normal-to-face', 'views it head-on')
        ]
          .filter(Boolean)
          .join(' · ');
    }
  }
  if (state.mode === 'edges') {
    const count = state.edges.length;
    const noun = edgeNoun ?? (count === 1 ? 'edge' : `${count} edges`);
    const value = state.op === 'fillet' ? 'radius' : 'distance';
    return `Drag the arrow to set the ${state.op} on ${noun}, or type a ${value}`;
  }
  if (state.mode === 'region') {
    return state.targets.length > 1
      ? `Drag the arrow off the plane to extrude the profiles together · each of the ${state.targets.length} arrows moves them all`
      : 'Drag the arrow off the plane to extrude the profile';
  }
  return 'Pick a body, face, or edge';
}

function draggingStep(state: InteractionState): string {
  if (state.mode === 'face') {
    return 'Release to apply · type to enter an exact value instead';
  }
  if (state.mode === 'edges') {
    return `Release to apply the ${state.op} · type to enter an exact value`;
  }
  return 'Release to apply · type to enter an exact value instead';
}

/**
 * The prompt for the current state, or null while nothing is armed.
 *
 * Null rather than a generic string: with no operation in flight the
 * workspace's own tool hint is the better thing to be showing, and this
 * should not push it aside to say nothing.
 *
 * An open feature form no longer changes the Escape line: closing the form
 * and clearing the selection are one press, so "clears the selection" is
 * true whether or not a panel is up.
 */
export function commandPrompt(
  state: InteractionState,
  dimensionMode: DimensionMode = 'diameter',
  context: CommandPromptContext = {}
): CommandPrompt | null {
  const escape = ESCAPE_LABELS[escapeTarget(state)];
  if (state.mode === 'idle') {
    return null;
  }
  if (state.mode === 'sketch') {
    if (state.session.moving) {
      return {
        step:
          state.session.moving.handle === 'rotate'
            ? 'Release to set the rotation · Enter sets it here'
            : 'Release to place · Enter places it here',
        escape
      };
    }
    if (state.session.drawing) {
      return { step: 'Click the next point · Enter finishes', escape };
    }
    if (state.session.pendingConstraint) {
      return { step: 'Pick geometry for the constraint', escape };
    }
    return {
      step:
        SKETCH_TOOL_STEPS[state.session.tool] ??
        'Draw on the plane, or pick an entity to edit',
      escape
    };
  }
  if (context.editor) {
    return editorHints(context.editor);
  }
  if (state.phase === 'validating') {
    return { step: 'Checking the exact result…', escape };
  }
  if (state.phase === 'failed') {
    return { step: failedStep(state.error, context.refusalShown), escape };
  }
  if (state.phase === 'exact-entry') {
    return { step: 'Type a value · Enter applies', escape };
  }
  if (state.phase === 'dragging') {
    return { step: draggingStep(state), escape };
  }
  return { step: armedStep(state, dimensionMode, context.edgeNoun), escape };
}

/**
 * The edit control's keys, as they act in its state: Enter applies only a
 * value that built, and Escape climbs its ladder (the explanation, then the
 * edit; the selection is the rung after the control closes).
 */
function editorHints(
  editor: NonNullable<CommandPromptContext['editor']>
): CommandPrompt {
  if (editor.explaining) return { step: '', escape: 'close' };
  switch (editor.state) {
    case 'ready':
      return { step: 'Enter apply', escape: 'cancel' };
    case 'checking':
      return { step: 'Checking…', escape: 'cancel' };
    default:
      return { step: '', escape: 'cancel' };
  }
}

/**
 * The next move after a refused value. "Try another value" is offered only
 * when a different value could build: a stale selection fails at every value,
 * and so does a refusal whose size ladder already failed all the way down.
 */
function failedStep(
  error: CommandDiagnostic | null,
  refusalShown = false
): string {
  if (!error) return 'That value did not build. Try another.';
  const stale = isStaleSelectionError(error);
  const sizeRuledOut = refusalRulesOutSize(error);
  // Shown, the refusal carries its own ways out: the prompt keeps to keys.
  if (refusalShown) return '';
  return stale || sizeRuledOut
    ? error.message
    : `${error.message} Try another value.`;
}

/** The prompt as one line, ready for the status bar. */
export function commandPromptText(
  state: InteractionState,
  dimensionMode: DimensionMode = 'diameter',
  context: CommandPromptContext = {}
): string | null {
  const prompt = commandPrompt(state, dimensionMode, context);
  if (!prompt) {
    return null;
  }
  if (!prompt.escape) return prompt.step;
  return prompt.step
    ? `${prompt.step} · Esc ${prompt.escape}`
    : `Esc ${prompt.escape}`;
}
