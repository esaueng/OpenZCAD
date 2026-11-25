import { describe, expect, it } from 'vitest';
import {
  IDLE,
  builtPreviewSettlement,
  commitParksRefusal,
  dragSettlementEvent,
  projectedFrameSettlement,
  type PreviewSettlement,
  escapeTarget,
  holdsRefusal,
  interactionReducer,
  type InteractionEvent,
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
    // I43: the last rung needs a second press.
    expect(commandPrompt(sketchState('select'))?.escape).toBe(
      'twice leaves the sketch'
    );
  });

  it('gives a half-drawn rectangle its own step, not the line chain’s (I46)', () => {
    const rectangle = commandPrompt(sketchState('rectangle', true));
    expect(rectangle?.step).toMatch(/opposite corner/);
    expect(rectangle?.escape).toBe('cancels the shape');
    expect(commandPrompt(sketchState('line', true))?.step).toBe(
      'Click the next point · Enter finishes'
    );
  });

  it('lets a value prompt open in a sketch own Escape (I43)', () => {
    expect(
      commandPromptText(sketchState('select'), 'diameter', {
        editor: { state: 'ready', explaining: false }
      })
    ).toBe('Enter apply · Esc cancel');
  });

  it('names each slot pick and the current Escape rung', () => {
    const drawingSlot = sketchState('slot', true);
    expect(commandPromptText(sketchState('slot'))).toBe(
      'Pick the first center · Esc returns to selection'
    );
    expect(commandPromptText(drawingSlot)).toBe(
      'Pick the second center · Esc cancels the slot'
    );
    expect(
      commandPromptText(drawingSlot, 'diameter', { slotStage: 'radius' })
    ).toBe(
      'Pick the radius · or type center spacing, Tab, radius · Esc cancels the slot'
    );
    expect(
      commandPromptText(drawingSlot, 'diameter', { slotStage: 'exact' })
    ).toBe('Tab switches size · Enter places · Esc closes exact entry');
    expect(
      commandPromptText(drawingSlot, 'diameter', {
        slotStage: 'keypad',
        editor: { state: 'ready', explaining: true }
      })
    ).toBe('Esc close');
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

  // QA 2026-11-14 finding #9: the hint promised "an exact distance" while
  // the field took the Total size the face leaves, so typing 5 on a 24 mm
  // body moved the top face by -19.
  it('names the two readings a typed face value can have', () => {
    const armed = faceState('armed');
    expect(commandPrompt(armed)?.step).not.toMatch(/exact distance/);
    expect(commandPrompt(armed)?.step).toContain('type its Offset or Total');
    const resize = faceState('armed');
    if (resize.mode !== 'face') throw new Error('face state');
    const resizing: InteractionState = {
      ...resize,
      target: { ...resize.target, resizeBodyFeatureId: 'feature-box' }
    };
    expect(commandPrompt(resizing)?.step).toBe(
      'Drag the arrow to resize the body, or type its Offset or Total · The opposite side stays fixed'
    );
  });

  // PR #2048 review: a face with no flat face opposite (a box's Right face
  // where a unioned cylinder rounds its left side) tags its value plain
  // "Offset", yet the hint still offered a Total it could not type.
  it('names only Offset where the tag offers no Total', () => {
    const armed = faceState('armed');
    const step = commandPrompt(armed, 'diameter', {
      offsetTotalOffered: false
    })?.step;
    expect(step).toMatch(/^Drag to push or pull the face, or type its Offset/);
    expect(step).not.toMatch(/Total/);
    expect(
      commandPrompt(armed, 'diameter', { offsetTotalOffered: true })?.step
    ).toContain('type its Offset or Total');
    if (armed.mode !== 'face') throw new Error('face state');
    const resizing: InteractionState = {
      ...armed,
      target: { ...armed.target, resizeBodyFeatureId: 'feature-box' }
    };
    expect(
      commandPrompt(resizing, 'diameter', { offsetTotalOffered: false })?.step
    ).toBe(
      'Drag the arrow to resize the body, or type its Offset · The opposite side stays fixed'
    );
  });

  it('reads as one line for the status bar', () => {
    expect(commandPromptText(faceState('armed'))).toBe(
      'Drag to push or pull the face, or type its Offset or Total · Space views it head-on · Esc clears the selection'
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

describe('a drag whose frame under the hand was refused', () => {
  // Letting go on a refused frame parks the refusal (`drag-release` lands in
  // `failed`); the step used to promise "Release to apply" all the same.
  const limit = 'A neighbouring face would shrink to nothing past -6.4.';

  it('stops promising an apply and names the refusal briefly', () => {
    const refused = faceState('dragging', 'offset-face', limit);
    const step = commandPrompt(refused)?.step;
    expect(step).not.toMatch(/Release to apply/);
    expect(step).toBe(
      'Can’t move this face here · Release won’t apply · drag back or type a value'
    );
    expect(commandPromptText(refused)).toBe(
      'Can’t move this face here · Release won’t apply · drag back or type a value · Esc cancels the drag'
    );
  });

  it('keeps the accepted drag exactly as it was', () => {
    expect(commandPrompt(faceState('dragging'))?.step).toBe(
      'Release to apply · type to enter an exact value instead'
    );
    expect(
      commandPrompt(faceState('dragging', 'resize-cylinder-radius'))?.step
    ).toBe('Release to apply · type to enter an exact value instead');
    expect(commandPrompt(edgeState('dragging', 'chamfer'))?.step).toBe(
      'Release to apply the chamfer · type to enter an exact value'
    );
  });

  it('names each direct edit by what it could not do, and what release does', () => {
    // A cylinder, fillet or chamfer release validates its value whatever the
    // preview said (`commitParksRefusal`): it checks, it does not park.
    expect(
      commandPrompt(faceState('dragging', 'resize-cylinder-radius', limit))
        ?.step
    ).toMatch(
      /^Can’t resize this (?:cylinder|hole) here · Release checks this value · drag back/
    );
    const resize = faceState('dragging', 'offset-face', limit);
    if (resize.mode !== 'face') throw new Error('face state');
    const resizing: InteractionState = {
      ...resize,
      target: { ...resize.target, resizeBodyFeatureId: 'feature-box' }
    };
    expect(commandPrompt(resizing)?.step).toMatch(
      /^Can’t resize this body here · Release won’t apply/
    );
    const edge = edgeState('dragging', 'fillet');
    if (edge.mode !== 'edges') throw new Error('edge state');
    expect(
      commandPrompt({ ...edge, error: { message: 'Radius too big.' } })?.step
    ).toBe(
      'Can’t round this edge here · Release checks this value · drag back or type a value'
    );
  });

  it('uses the refusal’s own short line when it carries one', () => {
    const refused = faceState('dragging', 'offset-face', 'Too far.');
    if (refused.mode !== 'face') throw new Error('face state');
    expect(
      commandPrompt({
        ...refused,
        error: {
          message: 'Too far.',
          headline: 'Total can’t go below 2 mm here'
        }
      })?.step
    ).toBe(
      'Total can’t go below 2 mm here · Release won’t apply · drag back or type a value'
    );
  });

  it('offers no other value when no value could build', () => {
    const refused = faceState(
      'dragging',
      'offset-face',
      'Fillet could not be created with radius 1. Smaller radii failed too, so a different size is unlikely to help.'
    );
    expect(commandPrompt(refused)?.step).toBe(
      'Can’t move this face here · Release won’t apply'
    );
  });
});

/** A face's drag through a sequence of machine events. */
function drag(
  start: InteractionState,
  ...events: InteractionEvent[]
): InteractionState {
  return events.reduce(
    interactionReducer,
    interactionReducer(start, { type: 'drag-engage' })
  );
}

describe('the release a refused drag promises is the one it makes', () => {
  const refusal = { message: 'A neighbouring face would shrink to nothing.' };
  const refused = (value: number): InteractionEvent => ({
    type: 'preview-refused',
    diagnostic: refusal,
    value
  });
  function faceSet(): InteractionState {
    const armed = faceState('armed');
    if (armed.mode !== 'face') throw new Error('face state');
    return {
      ...armed,
      target: {
        ...armed.target,
        offsetFaceSet: [{ topologyId: 'face-2' } as never]
      }
    };
  }

  // PR #2060 review: a chained set's coarse lane still held the refusal of
  // -9 while the hand was back at a buildable -2; the prompt said "won't
  // apply", yet the release validated -2 and applied it.
  it('a chained face set parks only the value the refusal was for', () => {
    const onRefused = drag(
      faceSet(),
      { type: 'drag-hand', value: -9 },
      refused(-9)
    );
    expect(commitParksRefusal(onRefused)).toBe(true);
    expect(commandPrompt(onRefused)?.step).toContain('Release won’t apply');

    const movedBack = interactionReducer(onRefused, {
      type: 'drag-hand',
      value: -2
    });
    // The release and the prompt read one rule.
    expect(commitParksRefusal(movedBack)).toBe(false);
    expect(commitParksRefusal(movedBack, -2)).toBe(false);
    expect(commitParksRefusal(movedBack, -9)).toBe(true);
    const step = commandPrompt(movedBack)?.step;
    expect(step).not.toContain('won’t apply');
    expect(step).not.toContain('Release to apply');
    expect(step).toBe(
      'Offset Faces can’t be built here · Release checks this value · drag back or type a value'
    );
  });

  it('a single face parks its refusal wherever the hand lets go', () => {
    const state = drag(faceState('armed'), refused(-9));
    expect(commitParksRefusal(state, -2)).toBe(true);
    expect(commandPrompt(state)?.step).toContain('Release won’t apply');
  });

  it('a cylinder, fillet or chamfer release always validates', () => {
    for (const start of [
      faceState('armed', 'resize-cylinder-radius'),
      edgeState('armed', 'fillet')
    ]) {
      const state = drag(start, refused(9));
      expect(commitParksRefusal(state)).toBe(false);
      expect(commandPrompt(state)?.step).toContain('Release checks this value');
    }
  });

  // PR #2060 review: a hole resize cleared its refusal as soon as the hand
  // left the refused radius, so crossing refused radii alternated "Release
  // to apply" with the refusal while each new radius was checked.
  it('keeps one step across refused and unchecked values until one builds', () => {
    const start = faceState('armed', 'resize-cylinder-radius');
    const steps: string[] = [];
    let state = drag(start);
    const plain = commandPrompt(state)!.step;
    for (const event of [
      refused(9),
      { type: 'preview-left' } as const,
      refused(9.5),
      { type: 'preview-left' } as const,
      refused(10)
    ]) {
      state = interactionReducer(state, event);
      steps.push(commandPrompt(state)!.step);
    }
    expect(new Set(steps).size).toBe(1);
    expect(steps[0]).not.toBe(plain);
    // The refusal is no longer held between values: the chip and the
    // release do not answer to it, exactly as before.
    const left = interactionReducer(state, { type: 'preview-left' });
    expect(holdsRefusal(left)).toBe(false);
    // A value that builds is what earns "Release to apply" back.
    const built = interactionReducer(left, { type: 'drag-engage' });
    expect(commandPrompt(built)?.step).toBe(plain);
  });

  it('a face offset says the same across an unchecked projected frame', () => {
    const state = drag(faceState('armed'), refused(-9));
    const left = interactionReducer(state, { type: 'preview-left' });
    // Left for an unchecked value, the release validates: no "won't apply",
    // and never a plain "Release to apply" before a value builds.
    expect(commandPrompt(left)?.step).toBe(
      'Can’t move this face here · Release checks this value · drag back or type a value'
    );
  });

  /** Applies what `recoverPreviewInteraction` dispatches for `settled`. */
  const settle = (state: InteractionState, settled: PreviewSettlement) => {
    const event = dragSettlementEvent(state, settled);
    return event ? interactionReducer(state, event) : state;
  };

  // PR #2060 re-check: a hole drag passed through a buildable radius on its
  // way to another refused one, and the late success for the radius it had
  // left flashed "Release to apply" before the new radius was refused.
  it('a late success for a value the hand left keeps the refusal', () => {
    const start = faceState('armed', 'resize-cylinder-radius');
    const left = interactionReducer(drag(start, refused(9)), {
      type: 'preview-left'
    });
    const step = commandPrompt(left)!.step;
    expect(builtPreviewSettlement(9.2, 9.6)).toBe('left');
    const late = settle(left, builtPreviewSettlement(9.2, 9.6));
    expect(commandPrompt(late)?.step).toBe(step);
    // Still held under the hand, the refusal is let go of exactly as a
    // success always did; only the prompt's memory of it stays.
    const held = drag(start, refused(9));
    const lateOnHeld = settle(held, builtPreviewSettlement(9.2, 9.6));
    expect(holdsRefusal(lateOnHeld)).toBe(false);
    expect(commandPrompt(lateOnHeld)?.step).toBe(step);
    // The success for the radius under the hand is a verdict on it.
    expect(builtPreviewSettlement(9.6, 9.6)).toBe('built');
    expect(builtPreviewSettlement(9.6, null)).toBe('built');
    expect(commandPrompt(settle(late, 'built'))?.step).toBe(
      'Release to apply · type to enter an exact value instead'
    );
  });

  // PR #2060 re-check: a projected step-profile drag back to exactly zero
  // still said "Release checks this value", though letting go there ends
  // the gesture with no commit and nothing to check.
  it('a projected frame back at zero forgets the refusal', () => {
    const left = interactionReducer(drag(faceState('armed'), refused(-9)), {
      type: 'preview-left'
    });
    expect(projectedFrameSettlement(-2)).toBe('left');
    expect(
      commandPrompt(settle(left, projectedFrameSettlement(-2)))?.step
    ).toBe(commandPrompt(left)?.step);
    expect(projectedFrameSettlement(0)).toBe('built');
    expect(commandPrompt(settle(left, projectedFrameSettlement(0)))?.step).toBe(
      'Release to apply · type to enter an exact value instead'
    );
  });

  it('forgets the drag’s refusal once the drag ends', () => {
    const state = interactionReducer(
      drag(faceState('armed', 'resize-cylinder-radius'), refused(9)),
      { type: 'preview-left' }
    );
    const released = interactionReducer(state, { type: 'drag-release' });
    expect(released).toMatchObject({ phase: 'armed', error: null });
    expect(released).not.toHaveProperty('priorRefusal');
    const again = interactionReducer(released, { type: 'drag-engage' });
    expect(commandPrompt(again)?.step).toBe(
      'Release to apply · type to enter an exact value instead'
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
