import { describe, expect, it } from 'vitest';
import {
  IDLE,
  commandSessionFor,
  radialFaceOperationName,
  escapeTarget,
  interactionReducer,
  toolCardFor,
  type FaceTarget,
  type InteractionState,
  type RegionTarget
} from './machine';
import type {
  FaceTopologyReferenceV5,
  FeatureId,
  SketchPlaneRef,
  TopologySelection
} from '@openzcad/shared';
import { UNSTABLE_FACE_SKETCH_REASON } from '../faceSketchAttachment';

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
    expect(
      state.mode === 'sketch' && state.session.pendingConstraint
    ).toEqual({ kind: 'parallel', picks: [] });
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
});

describe('escape chain', () => {
  it('closes exact entry before clearing the selection', () => {
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

  it('keeps validating operations locked and recovers failed values first', () => {
    let state = interactionReducer(IDLE, {
      type: 'select-region',
      target: region
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
    expect(escapeTarget(state)).toBe('recover-failure');
    state = interactionReducer(state, { type: 'escape' });
    expect(state.mode === 'region' && state.phase).toBe('armed');
    expect(state.mode === 'region' && state.lastValue).toBe(24);
  });
});

describe('toolCardFor', () => {
  it('describes each mode', () => {
    expect(toolCardFor(IDLE)).toBeNull();
    const faceCard = toolCardFor(
      interactionReducer(IDLE, { type: 'select-face', target: face() })
    );
    expect(faceCard?.title).toBe('Offset Face');
    expect(faceCard?.hint).toContain('Space faces it head-on');
    expect(faceCard?.actions?.map((action) => action.label)).toEqual([
      'Offset Face',
      'Sketch',
      'Export DXF'
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

  it('exposes why sketch is unavailable on a hash-only planar face', () => {
    const card = toolCardFor(
      interactionReducer(IDLE, {
        type: 'select-face',
        target: face({ reference: undefined })
      })
    );
    expect(
      card?.actions?.find((action) => action.id === 'sketch-on-face')
    ).toMatchObject({
      enabled: false
    });
    // Compare against the constant, not a phrase from it: the wording is
    // user-facing copy and has already been rewritten once underneath these
    // assertions.
    expect(
      card?.actions?.find((action) => action.id === 'sketch-on-face')
        ?.disabledReason
    ).toBe(UNSTABLE_FACE_SKETCH_REASON);
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
        face({ surfaceType: 'cylindrical', radius: 4, featureType: 'through-hole' })
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
