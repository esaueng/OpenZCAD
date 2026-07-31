import type {
  FaceTopologyReferenceV5,
  SketchPlaneRef,
  TopologySelection
} from '@openzcad/shared';
import {
  preferredCapability,
  selectionCapabilities,
  type FaceCapabilityTarget,
  type SelectionActionId
} from './capabilities';

/**
 * The selection-first interaction machine.
 *
 * Per-frame drag values stay in the viewport's imperative layer. The reducer
 * owns semantic lifecycle only, including exact validation and recoverable
 * failure.
 */

export interface FaceTarget extends FaceCapabilityTarget {
  bodyId: string;
  topologyId: string;
  /** Persistent exact identity when the current kernel projection proves it. */
  reference?: FaceTopologyReferenceV5;
  /** World-space click point captured at selection. */
  point: [number, number, number];
  /** Outward face normal at the click point. */
  normal: [number, number, number];
  /** Fixed world-space axis snapshot for a cylindrical radius gesture. */
  axisStart?: [number, number, number];
  axisEnd?: [number, number, number];
  axialLength?: number;
  radialDirection?: [number, number, number];
  concavity?: 'hole' | 'boss';
}

export interface RegionTarget {
  sketchId: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  area: number;
}

export type SketchToolId = 'select' | 'line' | 'arc' | 'circle' | 'rectangle';

export interface SketchSessionState {
  /** Null until the first entity commit creates the sketch node. */
  sketchId: string | null;
  plane: SketchPlaneRef;
  tool: SketchToolId;
  /** True while a drawing gesture (drag or line/arc chain) is in flight. */
  drawing: boolean;
  /** Stable document id of the entity selected for editing. */
  selectedObjectId: string | null;
}

export type OperationPhase =
  'armed' | 'dragging' | 'exact-entry' | 'validating' | 'failed';

interface OperationLifecycle {
  phase: OperationPhase;
  /** Last submitted value, retained when exact validation fails. */
  lastValue: number | null;
  /** Exact-kernel failure; only present in the failed phase. */
  error: string | null;
}

export type InteractionState =
  | { mode: 'idle' }
  | ({
      mode: 'face';
      target: FaceTarget;
      op: 'offset-face' | 'resize-cylinder-radius';
    } & OperationLifecycle)
  | ({
      mode: 'edges';
      edges: TopologySelection[];
      op: 'fillet' | 'chamfer';
    } & OperationLifecycle)
  | ({
      mode: 'region';
      target: RegionTarget;
    } & OperationLifecycle)
  | { mode: 'sketch'; session: SketchSessionState };

export type InteractionEvent =
  | { type: 'select-face'; target: FaceTarget }
  | { type: 'select-edge'; selection: TopologySelection; additive: boolean }
  | { type: 'select-region'; target: RegionTarget }
  | { type: 'drag-engage' }
  | { type: 'drag-release' }
  | { type: 'set-edge-op'; op: 'fillet' | 'chamfer' }
  | { type: 'toggle-edge-op' }
  | { type: 'keypad-open' }
  | { type: 'keypad-close' }
  | { type: 'validation-start'; value: number }
  | { type: 'validation-failed'; message: string; value?: number }
  | { type: 'recover' }
  | { type: 'enter-sketch'; plane: SketchPlaneRef; sketchId?: string }
  | { type: 'sketch-tool'; tool: SketchToolId }
  | { type: 'sketch-created'; sketchId: string }
  | { type: 'sketch-drawing'; drawing: boolean }
  | { type: 'sketch-select-object'; objectId: string | null }
  | { type: 'exit-sketch' }
  | { type: 'escape' }
  | { type: 'clear' }
  | { type: 'commit-complete' };

export const IDLE: InteractionState = { mode: 'idle' };

const ARMED: OperationLifecycle = {
  phase: 'armed',
  lastValue: null,
  error: null
};

function isOperationState(
  state: InteractionState
): state is Exclude<InteractionState, { mode: 'idle' } | { mode: 'sketch' }> {
  return state.mode !== 'idle' && state.mode !== 'sketch';
}

/** What the next Escape press should do, innermost state first. */
export function escapeTarget(
  state: InteractionState
):
  | 'close-keypad'
  | 'cancel-drag'
  | 'recover-failure'
  | 'end-drawing'
  | 'exit-drawing-tool'
  | 'clear-sketch-selection'
  | 'clear-selection'
  | 'exit-sketch'
  | 'none' {
  if (state.mode === 'idle') {
    return 'none';
  }
  if (state.mode === 'sketch') {
    if (state.session.drawing) {
      return 'end-drawing';
    }
    if (state.session.tool !== 'select') {
      return 'exit-drawing-tool';
    }
    return state.session.selectedObjectId
      ? 'clear-sketch-selection'
      : 'exit-sketch';
  }
  if (state.phase === 'validating') {
    return 'none';
  }
  if (state.phase === 'exact-entry') {
    return 'close-keypad';
  }
  if (state.phase === 'dragging') {
    return 'cancel-drag';
  }
  if (state.phase === 'failed') {
    return 'recover-failure';
  }
  return 'clear-selection';
}

export function interactionReducer(
  state: InteractionState,
  event: InteractionEvent
): InteractionState {
  switch (event.type) {
    case 'select-face': {
      if (state.mode === 'sketch') {
        return state;
      }
      const preferred = preferredCapability(
        selectionCapabilities({ kind: 'face', target: event.target })
      );
      if (!preferred) {
        return IDLE;
      }
      return {
        mode: 'face',
        target: event.target,
        op:
          preferred.action === 'resize-radial-face'
            ? 'resize-cylinder-radius'
            : 'offset-face',
        ...ARMED
      };
    }
    case 'select-edge': {
      if (state.mode === 'sketch') {
        return state;
      }
      const existing =
        state.mode === 'edges' && event.additive ? state.edges : [];
      const already = existing.some(
        (edge) => edge.hash === event.selection.hash
      );
      const edges = already
        ? existing.filter((edge) => edge.hash !== event.selection.hash)
        : [...existing, event.selection];
      if (edges.length === 0) {
        return IDLE;
      }
      const sameBody = edges.every((edge) => edge.bodyId === edges[0]?.bodyId);
      if (
        selectionCapabilities({
          kind: 'edges',
          count: edges.length,
          sameBody
        }).length === 0
      ) {
        return IDLE;
      }
      return {
        mode: 'edges',
        edges,
        op: state.mode === 'edges' ? state.op : 'fillet',
        ...ARMED
      };
    }
    case 'select-region': {
      if (state.mode === 'sketch') {
        return state;
      }
      if (
        selectionCapabilities({ kind: 'region', area: event.target.area })
          .length === 0
      ) {
        return IDLE;
      }
      return {
        mode: 'region',
        target: event.target,
        ...ARMED
      };
    }
    case 'drag-engage':
      return isOperationState(state) && state.phase !== 'validating'
        ? { ...state, phase: 'dragging', error: null }
        : state;
    case 'drag-release':
      return isOperationState(state) && state.phase === 'dragging'
        ? { ...state, phase: 'armed' }
        : state;
    case 'set-edge-op':
      return state.mode === 'edges'
        ? { ...state, op: event.op, ...ARMED }
        : state;
    case 'toggle-edge-op':
      return state.mode === 'edges'
        ? {
            ...state,
            op: state.op === 'fillet' ? 'chamfer' : 'fillet',
            ...ARMED
          }
        : state;
    case 'keypad-open':
      return isOperationState(state) && state.phase !== 'validating'
        ? { ...state, phase: 'exact-entry', error: null }
        : state;
    case 'keypad-close':
      return isOperationState(state) && state.phase === 'exact-entry'
        ? { ...state, phase: 'armed' }
        : state;
    case 'validation-start':
      return isOperationState(state)
        ? {
            ...state,
            phase: 'validating',
            lastValue: event.value,
            error: null
          }
        : state;
    case 'validation-failed':
      return isOperationState(state)
        ? {
            ...state,
            phase: 'failed',
            lastValue: event.value ?? state.lastValue,
            error: event.message
          }
        : state;
    case 'recover':
      return isOperationState(state) && state.phase === 'failed'
        ? { ...state, phase: 'armed', error: null }
        : state;
    case 'enter-sketch':
      return {
        mode: 'sketch',
        session: {
          sketchId: event.sketchId ?? null,
          plane: event.plane,
          tool: 'line',
          drawing: false,
          selectedObjectId: null
        }
      };
    case 'sketch-tool':
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          tool: event.tool,
          drawing: false,
          selectedObjectId:
            event.tool === 'select' ? state.session.selectedObjectId : null
        }
      };
    case 'sketch-created':
      return state.mode === 'sketch'
        ? {
            ...state,
            session: { ...state.session, sketchId: event.sketchId }
          }
        : state;
    case 'sketch-drawing':
      return state.mode === 'sketch'
        ? {
            ...state,
            session: { ...state.session, drawing: event.drawing }
          }
        : state;
    case 'sketch-select-object':
      return state.mode === 'sketch'
        ? {
            ...state,
            session: {
              ...state.session,
              tool: 'select',
              drawing: false,
              selectedObjectId: event.objectId
            }
          }
        : state;
    case 'exit-sketch':
      return state.mode === 'sketch' ? IDLE : state;
    case 'escape': {
      switch (escapeTarget(state)) {
        case 'close-keypad':
          return interactionReducer(state, { type: 'keypad-close' });
        case 'cancel-drag':
          return interactionReducer(state, { type: 'drag-release' });
        case 'recover-failure':
          return interactionReducer(state, { type: 'recover' });
        case 'end-drawing':
          return interactionReducer(state, {
            type: 'sketch-drawing',
            drawing: false
          });
        case 'exit-drawing-tool':
          return interactionReducer(state, {
            type: 'sketch-tool',
            tool: 'select'
          });
        case 'clear-sketch-selection':
          return interactionReducer(state, {
            type: 'sketch-select-object',
            objectId: null
          });
        case 'clear-selection':
        case 'exit-sketch':
          return IDLE;
        case 'none':
          return state;
      }
      return state;
    }
    case 'clear':
      return state.mode === 'sketch' ? state : IDLE;
    case 'commit-complete':
      return state.mode === 'sketch' ? state : IDLE;
  }
}

// ---------------------------------------------------------------------------
// Tool card
// ---------------------------------------------------------------------------

export type ToolCardIcon =
  'offset-face' | 'resize-cylinder-radius' | 'fillet' | 'extrude' | 'sketch';

export interface ToolCardAction {
  id: SelectionActionId;
  label: string;
  active: boolean;
}

export interface ToolCardModel {
  icon: ToolCardIcon;
  title: string;
  actions?: ToolCardAction[];
  hint: string;
  phase?: OperationPhase;
  error?: string;
}

function lifecycleHint(
  state: Extract<InteractionState, { mode: 'face' | 'edges' | 'region' }>,
  armedHint: string
): Pick<ToolCardModel, 'hint' | 'phase' | 'error'> {
  if (state.phase === 'validating') {
    return {
      phase: state.phase,
      hint: 'Validating with the exact geometry kernel…'
    };
  }
  if (state.phase === 'failed') {
    return {
      phase: state.phase,
      hint: 'Adjust the value and try again.',
      error: state.error ?? 'The exact operation was rejected.'
    };
  }
  return { phase: state.phase, hint: armedHint };
}

export function toolCardFor(state: InteractionState): ToolCardModel | null {
  switch (state.mode) {
    case 'idle':
      return null;
    case 'face': {
      const capabilities = selectionCapabilities({
        kind: 'face',
        target: state.target
      });
      const actions = capabilities.map((capability) => ({
        id: capability.action,
        label: capability.label,
        active:
          (state.op === 'offset-face' && capability.action === 'offset-face') ||
          (state.op === 'resize-cylinder-radius' &&
            capability.action === 'resize-radial-face')
      }));
      return state.op === 'resize-cylinder-radius'
        ? {
            icon: 'resize-cylinder-radius',
            title: 'Resize Cylinder Radius',
            ...(actions.length > 1 ? { actions } : {}),
            ...lifecycleHint(
              state,
              'Drag the radial handle or tap the value to set the radius.'
            )
          }
        : {
            icon: 'offset-face',
            title: 'Offset Face',
            ...(actions.length > 1 ? { actions } : {}),
            ...lifecycleHint(
              state,
              'Drag the arrow to offset the face, or tap the value to type.'
            )
          };
    }
    case 'edges': {
      const actions = selectionCapabilities({
        kind: 'edges',
        count: state.edges.length,
        sameBody: state.edges.every(
          (edge) => edge.bodyId === state.edges[0]?.bodyId
        )
      }).map((capability) => ({
        id: capability.action,
        label: capability.label,
        active: capability.action === state.op
      }));
      return {
        icon: 'fillet',
        title: state.op === 'fillet' ? 'Fillet' : 'Chamfer',
        actions,
        ...lifecycleHint(
          state,
          state.edges.length > 1
            ? `Drag to finish ${state.edges.length} edges together.`
            : 'Drag the handle, or tap the value to type.'
        )
      };
    }
    case 'region':
      return {
        icon: 'extrude',
        title: 'Extrude',
        ...lifecycleHint(state, 'Drag the region to pull it into a solid.')
      };
    case 'sketch':
      return {
        icon: 'sketch',
        title: 'Sketch',
        hint:
          state.session.tool === 'select'
            ? 'Select an entity to edit its exact values.'
            : 'Draw with Line, Arc, Circle, or Rectangle. Esc ends a chain.'
      };
  }
}
