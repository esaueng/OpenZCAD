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
  message: string | null = null
): InteractionState {
  const error = message === null ? null : { message };
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
  const target = {
    sketchId: 'sketch-1',
    regionFingerprint: 1,
    samplePoint: { x: 0, y: 0 },
    sourceEntityIds: [],
    area: 10
  };
  return {
    mode: 'region',
    target,
    targets: [target],
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
      pendingConstraint: null,
      pendingEdit: null
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
  it('distinguishes pushing a face from adjusting a cylinder diameter', () => {
    expect(commandPrompt(faceState('armed'))?.step).toContain('push or pull');
    expect(
      commandPrompt(faceState('armed', 'resize-cylinder-radius'))?.step
    ).toContain('diameter');
  });

  it.each(['diameter', 'radius'] as const)(
    'uses the displayed %s in the radial help and status bar',
    (mode) => {
      const state = faceState('armed', 'resize-cylinder-radius');
      expect(commandPrompt(state, mode)?.step).toBe(
        `Drag the radial handle to adjust the ${mode}, or type an exact ${mode}`
      );
      expect(commandPromptText(state, mode)).toBe(
        `Drag the radial handle to adjust the ${mode}, or type an exact ${mode} · Esc clears the selection`
      );
    }
  );

  it('keeps fillet help in radius when cylinder controls display diameter', () => {
    expect(
      commandPrompt(faceState('armed', 'edit-fillet'), 'diameter')?.step
    ).toBe(
      'Drag the arrow to edit the fillet, or type an exact radius · R0 removes it'
    );
  });

  it('names the edge operation and how many edges it covers', () => {
    expect(commandPrompt(edgeState('armed', 'fillet', 1))?.step).toContain(
      'fillet on edge'
    );
    expect(commandPrompt(edgeState('armed', 'chamfer', 3))?.step).toContain(
      'chamfer on 3 edges'
    );
  });

  it('points at the edge arrow and names the value typing sets', () => {
    expect(commandPrompt(edgeState('armed', 'fillet', 1))?.step).toBe(
      'Drag the arrow to set the fillet on edge, or type a radius'
    );
    expect(commandPrompt(edgeState('armed', 'chamfer', 2))?.step).toBe(
      'Drag the arrow to set the chamfer on 2 edges, or type a distance'
    );
  });

  it('describes the armed fillet handle and its R0 removal path', () => {
    expect(commandPrompt(faceState('armed', 'edit-fillet'))?.step).toBe(
      'Drag the arrow to edit the fillet, or type an exact radius · R0 removes it'
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

  it('says the same thing whether or not a panel is open', () => {
    // Closing a panel and clearing the selection are one press now, so a
    // failed value promises the same single exit as an armed one.
    expect(commandPrompt(faceState('failed'))?.escape).toBe(
      'clears the selection'
    );
    expect(commandPromptText(faceState('failed'))).toContain(
      'Esc clears the selection'
    );
  });

  it('reads as one line for the status bar', () => {
    expect(commandPromptText(faceState('armed'))).toBe(
      'Drag to push or pull the face, or type an exact distance · Space views it head-on · Esc clears the selection'
    );
  });
});

describe('a refused value', () => {
  const sizeRuledOut =
    'Fillet could not be created on the selected closed edge with radius 1. Smaller radii failed too, so a different size is unlikely to help.';

  it('does not tell the user to try another value once every size failed', () => {
    const refused = faceState('failed', 'offset-face', sizeRuledOut);
    expect(commandPrompt(refused)?.step).toBe(sizeRuledOut);
    expect(commandPromptText(refused)).not.toContain('Try another value');
  });

  it('still offers another value when a smaller one could build', () => {
    expect(
      commandPrompt(
        faceState('failed', 'offset-face', 'Offset removes the face.')
      )?.step
    ).toBe('Offset removes the face. Try another value.');
  });

  it('keeps to the keys once the refusal is on screen with its ways out', () => {
    const shown = { refusalShown: true };
    expect(
      commandPromptText(
        faceState('failed', 'offset-face', sizeRuledOut),
        'diameter',
        shown
      )
    ).toBe('Esc clears the selection');
    expect(
      commandPromptText(
        faceState('failed', 'offset-face', 'Offset removes the face.'),
        'diameter',
        shown
      )
    ).toBe('Esc clears the selection');
  });

  it('names a split rim as the closed edge it is', () => {
    expect(
      commandPrompt(edgeState('armed', 'fillet', 4), 'diameter', {
        edgeNoun: 'the closed edge'
      })?.step
    ).toBe(
      'Drag the arrow to set the fillet on the closed edge, or type a radius'
    );
  });
});

describe('the edit control’s key hints', () => {
  const hints = (
    editor: NonNullable<Parameters<typeof commandPromptText>[2]>['editor']
  ) =>
    commandPromptText(faceState('exact-entry'), 'diameter', {
      ...(editor ? { editor } : {})
    });

  it.each([
    [{ state: 'ready', explaining: false }, 'Enter apply · Esc cancel'],
    [{ state: 'checking', explaining: false }, 'Checking… · Esc cancel'],
    // Enter does nothing on a refused or unreadable value, so it is not offered.
    [{ state: 'refused', explaining: false }, 'Esc cancel'],
    [{ state: 'invalid', explaining: false }, 'Esc cancel'],
    // The first rung of the ladder: an open explanation closes first.
    [{ state: 'refused', explaining: true }, 'Esc close']
  ] as const)('reads %o as %s', (editor, text) => {
    expect(hints(editor)).toBe(text);
  });
});
