import { describe, expect, it } from 'vitest';
import {
  IDLE,
  escapeTarget,
  type InteractionState,
  type OperationPhase,
  type SketchToolId
} from './machine';
import { commandPrompt, commandPromptText } from './prompt';

function faceState(
  phase: OperationPhase,
  op: Extract<InteractionState, { mode: 'face' }>['op'] = 'offset-face',
  error: string | null = null
): InteractionState {
  return {
    mode: 'face',
    op,
    target: {
      surfaceType:
        op === 'resize-cylinder-radius' || op === 'edit-fillet'
          ? 'cylindrical'
          : 'planar',
      ...(op === 'resize-cylinder-radius' ? { radius: 4 } : {}),
      ...(op === 'edit-fillet'
        ? {
            blendRadius: 2,
            filletFeatureId: 'feature-fillet' as never,
            radialDirection: [1, 0, 0] as [number, number, number]
          }
        : {}),
      bodyId: 'body-1',
      topologyId: 'face-1',
      point: [0, 0, 0],
      normal: [0, 0, 1]
    },
    phase,
    lastValue: null,
    error
  };
}

function edgeState(
  phase: OperationPhase,
  op: 'fillet' | 'chamfer' = 'fillet',
  count = 1
): InteractionState {
  return {
    mode: 'edges',
    op,
    edges: Array.from({ length: count }, (_, index) => ({
      bodyId: 'body-1' as never,
      kind: 'edge' as const,
      topologyId: `edge-${index}`
    })),
    phase,
    lastValue: null,
    error: null
  };
}

function regionState(phase: OperationPhase): InteractionState {
  return {
    mode: 'region',
    target: {
      sketchId: 'sketch-1',
      regionFingerprint: 1,
      samplePoint: { x: 0, y: 0 },
      sourceEntityIds: [],
      area: 10
    },
    phase,
    lastValue: null,
    error: null
  };
}

function sketchState(
  tool: SketchToolId,
  drawing = false,
  selectedObjectId: string | null = null
): InteractionState {
  return {
    mode: 'sketch',
    session: {
      sketchId: 'sketch-1',
      plane: { kind: 'canonical', plane: 'xy' } as never,
      tool,
      circleMode: 'center-radius',
      drawing,
      selectedObjectId,
      pendingConstraint: null
    }
  };
}

const PHASES: OperationPhase[] = [
  'armed',
  'dragging',
  'exact-entry',
  'validating',
  'failed'
];

const EVERY_STATE: InteractionState[] = [
  ...PHASES.map((phase) => faceState(phase)),
  ...PHASES.map((phase) => faceState(phase, 'resize-cylinder-radius')),
  ...PHASES.map((phase) => edgeState(phase)),
  ...PHASES.map((phase) => edgeState(phase, 'chamfer', 3)),
  ...PHASES.map(regionState),
  sketchState('select'),
  sketchState('line'),
  sketchState('arc'),
  sketchState('circle'),
  sketchState('rectangle'),
  sketchState('line', true),
  sketchState('select', false, 'object-1')
];

describe('every state that is not idle says what to do', () => {
  it('has no prompt while idle, leaving the tool hint in place', () => {
    expect(commandPrompt(IDLE)).toBeNull();
    expect(commandPromptText(IDLE)).toBeNull();
  });

  it('gives a non-empty step for every other state', () => {
    for (const state of EVERY_STATE) {
      const prompt = commandPrompt(state);
      expect(prompt, JSON.stringify(state)).not.toBeNull();
      expect(prompt!.step.length).toBeGreaterThan(0);
    }
  });
});

describe('the Escape line matches the ladder it describes', () => {
  it('promises an exit exactly when Escape has one', () => {
    // The prompt and the reducer read the same function, and this is what
    // stops them drifting: no state may advertise an Escape that does
    // nothing, or stay silent about one that does something.
    for (const state of EVERY_STATE) {
      const prompt = commandPrompt(state)!;
      const hasTarget = escapeTarget(state) !== 'none';
      expect(prompt.escape !== null, JSON.stringify(state)).toBe(hasTarget);
    }
  });

  it('names the innermost rung first', () => {
    expect(commandPrompt(faceState('exact-entry'))?.escape).toBe(
      'closes exact entry'
    );
    expect(commandPrompt(faceState('dragging'))?.escape).toBe(
      'cancels the drag'
    );
    expect(commandPrompt(faceState('armed'))?.escape).toBe(
      'clears the selection'
    );
  });

  it('walks out of a sketch one step at a time', () => {
    expect(commandPrompt(sketchState('line', true))?.escape).toBe(
      'ends the chain'
    );
    expect(commandPrompt(sketchState('select', false, 'a'))?.escape).toBe(
      'deselects'
    );
    expect(commandPrompt(sketchState('select'))?.escape).toBe(
      'leaves the sketch'
    );
  });

  it('stays silent about Escape while a value is being validated', () => {
    // Escape does nothing mid-validation, so the prompt must not offer it.
    expect(commandPrompt(faceState('validating'))?.escape).toBeNull();
    expect(commandPromptText(faceState('validating'))).not.toContain('Esc');
  });
});

describe('the step describes the operation actually armed', () => {
  it('distinguishes pushing a face from adjusting a cylinder radius', () => {
    expect(commandPrompt(faceState('armed'))?.step).toContain('push or pull');
    expect(
      commandPrompt(faceState('armed', 'resize-cylinder-radius'))?.step
    ).toContain('radius');
  });

  it('names the edge operation and how many edges it covers', () => {
    expect(commandPrompt(edgeState('armed', 'fillet', 1))?.step).toContain(
      'fillet on edge'
    );
    expect(commandPrompt(edgeState('armed', 'chamfer', 3))?.step).toContain(
      'chamfer on 3 edges'
    );
  });

  it('describes the armed fillet handle and its R0 removal path', () => {
    expect(commandPrompt(faceState('armed', 'edit-fillet'))?.step).toBe(
      'Drag the radial handle to edit the fillet, or type an exact radius · R0 removes it'
    );
  });

  it('surfaces the kernel own words when a value is refused', () => {
    const refused = faceState(
      'failed',
      'offset-face',
      'Offset removes the face.'
    );
    expect(commandPrompt(refused)?.step).toContain('Offset removes the face.');
  });

  it('defers to a feature form, which takes Escape before the machine', () => {
    // The form stops the key itself, so while one is open it is the innermost
    // rung and the prompt must not promise the machine's outermost one.
    expect(commandPrompt(faceState('armed'), true)?.escape).toBe(
      'closes the panel'
    );
    // An inner rung still outranks the form: the keypad is modal.
    expect(commandPrompt(faceState('exact-entry'), true)?.escape).toBe(
      'closes exact entry'
    );
  });

  it('reads as one line for the status bar', () => {
    expect(commandPromptText(faceState('armed'))).toBe(
      'Drag the arrow to push or pull the face, or type an exact distance · Space faces it head-on · Esc clears the selection'
    );
  });
});
