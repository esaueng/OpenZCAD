import { describe, expect, it } from 'vitest';
import {
  IDLE,
  commandSessionFor,
  composingTextDraft,
  sketchToolKeysSuspended,
  radialFaceOperationName,
  escapeTarget,
  interactionReducer,
  isOperationState,
  nextSketchCircleMode,
  toolCardFor,
  type FaceTarget,
  type InteractionState,
  type RegionTarget
} from './machine';
import { commandPrompt } from './prompt';
import type {
  FaceTopologyReferenceV5,
  FeatureId,
  SketchPlaneRef,
  TopologySelection
} from '@openzcad/shared';
import { UNSTABLE_FACE_OFFSET_REASON } from '../directEdit';
import { UNSTABLE_FACE_SKETCH_REASON } from '../faceSketchAttachment';
import {
  textDraftPlaceable,
  textObjectFromPoint
} from '../sketch/textPlacement';

const faceReference: FaceTopologyReferenceV5 = {
  kind: 'face',
  producingFeatureId: 'feature_box' as FeatureId,
  lineageName: 'primitive.box.face.z-max',
  currentHash: 3,
  witnessVersion: 1,
  witness: {
    surfaceType: 'plane',
    perimeter: 40,
    centroid: [0, 0, 5],
    analytic: { kind: 'plane', normal: [0, 0, 1], offset: 5 },
    closure: { u: 'open', v: 'open' }
  }
};

const face = (overrides: Partial<FaceTarget> = {}): FaceTarget => ({
  bodyId: 'body_1',
  topologyId: 'face:3',
  hash: 3,
  point: [1, 2, 3],
  normal: [0, 0, 1],
  surfaceType: 'planar',
  reference: faceReference,
  ...overrides
});

const edge = (hash: number): TopologySelection =>
  ({
    bodyId: 'body_1',
    kind: 'edge',
    topologyId: `edge:${hash}`,
    hash
  }) as TopologySelection;

const region: RegionTarget = {
  sketchId: 'sketch_1',
  regionFingerprint: 42,
  samplePoint: { x: 1, y: 2 },
  sourceEntityIds: [],
  area: 100
};

const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 0 };

describe('interactionReducer', () => {
  it('distinguishes body resize from an explicitly chosen face extrusion', () => {
    const resize = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ resizeBodyFeatureId: 'feature_box' })
    });
    expect(toolCardFor(resize)?.title).toBe('Resize Body');
    expect(toolCardFor(resize)?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'resize-body', active: true }),
        expect.objectContaining({ id: 'offset-face', active: false })
      ])
    );
    const local = interactionReducer(resize, {
      type: 'set-face-offset-mode',
      local: true
    });
    expect(toolCardFor(local)?.title).toBe('Offset Face');
    expect(toolCardFor(local)?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'resize-body', active: false }),
        expect.objectContaining({ id: 'offset-face', active: true })
      ])
    );
    expect(
      interactionReducer(local, { type: 'set-face-offset-mode', local: false })
    ).toMatchObject({
      mode: 'face',
      phase: 'armed',
      lastValue: null,
      target: { resizeBodyFeatureId: 'feature_box', localFaceOffset: false }
    });
  });

  it('arms offset-face for planar faces and radius resize for measured cylinders', () => {
    const planar = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    expect(planar.mode).toBe('face');
    expect(planar.mode === 'face' && planar.op).toBe('offset-face');

    const bore = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ surfaceType: 'cylindrical', radius: 4 })
    });
    expect(bore.mode === 'face' && bore.op).toBe('resize-cylinder-radius');

    // Cylindrical without a measurable diameter has no safe direct action.
    const boss = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ surfaceType: 'cylindrical' })
    });
    expect(boss).toEqual(IDLE);
  });

  it('arms producing-feature fillet edits before cylindrical resize', () => {
    const state = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({
        surfaceType: 'cylindrical',
        radius: 2,
        blendRadius: 2,
        filletFeatureId: 'feature_fillet' as FeatureId
      })
    });

    expect(state).toMatchObject({ mode: 'face', op: 'edit-fillet' });
    expect(toolCardFor(state)?.title).toBe('Edit Fillet');
  });

  it('accumulates edges additively and toggles them off when re-picked', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    state = interactionReducer(state, {
      type: 'select-edge',
      selection: edge(2),
      additive: true
    });
    expect(state.mode === 'edges' && state.edges).toHaveLength(2);

    // Additive re-pick removes; removing the last edge clears the mode.
    state = interactionReducer(state, {
      type: 'select-edge',
      selection: edge(2),
      additive: true
    });
    expect(state.mode === 'edges' && state.edges).toHaveLength(1);
    state = interactionReducer(state, {
      type: 'select-edge',
      selection: edge(1),
      additive: true
    });
    expect(state).toEqual(IDLE);
  });

  it('replaces the edge set on non-additive pick', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    state = interactionReducer(state, {
      type: 'select-edge',
      selection: edge(2),
      additive: false
    });
    expect(state.mode === 'edges' && state.edges.map((e) => e.hash)).toEqual([
      2
    ]);
  });

  it('preserves the fillet/chamfer choice across additive picks', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    state = interactionReducer(state, { type: 'toggle-edge-op' });
    expect(state.mode === 'edges' && state.op).toBe('chamfer');
    state = interactionReducer(state, {
      type: 'select-edge',
      selection: edge(2),
      additive: true
    });
    expect(state.mode === 'edges' && state.op).toBe('chamfer');
  });

  it('runs the semantic lifecycle and clears only after successful commit', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    state = interactionReducer(state, { type: 'drag-engage' });
    expect(state.mode === 'face' && state.phase).toBe('dragging');
    state = interactionReducer(state, { type: 'drag-release' });
    expect(state.mode === 'face' && state.phase).toBe('armed');
    state = interactionReducer(state, {
      type: 'validation-start',
      value: 8
    });
    expect(state.mode === 'face' && state.phase).toBe('validating');
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'Face would self-intersect.' }
    });
    expect(state.mode === 'face' && state.phase).toBe('failed');
    expect(state.mode === 'face' && state.lastValue).toBe(8);
    state = interactionReducer(state, { type: 'recover' });
    expect(state.mode === 'face' && state.phase).toBe('armed');
    state = interactionReducer(state, { type: 'commit-complete' });
    expect(state).toEqual(IDLE);
  });

  it('ignores 3D selection while sketching', () => {
    const sketching = interactionReducer(IDLE, {
      type: 'enter-sketch',
      plane
    });
    const after = interactionReducer(sketching, {
      type: 'select-face',
      target: face()
    });
    expect(after).toBe(sketching);
    const afterRegion = interactionReducer(sketching, {
      type: 'select-region',
      target: region
    });
    expect(afterRegion).toBe(sketching);
  });

  it('tracks the sketch session lifecycle', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    expect(state.mode === 'sketch' && state.session.sketchId).toBeNull();
    state = interactionReducer(state, {
      type: 'sketch-created',
      sketchId: 'sketch_9'
    });
    expect(state.mode === 'sketch' && state.session.sketchId).toBe('sketch_9');
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'circle' });
    expect(state.mode === 'sketch' && state.session.tool).toBe('circle');
    expect(state.mode === 'sketch' && state.session.circleMode).toBe(
      'center-radius'
    );
    state = interactionReducer(state, {
      type: 'sketch-circle-mode',
      mode: 'three-point'
    });
    expect(state.mode === 'sketch' && state.session.circleMode).toBe(
      'three-point'
    );
    expect(state.mode === 'sketch' && state.session.tool).toBe('circle');
    state = interactionReducer(state, { type: 'exit-sketch' });
    expect(state).toEqual(IDLE);
  });

  it('steps the circle type in the strip order, wrapping round', () => {
    expect(nextSketchCircleMode('center-radius')).toBe('two-point-diameter');
    expect(nextSketchCircleMode('two-point-diameter')).toBe('three-point');
    expect(nextSketchCircleMode('three-point')).toBe('center-radius');
  });

  it('collects constraint picks and clears them on tool changes', () => {
    let state = interactionReducer(IDLE, {
      type: 'enter-sketch',
      plane
    });
    state = interactionReducer(state, {
      type: 'sketch-constraint-tool',
      kind: 'parallel'
    });
    expect(state.mode === 'sketch' && state.session.tool).toBe('select');
    expect(state.mode === 'sketch' && state.session.pendingConstraint).toEqual({
      kind: 'parallel',
      picks: []
    });
    state = interactionReducer(state, {
      type: 'sketch-constraint-pick',
      pick: { kind: 'object', objectId: 'ent_a' }
    });
    expect(
      state.mode === 'sketch' && state.session.pendingConstraint?.picks
    ).toEqual([{ kind: 'object', objectId: 'ent_a' }]);
    // Arming a drawing tool abandons the pick sequence.
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'line' });
    expect(
      state.mode === 'sketch' && state.session.pendingConstraint
    ).toBeNull();
    // Picks without an armed tool are ignored.
    const untouched = interactionReducer(state, {
      type: 'sketch-constraint-pick',
      pick: { kind: 'object', objectId: 'ent_b' }
    });
    expect(untouched).toBe(state);
  });

  it('collects modify picks, and the two armed tools exclude each other', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-constraint-tool',
      kind: 'parallel'
    });
    state = interactionReducer(state, {
      type: 'sketch-edit-tool',
      kind: 'fillet'
    });
    expect(state.mode === 'sketch' && state.session.tool).toBe('select');
    expect(
      state.mode === 'sketch' && state.session.pendingConstraint
    ).toBeNull();
    expect(state.mode === 'sketch' && state.session.pendingEdit).toEqual({
      kind: 'fillet',
      picks: []
    });
    state = interactionReducer(state, {
      type: 'sketch-edit-pick',
      objectId: 'ent_a'
    });
    expect(state.mode === 'sketch' && state.session.pendingEdit?.picks).toEqual(
      ['ent_a']
    );
    // Arming a constraint tool abandons the modify sequence, and vice versa.
    state = interactionReducer(state, {
      type: 'sketch-constraint-tool',
      kind: 'parallel'
    });
    expect(state.mode === 'sketch' && state.session.pendingEdit).toBeNull();
    const untouched = interactionReducer(state, {
      type: 'sketch-edit-pick',
      objectId: 'ent_b'
    });
    expect(untouched).toBe(state);
  });
});

describe('text tool composing', () => {
  const composing = () =>
    interactionReducer(
      interactionReducer(IDLE, { type: 'enter-sketch', plane }),
      {
        type: 'sketch-tool',
        tool: 'text'
      }
    );

  it('opens the card with an empty draft the moment the tool arms', () => {
    const state = composing();
    expect(state.mode === 'sketch' && state.session.tool).toBe('text');
    expect(composingTextDraft(state)).toEqual({
      text: '',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 10,
      align: 'left'
    });
  });

  it('takes each edit into the draft without touching the rest', () => {
    let state = composing();
    state = interactionReducer(state, {
      type: 'sketch-text-draft',
      patch: { text: 'B' }
    });
    state = interactionReducer(state, {
      type: 'sketch-text-draft',
      patch: { text: 'Boa', fontStyle: 'bold' }
    });
    state = interactionReducer(state, {
      type: 'sketch-text-draft',
      patch: { size: 8, align: 'center' }
    });
    expect(composingTextDraft(state)).toEqual({
      text: 'Boa',
      fontFamily: 'open-sans',
      fontStyle: 'bold',
      size: 8,
      align: 'center'
    });
    // Pressing T again keeps what is being typed.
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'text' });
    expect(composingTextDraft(state)?.text).toBe('Boa');
  });

  it('ignores draft edits when no card is open', () => {
    const sketching = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    expect(
      interactionReducer(sketching, {
        type: 'sketch-text-draft',
        patch: { text: 'stray' }
      })
    ).toBe(sketching);
    expect(
      interactionReducer(IDLE, {
        type: 'sketch-text-draft',
        patch: { text: 'stray' }
      })
    ).toBe(IDLE);
  });

  it('Escape closes the card, drops the draft and keeps the sketch', () => {
    let state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Boa' }
    });
    expect(escapeTarget(state)).toBe('exit-drawing-tool');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode).toBe('sketch');
    expect(state.mode === 'sketch' && state.session.tool).toBe('select');
    expect(state.mode === 'sketch' && state.session.textDraft).toBeNull();
    expect(composingTextDraft(state)).toBeNull();
    // The next T starts over rather than reviving the abandoned string.
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'text' });
    expect(composingTextDraft(state)?.text).toBe('');
  });

  it('another tool ends the composition', () => {
    let state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Boa' }
    });
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'line' });
    expect(composingTextDraft(state)).toBeNull();
    // A constraint tool lands on Select: the draft no longer reads as live
    // even though that route does not clear it.
    state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Boa' }
    });
    state = interactionReducer(state, {
      type: 'sketch-constraint-tool',
      kind: 'horizontal'
    });
    expect(composingTextDraft(state)).toBeNull();
  });

  it('an unresolved size makes the draft unplaceable until it resolves', () => {
    let state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Boa', size: 'h' }
    });
    const draft = () => composingTextDraft(state);
    // What the plane click asks, with the parameter scope as it is now.
    expect(textDraftPlaceable(draft(), { h: 8 })).toBe(true);
    // `h` changes to 0 in the Parameters panel; the card is not touched and
    // the draft is the same, but a click now places nothing.
    expect(textDraftPlaceable(draft(), { h: 0 })).toBe(false);
    // Or `h` is deleted and the expression no longer resolves at all.
    expect(textDraftPlaceable(draft(), {})).toBe(false);
    // The card typing 0 into Size (em) writes it to the draft.
    state = interactionReducer(state, {
      type: 'sketch-text-draft',
      patch: { size: 0 }
    });
    expect(textDraftPlaceable(draft(), { h: 8 })).toBe(false);
    state = interactionReducer(state, {
      type: 'sketch-text-draft',
      patch: { size: 12 }
    });
    expect(textDraftPlaceable(draft(), {})).toBe(true);
  });

  it('holds off the tool letters while composing, so they cannot discard the draft', () => {
    let state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Bo' }
    });
    // The workspace's key handler: a tool letter dispatches only when the
    // keys are not suspended. Before the card mounts, or with focus off its
    // field, these letters would otherwise switch tools.
    for (const tool of [
      'select',
      'line',
      'arc',
      'circle',
      'rectangle'
    ] as const) {
      if (!sketchToolKeysSuspended(state)) {
        state = interactionReducer(state, { type: 'sketch-tool', tool });
      }
    }
    expect(state.mode === 'sketch' && state.session.tool).toBe('text');
    expect(composingTextDraft(state)?.text).toBe('Bo');
    // Outside a composition the letters work as before.
    const drawing = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    expect(sketchToolKeysSuspended(drawing)).toBe(false);
    // Escape still leaves the text tool, and the keys come back.
    state = interactionReducer(state, { type: 'escape' });
    expect(sketchToolKeysSuspended(state)).toBe(false);
  });

  it('places exactly the typed object, then hands over to Select', () => {
    let state = interactionReducer(composing(), {
      type: 'sketch-text-draft',
      patch: { text: 'Boa', size: 8 }
    });
    const draft = composingTextDraft(state)!;
    const placed = textObjectFromPoint({ x: 12, y: -3 }, draft);
    expect(placed).toEqual({
      objectKind: 'text',
      text: 'Boa',
      fontFamily: 'open-sans',
      fontStyle: 'regular',
      size: 8,
      x: 12,
      y: -3
    });
    // The workspace commits it, then selects the new object for the editor.
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'select' });
    state = interactionReducer(state, {
      type: 'sketch-select-object',
      objectId: 'ent_text'
    });
    expect(state.mode === 'sketch' && state.session.selectedObjectId).toBe(
      'ent_text'
    );
    expect(composingTextDraft(state)).toBeNull();
  });
});

describe('escape chain', () => {
  it('closes exact entry, then clears everything in one more press', () => {
    let state: InteractionState = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    state = interactionReducer(state, { type: 'drag-engage' });
    state = interactionReducer(state, { type: 'keypad-open' });

    expect(escapeTarget(state)).toBe('close-keypad');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'face' && state.phase).toBe('armed');

    expect(escapeTarget(state)).toBe('clear-selection');
    state = interactionReducer(state, { type: 'escape' });
    expect(state).toEqual(IDLE);
    expect(escapeTarget(state)).toBe('none');
  });

  it('returns to idle in one press from any settled operation phase', () => {
    // Outside a sketch there is no ladder to count: armed and failed alike
    // go straight to nothing selected, for every kind of command.
    const settled: InteractionState[] = [];
    const armedFace = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    settled.push(armedFace);
    settled.push(
      interactionReducer(
        interactionReducer(armedFace, { type: 'validation-start', value: -10 }),
        {
          type: 'validation-failed',
          diagnostic: { message: 'Offset removes the face.' }
        }
      )
    );
    const armedEdges = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    settled.push(armedEdges);
    settled.push(
      interactionReducer(armedEdges, {
        type: 'validation-failed',
        diagnostic: { message: 'Radius too large.' },
        value: 40
      })
    );
    const armedRegion = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    settled.push(armedRegion);
    for (const state of settled) {
      expect(isOperationState(state), JSON.stringify(state)).toBe(true);
      expect(escapeTarget(state), JSON.stringify(state)).toBe(
        'clear-selection'
      );
      expect(interactionReducer(state, { type: 'escape' })).toEqual(IDLE);
    }
  });

  it('cancels a held drag in place, forgetting its value and refusal', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    state = interactionReducer(state, { type: 'drag-engage' });
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'Offset removes the face.' },
      value: -10
    });
    state = interactionReducer(state, { type: 'recover' });
    state = interactionReducer(state, { type: 'drag-engage' });
    expect(state.mode === 'face' && state.lastValue).toBe(-10);

    expect(escapeTarget(state)).toBe('cancel-drag');
    state = interactionReducer(state, { type: 'escape' });
    // Clean armed: no value to re-arm the handle at, no error on the card.
    expect(state).toMatchObject({
      mode: 'face',
      phase: 'armed',
      lastValue: null,
      error: null
    });
  });

  it('resets a cancelled value without touching a validation in flight', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'Radius too large.' },
      value: 40
    });
    state = interactionReducer(state, { type: 'reset-value' });
    expect(state).toMatchObject({
      mode: 'edges',
      phase: 'armed',
      lastValue: null,
      error: null
    });
    const validating = interactionReducer(state, {
      type: 'validation-start',
      value: 3
    });
    expect(interactionReducer(validating, { type: 'reset-value' })).toBe(
      validating
    );
    expect(interactionReducer(IDLE, { type: 'reset-value' })).toBe(IDLE);
  });

  it('ends the drawing chain before exiting sketch mode', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-drawing',
      drawing: true
    });
    expect(escapeTarget(state)).toBe('end-drawing');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'sketch' && state.session.drawing).toBe(false);
    expect(escapeTarget(state)).toBe('exit-drawing-tool');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'sketch' && state.session.tool).toBe('select');
    expect(escapeTarget(state)).toBe('exit-sketch');
    state = interactionReducer(state, { type: 'escape' });
    expect(state).toEqual(IDLE);
  });

  it('exits an armed drawing tool before leaving the sketch', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, { type: 'sketch-tool', tool: 'circle' });

    expect(escapeTarget(state)).toBe('exit-drawing-tool');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'sketch' && state.session.tool).toBe('select');
    expect(escapeTarget(state)).toBe('exit-sketch');
  });

  it('cancels a modify pick sequence before anything exits the sketch', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-edit-tool',
      kind: 'chamfer'
    });
    state = interactionReducer(state, {
      type: 'sketch-edit-pick',
      objectId: 'ent_a'
    });

    expect(escapeTarget(state)).toBe('cancel-edit');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'sketch' && state.session.pendingEdit).toBeNull();
    expect(escapeTarget(state)).toBe('exit-sketch');
  });

  it('cancels a constraint pick sequence before anything exits the sketch', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-constraint-tool',
      kind: 'coincident'
    });
    state = interactionReducer(state, {
      type: 'sketch-constraint-pick',
      pick: { kind: 'point', objectId: 'ent_a', point: 'end' }
    });
    expect(escapeTarget(state)).toBe('cancel-constraint');
    state = interactionReducer(state, { type: 'escape' });
    expect(
      state.mode === 'sketch' && state.session.pendingConstraint
    ).toBeNull();
    expect(state.mode).toBe('sketch');
    expect(escapeTarget(state)).toBe('exit-sketch');
  });

  it('clears an entity selection before exiting sketch mode', () => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-select-object',
      objectId: 'entity_1'
    });
    expect(escapeTarget(state)).toBe('clear-sketch-selection');
    state = interactionReducer(state, { type: 'escape' });
    expect(
      state.mode === 'sketch' && state.session.selectedObjectId
    ).toBeNull();
    expect(escapeTarget(state)).toBe('exit-sketch');
  });

  it('keeps validating face operations locked, then clears a refusal in one press', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    state = interactionReducer(state, {
      type: 'validation-start',
      value: 24
    });
    expect(escapeTarget(state)).toBe('none');
    expect(interactionReducer(state, { type: 'escape' })).toBe(state);
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'Self-intersection.' }
    });
    // A refusal is not a rung of its own: the failed card, its value and
    // the selection all go with the one press.
    expect(escapeTarget(state)).toBe('clear-selection');
    expect(interactionReducer(state, { type: 'escape' })).toEqual(IDLE);
  });

  it('lets a region extrude be dropped mid-validation', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, { type: 'validation-start', value: 5 });
    expect(escapeTarget(state)).toBe('clear-selection');
    expect(interactionReducer(state, { type: 'escape' })).toEqual(IDLE);
  });
});

describe('toolCardFor', () => {
  it('names a far-cap offset after the extrude it edits', () => {
    const state = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ extrudeFeatureId: 'feature_boss' })
    });
    expect(state.mode === 'face' && state.op).toBe('offset-face');
    const card = toolCardFor(state);
    expect(card?.title).toBe('Extrude');
    expect(card?.icon).toBe('extrude');
    expect(card?.hint).toMatch(/depth/);
    expect(
      toolCardFor(
        interactionReducer(IDLE, { type: 'select-face', target: face() })
      )?.title
    ).toBe('Offset Face');
  });

  it('describes each mode', () => {
    expect(toolCardFor(IDLE)).toBeNull();
    const faceCard = toolCardFor(
      interactionReducer(IDLE, { type: 'select-face', target: face() })
    );
    expect(faceCard?.title).toBe('Offset Face');
    expect(faceCard?.hint).toContain('Space faces it head-on');
    expect(faceCard?.actions?.map((action) => action.label)).toEqual([
      'Offset Face',
      'Sketch'
    ]);
    expect(faceCard?.actions?.every((action) => action.enabled)).toBe(true);
    const holeCard = toolCardFor(
      interactionReducer(IDLE, {
        type: 'select-face',
        target: face({ surfaceType: 'cylindrical', radius: 4 })
      })
    );
    // A bare cylindrical face is neither a hole nor a boss, so it is named
    // for what it is rather than for the parameter that defines it.
    expect(holeCard?.title).toBe('Resize Cylinder');
    expect(holeCard?.hint).toContain('radius');
    let edges = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(1),
      additive: false
    });
    expect(
      toolCardFor(edges)?.actions?.find((action) => action.active)?.id
    ).toBe('fillet');
    edges = interactionReducer(edges, { type: 'toggle-edge-op' });
    expect(toolCardFor(edges)?.title).toBe('Chamfer');
    expect(
      toolCardFor(
        interactionReducer(IDLE, { type: 'select-region', target: region })
      )?.title
    ).toBe('Extrude');
  });

  it('discloses geometry-only anchoring without lengthening the live hint', () => {
    const hashOnly = toolCardFor(
      interactionReducer(IDLE, {
        type: 'select-face',
        target: face({ reference: undefined })
      })
    );
    expect(hashOnly?.hint).not.toContain(UNSTABLE_FACE_OFFSET_REASON);
    expect(hashOnly?.badge).toEqual({
      label: 'Geometry-anchored',
      detail: UNSTABLE_FACE_OFFSET_REASON
    });
    expect(
      hashOnly?.actions?.find((action) => action.id === 'offset-face')?.note
    ).toBe(UNSTABLE_FACE_OFFSET_REASON);

    const referenced = toolCardFor(
      interactionReducer(IDLE, { type: 'select-face', target: face() })
    );
    expect(referenced?.hint).not.toContain(UNSTABLE_FACE_OFFSET_REASON);
    expect(referenced?.badge).toBeUndefined();
    expect(referenced?.hint).toContain('Space faces it head-on');
  });

  it('keeps sketch offered on a hash-only planar face and says how it will be placed', () => {
    const card = toolCardFor(
      interactionReducer(IDLE, {
        type: 'select-face',
        target: face({ reference: undefined })
      })
    );
    const sketch = card?.actions?.find(
      (action) => action.id === 'sketch-on-face'
    );
    expect(sketch).toMatchObject({ enabled: true });
    expect(sketch?.disabledReason).toBeUndefined();
    // Compare against the constant, not a phrase from it: the wording is
    // user-facing copy and has already been rewritten once underneath these
    // assertions.
    expect(sketch?.note).toBe(UNSTABLE_FACE_SKETCH_REASON);
  });
});

describe('command session', () => {
  const cylinderFace = face({
    surfaceType: 'cylindrical',
    radius: 7.5,
    concavity: 'hole',
    axisStart: [0, 0, 0],
    axisEnd: [0, 0, 10],
    featureType: 'through-hole',
    diameter: 15
  });

  const states: InteractionState[] = [
    interactionReducer(IDLE, { type: 'select-face', target: face() }),
    interactionReducer(IDLE, { type: 'select-face', target: cylinderFace }),
    interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(11),
      additive: false
    }),
    interactionReducer(
      interactionReducer(IDLE, {
        type: 'select-edge',
        selection: edge(11),
        additive: false
      }),
      { type: 'toggle-edge-op' }
    ),
    interactionReducer(IDLE, { type: 'select-region', target: region })
  ];

  it('gives every surface the same name for the running command', () => {
    // The acceptance criterion the recorded defect broke: one command, one
    // name, wherever it is shown. Both readers derive from one identity, so a
    // new command cannot be added to only one of them.
    for (const state of states) {
      expect(commandSessionFor(state)?.title).toBe(toolCardFor(state)?.title);
    }
    expect(states.map((state) => commandSessionFor(state)?.title)).toEqual([
      'Offset Face',
      'Resize Hole',
      'Fillet',
      'Chamfer',
      'Extrude'
    ]);
  });

  it('has no session while nothing is selected', () => {
    expect(commandSessionFor(IDLE)).toBeNull();
    expect(toolCardFor(IDLE)).toBeNull();
  });

  it('reports what the command is acting on', () => {
    const twoEdges = interactionReducer(
      interactionReducer(IDLE, {
        type: 'select-edge',
        selection: edge(11),
        additive: false
      }),
      { type: 'select-edge', selection: edge(12), additive: true }
    );
    expect(commandSessionFor(twoEdges)?.target).toEqual({
      kind: 'edges',
      count: 2
    });
  });

  it('carries the rejection the command must show, and drops it on re-arm', () => {
    const armed = interactionReducer(IDLE, {
      type: 'select-edge',
      selection: edge(11),
      additive: false
    });
    const failed = interactionReducer(armed, {
      type: 'validation-failed',
      diagnostic: { message: 'Fillet could not be created.' },
      value: 4.8
    });
    expect(commandSessionFor(failed)).toMatchObject({
      phase: 'failed',
      error: { message: 'Fillet could not be created.' }
    });
    // A stale diagnostic beside a value that has since moved is the failure
    // this clears: dragging again re-arms the command and the message goes.
    const dragging = interactionReducer(failed, { type: 'drag-engage' });
    expect(commandSessionFor(dragging)).toMatchObject({
      phase: 'dragging',
      error: null
    });
  });

  it('has no value lifecycle in a sketch session', () => {
    const sketching = interactionReducer(IDLE, {
      type: 'enter-sketch',
      plane
    });
    expect(commandSessionFor(sketching)).toMatchObject({
      id: 'sketch',
      phase: null,
      error: null
    });
  });
});

describe('radialFaceOperationName', () => {
  it('names the object being resized, not the kernel parameter', () => {
    // The command used to be "Resize Cylinder Radius" while its own value was
    // labelled Diameter. Naming the object leaves nothing to disagree with.
    expect(
      radialFaceOperationName(
        face({
          surfaceType: 'cylindrical',
          radius: 4,
          featureType: 'through-hole'
        })
      )
    ).toBe('Resize Hole');
    expect(
      radialFaceOperationName(
        face({ surfaceType: 'cylindrical', radius: 4, concavity: 'hole' })
      )
    ).toBe('Resize Hole');
    // `concavity` is read off the surface normal, so a plain cylinder's outer
    // wall reports 'boss' exactly like a raised boss does. Both are cylinders.
    expect(
      radialFaceOperationName(
        face({ surfaceType: 'cylindrical', radius: 4, concavity: 'boss' })
      )
    ).toBe('Resize Cylinder');
    expect(
      radialFaceOperationName(face({ surfaceType: 'cylindrical', radius: 4 }))
    ).toBe('Resize Cylinder');
  });
});

describe('extrusion intent lifecycle', () => {
  it('keeps an explicit Cut while adding profiles and retrying, then resets for a different sketch', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'set-extrude-choice',
      choice: { operation: 'cut' }
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: { ...region, regionFingerprint: 12345 }
    });
    expect(state).toMatchObject({ extrudeChoice: { operation: 'cut' } });
    state = interactionReducer(state, { type: 'validation-start', value: -8 });
    expect(
      interactionReducer(state, {
        type: 'set-extrude-choice',
        choice: { operation: 'add' }
      })
    ).toBe(state);
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'No intersection' }
    });
    state = interactionReducer(state, { type: 'recover' });
    expect(state).toMatchObject({
      extrudeChoice: { operation: 'cut' },
      lastValue: -8
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: { ...region, sketchId: 'another-sketch' }
    });
    expect(state).not.toHaveProperty('extrudeChoice');
  });
});

describe('sketch object move', () => {
  const selected = (objectId = 'circle_1'): InteractionState => {
    let state = interactionReducer(IDLE, { type: 'enter-sketch', plane });
    state = interactionReducer(state, {
      type: 'sketch-created',
      sketchId: 's'
    });
    return interactionReducer(state, {
      type: 'sketch-select-object',
      objectId
    });
  };
  const moving = (state: InteractionState) =>
    state.mode === 'sketch' ? state.session.moving : undefined;

  it('starts on the selected object under Select', () => {
    const state = interactionReducer(selected(), {
      type: 'sketch-move-start',
      objectId: 'circle_1',
      handle: 'translate'
    });
    expect(moving(state)).toEqual({
      objectId: 'circle_1',
      handle: 'translate'
    });
    expect(escapeTarget(state)).toBe('cancel-move');
    expect(toolCardFor(state)?.hint).toMatch(/^Release to place/);
    expect(commandPrompt(state)?.escape).toBe('cancels the move');
  });

  it('a press off the selected object changes nothing', () => {
    const base = selected();
    // Another object, no selection, a drawing tool, an armed pick tool and a
    // chain in flight all keep the press meaning what it meant before.
    const refusals: InteractionState[] = [
      interactionReducer(base, {
        type: 'sketch-select-object',
        objectId: null
      }),
      interactionReducer(base, { type: 'sketch-tool', tool: 'circle' }),
      interactionReducer(base, {
        type: 'sketch-constraint-tool',
        kind: 'coincident'
      }),
      interactionReducer(base, { type: 'sketch-edit-tool', kind: 'fillet' }),
      interactionReducer(base, { type: 'sketch-drawing', drawing: true }),
      interactionReducer(IDLE, { type: 'select-region', target: region }),
      IDLE
    ];
    for (const state of refusals) {
      expect(
        interactionReducer(state, {
          type: 'sketch-move-start',
          objectId: 'circle_1',
          handle: 'translate'
        }),
        JSON.stringify(state)
      ).toBe(state);
    }
    expect(
      interactionReducer(base, {
        type: 'sketch-move-start',
        objectId: 'another_object',
        handle: 'translate'
      })
    ).toBe(base);
  });

  it('a move in progress cannot be started twice', () => {
    const started = interactionReducer(selected(), {
      type: 'sketch-move-start',
      objectId: 'circle_1',
      handle: 'rotate'
    });
    expect(
      interactionReducer(started, {
        type: 'sketch-move-start',
        objectId: 'circle_1',
        handle: 'translate'
      })
    ).toBe(started);
    expect(toolCardFor(started)?.hint).toMatch(/^Release to set the rotation/);
  });

  it('commit and cancel both end the move and keep the selection', () => {
    const started = interactionReducer(selected(), {
      type: 'sketch-move-start',
      objectId: 'circle_1',
      handle: 'translate'
    });
    for (const type of ['sketch-move-commit', 'sketch-move-cancel'] as const) {
      const ended = interactionReducer(started, { type });
      expect(moving(ended)).toBeUndefined();
      expect(ended.mode === 'sketch' && ended.session.selectedObjectId).toBe(
        'circle_1'
      );
      expect(ended).toEqual(selected());
    }
    // Ending a move that is not running is a no-op.
    const idle = selected();
    expect(interactionReducer(idle, { type: 'sketch-move-commit' })).toBe(idle);
    expect(interactionReducer(idle, { type: 'sketch-move-cancel' })).toBe(idle);
  });

  it('one Escape cancels the drag only, and the next deselects', () => {
    let state = interactionReducer(selected(), {
      type: 'sketch-move-start',
      objectId: 'circle_1',
      handle: 'translate'
    });
    state = interactionReducer(state, { type: 'escape' });
    expect(moving(state)).toBeUndefined();
    expect(state.mode === 'sketch' && state.session.selectedObjectId).toBe(
      'circle_1'
    );
    expect(escapeTarget(state)).toBe('clear-sketch-selection');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'sketch' && state.session.selectedObjectId).toBe(
      null
    );
  });

  it('does not outlive the selection or the Select tool', () => {
    const started = interactionReducer(selected(), {
      type: 'sketch-move-start',
      objectId: 'circle_1',
      handle: 'translate'
    });
    expect(
      moving(
        interactionReducer(started, {
          type: 'sketch-select-object',
          objectId: 'line_2'
        })
      )
    ).toBeUndefined();
    expect(
      moving(interactionReducer(started, { type: 'sketch-tool', tool: 'line' }))
    ).toBeUndefined();
    expect(
      moving(
        interactionReducer(started, {
          type: 'sketch-constraint-tool',
          kind: 'distance'
        })
      )
    ).toBeUndefined();
    expect(interactionReducer(started, { type: 'exit-sketch' })).toEqual(IDLE);
    // Re-selecting the same object keeps the drag it is already under.
    expect(
      moving(
        interactionReducer(started, {
          type: 'sketch-select-object',
          objectId: 'circle_1'
        })
      )
    ).toEqual({ objectId: 'circle_1', handle: 'translate' });
  });
});

describe('multi-region selection', () => {
  const second: RegionTarget = { ...region, regionFingerprint: 43 };
  const third: RegionTarget = { ...region, regionFingerprint: 44 };
  const fingerprints = (state: InteractionState) =>
    state.mode === 'region'
      ? state.targets.map((target) => target.regionFingerprint)
      : [];

  it('adds a region on Shift and counts every selected one', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    expect(commandSessionFor(state)?.target).toEqual({
      kind: 'region',
      count: 1
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    expect(fingerprints(state)).toEqual([42, 43]);
    // The newest pick anchors the default arrow and the form.
    expect(state).toMatchObject({ target: { regionFingerprint: 43 } });
    expect(commandSessionFor(state)?.target).toEqual({
      kind: 'region',
      count: 2
    });
    expect(toolCardFor(state)?.hint).toContain('all 2 regions');
  });

  it('removes an already-selected region on Shift, and the last one clears', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    expect(fingerprints(state)).toEqual([42]);
    // The anchor falls back to a region that is still selected.
    expect(state).toMatchObject({ target: { regionFingerprint: 42 } });
    expect(
      interactionReducer(state, {
        type: 'select-region',
        target: region,
        additive: true
      })
    ).toBe(IDLE);
  });

  it('replaces the whole set on a plain click', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: third
    });
    expect(fingerprints(state)).toEqual([44]);
    expect(commandSessionFor(state)?.target.count).toBe(1);
  });

  it('never mixes sketches: Shift on another sketch starts a new set', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: { ...second, sketchId: 'sketch_2' },
      additive: true
    });
    expect(fingerprints(state)).toEqual([43]);
  });

  it('clears every region at once', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    expect(interactionReducer(state, { type: 'clear' })).toBe(IDLE);
    expect(interactionReducer(state, { type: 'escape' })).toBe(IDLE);
  });

  it('expands a text glyph to every region of its entity', () => {
    const glyph = (fingerprint: number): RegionTarget => ({
      ...region,
      regionFingerprint: fingerprint,
      sourceEntityIds: ['text_1']
    });
    const word = [glyph(1), glyph(2), glyph(3)];
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: word[1]!,
      group: word
    });
    expect(fingerprints(state)).toEqual([1, 2, 3]);
    expect(state).toMatchObject({ target: { regionFingerprint: 2 } });
    expect(commandSessionFor(state)?.target.count).toBe(3);
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    expect(fingerprints(state)).toEqual([1, 2, 3, 43]);
    // Shift on any glyph of the word removes the whole word: it cannot be
    // built in part.
    state = interactionReducer(state, {
      type: 'select-region',
      target: word[0]!,
      group: word,
      additive: true
    });
    expect(fingerprints(state)).toEqual([43]);
  });

  it('re-arms the same set when the pick repeats it as a group', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
    });
    state = interactionReducer(state, {
      type: 'select-region',
      target: second,
      additive: true
    });
    state = interactionReducer(state, {
      type: 'validation-failed',
      diagnostic: { message: 'No' }
    });
    if (state.mode !== 'region') throw new Error('expected region');
    const rearmed = interactionReducer(state, {
      type: 'select-region',
      target: state.target,
      group: state.targets
    });
    expect(fingerprints(rearmed)).toEqual([42, 43]);
    expect(rearmed).toMatchObject({ phase: 'armed', error: null });
  });
});
