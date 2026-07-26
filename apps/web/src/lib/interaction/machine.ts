import type { SketchPlaneRef, TopologySelection } from '@openzcad/shared';

/**
 * The selection-first interaction machine.
 *
 * Clicking geometry infers the operation: a face arms Offset Face (or hole
 * resize when the face is a cylindrical bore), edges arm Chamfer/Fillet, a
 * sketch region arms Extrude, and entering a sketch nests a drawing session.
 * The reducer only handles these coarse transitions — per-frame drag values
 * stay in the viewport's imperative layer and never pass through React.
 */

export interface FaceTarget {
  bodyId: string;
  topologyId: string;
  hash?: number;
  /** World-space click point captured at selection. */
  point: [number, number, number];
  /** Outward face normal at the click point. */
  normal: [number, number, number];
  surfaceType: 'planar' | 'cylindrical' | 'other';
  /** Present for cylindrical bores with an editable diameter. */
  diameter?: number;
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
  /** True while a drawing gesture (drag or line chain) is in flight. */
  drawing: boolean;
}

export type InteractionState =
  | { mode: 'idle' }
  | {
      mode: 'face';
      target: FaceTarget;
      op: 'offset-face' | 'resize-hole';
      /** True while the handle drag is in flight. */
      engaged: boolean;
      keypadOpen: boolean;
    }
  | {
      mode: 'edges';
      edges: TopologySelection[];
      op: 'fillet' | 'chamfer';
      engaged: boolean;
      keypadOpen: boolean;
    }
  | {
      mode: 'region';
      target: RegionTarget;
      engaged: boolean;
      keypadOpen: boolean;
    }
  | { mode: 'sketch'; session: SketchSessionState; keypadOpen: boolean };

export type InteractionEvent =
  | { type: 'select-face'; target: FaceTarget }
  | { type: 'select-edge'; selection: TopologySelection; additive: boolean }
  | { type: 'select-region'; target: RegionTarget }
  | { type: 'drag-engage' }
  | { type: 'drag-release' }
  | { type: 'toggle-edge-op' }
  | { type: 'keypad-open' }
  | { type: 'keypad-close' }
  | { type: 'enter-sketch'; plane: SketchPlaneRef; sketchId?: string }
  | { type: 'sketch-tool'; tool: SketchToolId }
  | { type: 'sketch-created'; sketchId: string }
  | { type: 'sketch-drawing'; drawing: boolean }
  | { type: 'exit-sketch' }
  | { type: 'escape' }
  | { type: 'clear' }
  | { type: 'commit-complete' };

export const IDLE: InteractionState = { mode: 'idle' };

/** What the next Escape press should do, in Shapr-style priority order. */
export function escapeTarget(
  state: InteractionState
):
  | 'close-keypad'
  | 'cancel-drag'
  | 'end-drawing'
  | 'clear-selection'
  | 'exit-sketch'
  | 'none' {
  if (state.mode === 'idle') {
    return 'none';
  }
  if (state.keypadOpen) {
    return 'close-keypad';
  }
  if (state.mode === 'sketch') {
    return state.session.drawing ? 'end-drawing' : 'exit-sketch';
  }
  if (state.engaged) {
    return 'cancel-drag';
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
      return {
        mode: 'face',
        target: event.target,
        op:
          event.target.surfaceType === 'cylindrical' &&
          event.target.diameter !== undefined
            ? 'resize-hole'
            : 'offset-face',
        engaged: false,
        keypadOpen: false
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
      return {
        mode: 'edges',
        edges,
        op: state.mode === 'edges' ? state.op : 'fillet',
        engaged: false,
        keypadOpen: false
      };
    }
    case 'select-region': {
      if (state.mode === 'sketch') {
        return state;
      }
      return {
        mode: 'region',
        target: event.target,
        engaged: false,
        keypadOpen: false
      };
    }
    case 'drag-engage': {
      if (state.mode === 'idle' || state.mode === 'sketch') {
        return state;
      }
      return { ...state, engaged: true, keypadOpen: false };
    }
    case 'drag-release': {
      if (state.mode === 'idle' || state.mode === 'sketch') {
        return state;
      }
      return { ...state, engaged: false };
    }
    case 'toggle-edge-op': {
      if (state.mode !== 'edges') {
        return state;
      }
      return { ...state, op: state.op === 'fillet' ? 'chamfer' : 'fillet' };
    }
    case 'keypad-open': {
      if (state.mode === 'idle') {
        return state;
      }
      return { ...state, keypadOpen: true };
    }
    case 'keypad-close': {
      if (state.mode === 'idle') {
        return state;
      }
      return { ...state, keypadOpen: false };
    }
    case 'enter-sketch': {
      return {
        mode: 'sketch',
        session: {
          sketchId: event.sketchId ?? null,
          plane: event.plane,
          tool: 'line',
          drawing: false
        },
        keypadOpen: false
      };
    }
    case 'sketch-tool': {
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: { ...state.session, tool: event.tool, drawing: false }
      };
    }
    case 'sketch-created': {
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: { ...state.session, sketchId: event.sketchId }
      };
    }
    case 'sketch-drawing': {
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: { ...state.session, drawing: event.drawing },
        keypadOpen: event.drawing ? state.keypadOpen : false
      };
    }
    case 'exit-sketch': {
      return state.mode === 'sketch' ? IDLE : state;
    }
    case 'escape': {
      switch (escapeTarget(state)) {
        case 'close-keypad':
          return interactionReducer(state, { type: 'keypad-close' });
        case 'cancel-drag':
          return interactionReducer(state, { type: 'drag-release' });
        case 'end-drawing':
          return interactionReducer(state, {
            type: 'sketch-drawing',
            drawing: false
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
    case 'commit-complete': {
      // Committing an operation returns to a clean slate; the tool card
      // disappears and geometry is deselected, matching the reference flow.
      return state.mode === 'sketch' ? state : IDLE;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool card
// ---------------------------------------------------------------------------

export type ToolCardIcon =
  | 'offset-face'
  | 'resize-hole'
  | 'fillet'
  | 'extrude'
  | 'sketch';

export interface ToolCardModel {
  icon: ToolCardIcon;
  title: string;
  /** Two-option sub-mode toggle (e.g. Fillet ↔ Chamfer). */
  subMode?: { options: [string, string]; active: 0 | 1 };
  hint: string;
}

export function toolCardFor(state: InteractionState): ToolCardModel | null {
  switch (state.mode) {
    case 'idle':
      return null;
    case 'face':
      return state.op === 'resize-hole'
        ? {
            icon: 'resize-hole',
            title: 'Resize Hole',
            hint: 'Drag the arrow or tap the value to set the diameter.'
          }
        : {
            icon: 'offset-face',
            title: 'Offset Face',
            hint: 'Drag the arrow to offset the face, or tap the value to type.'
          };
    case 'edges':
      return {
        icon: 'fillet',
        title: state.op === 'fillet' ? 'Fillet' : 'Chamfer',
        subMode: {
          options: ['Fillet', 'Chamfer'],
          active: state.op === 'fillet' ? 0 : 1
        },
        hint:
          state.edges.length > 1
            ? `Drag to round ${state.edges.length} edges together.`
            : 'Drag the handle to round the edge, or tap the value to type.'
      };
    case 'region':
      return {
        icon: 'extrude',
        title: 'Extrude',
        hint: 'Drag the region to pull it into a solid.'
      };
    case 'sketch':
      return {
        icon: 'sketch',
        title: 'Sketch',
        hint: 'Draw with Line, Arc, Circle, or Rectangle. Esc ends a chain.'
      };
  }
}
