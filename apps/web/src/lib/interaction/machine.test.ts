import { describe, expect, it } from 'vitest';
import {
  IDLE,
  escapeTarget,
  interactionReducer,
  toolCardFor,
  type FaceTarget,
  type InteractionState,
  type RegionTarget
} from './machine';
import type { SketchPlaneRef, TopologySelection } from '@openzcad/shared';

const face = (overrides: Partial<FaceTarget> = {}): FaceTarget => ({
  bodyId: 'body_1',
  topologyId: 'face:3',
  hash: 3,
  point: [1, 2, 3],
  normal: [0, 0, 1],
  surfaceType: 'planar',
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
  area: 100
};

const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 0 };

describe('interactionReducer', () => {
  it('arms offset-face for planar faces and resize-hole for measured cylinders', () => {
    const planar = interactionReducer(IDLE, {
      type: 'select-face',
      target: face()
    });
    expect(planar.mode).toBe('face');
    expect(planar.mode === 'face' && planar.op).toBe('offset-face');

    const bore = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ surfaceType: 'cylindrical', diameter: 8 })
    });
    expect(bore.mode === 'face' && bore.op).toBe('resize-hole');

    // Cylindrical without a measurable diameter has no safe direct action.
    const boss = interactionReducer(IDLE, {
      type: 'select-face',
      target: face({ surfaceType: 'cylindrical' })
    });
    expect(boss).toEqual(IDLE);
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
      message: 'Face would self-intersect.'
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
    state = interactionReducer(state, { type: 'exit-sketch' });
    expect(state).toEqual(IDLE);
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
    expect(escapeTarget(state)).toBe('exit-sketch');
    state = interactionReducer(state, { type: 'escape' });
    expect(state).toEqual(IDLE);
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
      message: 'Self-intersection.'
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
    expect(faceCard?.actions?.map((action) => action.label)).toEqual([
      'Offset Face',
      'Sketch'
    ]);
    const holeCard = toolCardFor(
      interactionReducer(IDLE, {
        type: 'select-face',
        target: face({ surfaceType: 'cylindrical', diameter: 8 })
      })
    );
    expect(holeCard?.title).toBe('Resize Hole');
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
});
