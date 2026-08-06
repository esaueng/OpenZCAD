import { escapeTarget, type InteractionState } from './machine';

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

/** How each rung of the Escape ladder reads to someone about to press it. */
const ESCAPE_LABELS: Record<ReturnType<typeof escapeTarget>, string | null> = {
  'close-keypad': 'closes exact entry',
  'cancel-drag': 'cancels the drag',
  'recover-failure': 'dismisses the error',
  'end-drawing': 'ends the chain',
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
function armedStep(state: InteractionState): string {
  if (state.mode === 'face') {
    return state.op === 'resize-cylinder-radius'
      ? 'Drag the radial handle to adjust the radius, or type an exact radius'
      : 'Drag the arrow to push or pull the face, or type an exact distance · Space faces it head-on';
  }
  if (state.mode === 'edges') {
    const count = state.edges.length;
    const noun = count === 1 ? 'edge' : `${count} edges`;
    return `Drag the handle to set the ${state.op} on ${noun}, or type a value`;
  }
  if (state.mode === 'region') {
    return 'Drag the arrow off the plane to extrude the profile';
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
 * `panelOpen` closes a gap the machine cannot see. A feature form handles
 * Escape itself and stops it there, so while one is open it is the innermost
 * rung — inside even the machine's outermost one. Saying "Esc clears the
 * selection" then would be a promise the next press does not keep, which is
 * worse than saying nothing.
 */
export function commandPrompt(
  state: InteractionState,
  panelOpen = false
): CommandPrompt | null {
  const target = escapeTarget(state);
  const escape =
    panelOpen && target === 'clear-selection'
      ? 'closes the panel'
      : ESCAPE_LABELS[target];
  if (state.mode === 'idle') {
    return null;
  }
  if (state.mode === 'sketch') {
    if (state.session.drawing) {
      return { step: 'Click the next point · Enter finishes', escape };
    }
    return {
      step:
        SKETCH_TOOL_STEPS[state.session.tool] ??
        'Draw on the plane, or pick an entity to edit',
      escape
    };
  }
  if (state.phase === 'validating') {
    return { step: 'Checking the exact result…', escape };
  }
  if (state.phase === 'failed') {
    return {
      step: state.error
        ? `${state.error} Try another value.`
        : 'That value did not build. Try another.',
      escape
    };
  }
  if (state.phase === 'exact-entry') {
    return { step: 'Type a value · Enter applies', escape };
  }
  if (state.phase === 'dragging') {
    return { step: draggingStep(state), escape };
  }
  return { step: armedStep(state), escape };
}

/** The prompt as one line, ready for the status bar. */
export function commandPromptText(
  state: InteractionState,
  panelOpen = false
): string | null {
  const prompt = commandPrompt(state, panelOpen);
  if (!prompt) {
    return null;
  }
  return prompt.escape ? `${prompt.step} · Esc ${prompt.escape}` : prompt.step;
}
