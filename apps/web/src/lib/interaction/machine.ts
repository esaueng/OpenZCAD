import type { SketchPlaneRef, TopologySelection } from '@openzcad/shared';
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
  /** World-space click point captured at selection. */
  point: [number, number, number];
  /** Outward face normal at the click point. */
  normal: [number, number, number];
  /** Frozen exact face center used to re-resolve planar preview topology. */
  surfaceCenter?: [number, number, number];
  /** Fixed world-space axis snapshot for a cylindrical radius gesture. */
  axisStart?: [number, number, number];
  axisEnd?: [number, number, number];
  axialLength?: number;
  radialDirection?: [number, number, number];
  concavity?: 'hole' | 'boss';
  /** Semantic exact-surface role needed to choose the matching edit op. */
  featureType?: 'through-hole' | 'blend';
  diameter?: number;
  /** Latest replayable edit that owns an imported blend band. */
  directEditFeatureId?: string;
  blendSurfaceClass?: 'torus' | 'cylinder';
  blendCenter?: [number, number, number];
  blendAxis?: [number, number, number];
}

export interface RegionTarget {
  sketchId: string;
  regionFingerprint: number;
  samplePoint: { x: number; y: number };
  area: number;
  /**
   * Entities whose curves bound this region. Carried so the drag-to-extrude
   * path can store an entity-wide reference for text regions — a fingerprint
   * reference to a glyph breaks the moment the string is edited, which is
   * exactly the edit text exists to support.
   */
  sourceEntityIds: string[];
}

export type SketchToolId =
  'select' | 'line' | 'arc' | 'circle' | 'rectangle' | 'text';

/** Construction method used by the shared Circle tool. */
export type SketchCircleMode =
  'center-radius' | 'two-point-diameter' | 'three-point';

/** Constraint tools exposed by the sketch rail. */
export type SketchConstraintToolKind =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equal'
  | 'tangent'
  | 'concentric'
  | 'coincident'
  | 'midpoint'
  | 'radius';

export type SketchConstraintPick =
  | { kind: 'object'; objectId: string }
  | { kind: 'point'; objectId: string; point: 'start' | 'end' | 'center' };

/** An armed constraint tool collecting viewport picks. */
export interface PendingSketchConstraint {
  kind: SketchConstraintToolKind;
  picks: SketchConstraintPick[];
}

export interface SketchSessionState {
  /** Null until the first entity commit creates the sketch node. */
  sketchId: string | null;
  plane: SketchPlaneRef;
  tool: SketchToolId;
  circleMode: SketchCircleMode;
  /** True while a drawing gesture (drag or line/arc chain) is in flight. */
  drawing: boolean;
  /** Stable document id of the entity selected for editing. */
  selectedObjectId: string | null;
  /** Armed constraint tool, if any; picking routes here instead of select. */
  pendingConstraint: PendingSketchConstraint | null;
}

export type OperationPhase =
  'armed' | 'dragging' | 'exact-entry' | 'validating' | 'failed';

/**
 * A refusal, in the pieces a user can act on.
 *
 * The kernel's own sentence is the whole of what a rejection used to be, shown
 * as a red paragraph with nothing to do about it. Splitting it lets the cause
 * lead, the machinery wait behind a disclosure, and — where the refusal names
 * an existing feature — the way out be a button rather than a suggestion.
 */
export interface CommandDiagnostic {
  /** One plain sentence naming the cause. */
  message: string;
  /** Kernel text, shown only on request. */
  detail?: string;
  /**
   * The existing feature whose rebuild refused, when the failure names one.
   * A new fillet that cannot be built beside an older one fails as the older
   * one, and that feature is where the user has to go.
   */
  culprit?: { featureId: string; featureName: string };
}

interface OperationLifecycle {
  phase: OperationPhase;
  /** Last submitted value, retained when exact validation fails. */
  lastValue: number | null;
  /** Exact-kernel failure; only present in the failed phase. */
  error: CommandDiagnostic | null;
}

export type InteractionState =
  | { mode: 'idle' }
  | ({
      mode: 'face';
      target: FaceTarget;
      op:
        | 'offset-face'
        | 'resize-cylinder-radius'
        | 'edit-fillet'
        | 'remove-face-feature';
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
  | {
      type: 'validation-failed';
      diagnostic: CommandDiagnostic;
      value?: number;
    }
  | { type: 'recover' }
  | { type: 'enter-sketch'; plane: SketchPlaneRef; sketchId?: string }
  | { type: 'sketch-tool'; tool: SketchToolId }
  | { type: 'sketch-circle-mode'; mode: SketchCircleMode }
  | { type: 'sketch-created'; sketchId: string }
  | { type: 'sketch-drawing'; drawing: boolean }
  | { type: 'sketch-select-object'; objectId: string | null }
  | {
      type: 'sketch-constraint-tool';
      kind: SketchConstraintToolKind | null;
    }
  | { type: 'sketch-constraint-pick'; pick: SketchConstraintPick }
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

/**
 * Whether a command surface is showing this state's lifecycle. Callers use it
 * to decide who owns a diagnostic: a command that can display its own failure
 * must not also push it into the workspace status line.
 */
export function isOperationState(
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
  | 'cancel-constraint'
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
    // A pick sequence in flight is the innermost sketch state: Escape must
    // abandon it, never fall through and exit the sketch mid-pick.
    if (state.session.pendingConstraint) {
      return 'cancel-constraint';
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
            : preferred.action === 'edit-fillet'
              ? 'edit-fillet'
              : preferred.action === 'remove-face-feature'
                ? 'remove-face-feature'
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
            error: event.diagnostic
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
          circleMode: 'center-radius',
          drawing: false,
          selectedObjectId: null,
          pendingConstraint: null
        }
      };
    case 'sketch-circle-mode':
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          tool: 'circle',
          circleMode: event.mode,
          drawing: false,
          selectedObjectId: null,
          pendingConstraint: null
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
            event.tool === 'select' ? state.session.selectedObjectId : null,
          pendingConstraint: null
        }
      };
    case 'sketch-constraint-tool':
      if (state.mode !== 'sketch') {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          // Picking rides the select tool's hit-testing, so arming a
          // constraint always lands there; re-arming the same kind restarts
          // its pick sequence.
          tool: 'select',
          drawing: false,
          pendingConstraint: event.kind
            ? { kind: event.kind, picks: [] }
            : null
        }
      };
    case 'sketch-constraint-pick':
      if (state.mode !== 'sketch' || !state.session.pendingConstraint) {
        return state;
      }
      return {
        ...state,
        session: {
          ...state.session,
          pendingConstraint: {
            ...state.session.pendingConstraint,
            picks: [...state.session.pendingConstraint.picks, event.pick]
          }
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
        case 'cancel-constraint':
          return interactionReducer(state, {
            type: 'sketch-constraint-tool',
            kind: null
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
  enabled: boolean;
  disabledReason?: string;
}

export interface ToolCardModel {
  icon: ToolCardIcon;
  title: string;
  actions?: ToolCardAction[];
  hint: string;
  phase?: OperationPhase;
  error?: CommandDiagnostic;
}

/** Stable identity of the command a selection has armed. */
export type CommandId =
  | 'offset-face'
  | 'resize-cylinder-radius'
  | 'edit-fillet'
  | 'remove-face-feature'
  | 'fillet'
  | 'chamfer'
  | 'extrude-region'
  | 'sketch';

/**
 * Names a radial face edit after the thing being edited.
 *
 * "Resize Cylinder Radius" described the kernel's view — a cylindrical surface
 * and the parameter that defines it — while the value beside it was labelled
 * Diameter, so the command and its own number disagreed about what was being
 * set. Naming the object instead removes the disagreement rather than keeping
 * two labels in step: the chip owns the quantity, and switching Ø/R cannot
 * make the title wrong.
 *
 * Used for the command surface and for the feature this edit writes into
 * history, so the operation is called the same thing while it runs and
 * afterwards.
 *
 * Only the inward-facing case is named specifically. `concavity` comes from
 * the surface normal, so it reports 'boss' for the outer wall of a plain
 * cylinder just as it does for a raised boss, and nothing published
 * distinguishes them — "Resize Cylinder" is true of both, where "Resize Boss"
 * would be wrong half the time.
 */
export function radialFaceOperationName(target: FaceTarget): string {
  return target.featureType === 'through-hole' || target.concavity === 'hole'
    ? 'Resize Hole'
    : 'Resize Cylinder';
}

interface CommandIdentity {
  id: CommandId;
  icon: ToolCardIcon;
  title: string;
}

/**
 * The one place a running command gets its name.
 *
 * Every surface that names the active command reads this, so the tool card,
 * the inspector, and a diagnostic cannot disagree about which command is
 * running. Adding a second label here is the defect this function exists to
 * prevent.
 */
function commandIdentityFor(state: InteractionState): CommandIdentity | null {
  switch (state.mode) {
    case 'idle':
      return null;
    case 'face':
      switch (state.op) {
        case 'edit-fillet':
          return { id: 'edit-fillet', icon: 'fillet', title: 'Edit Fillet' };
        case 'remove-face-feature':
          return {
            id: 'remove-face-feature',
            icon: 'fillet',
            title: 'Blend Face'
          };
        case 'resize-cylinder-radius':
          return {
            id: 'resize-cylinder-radius',
            icon: 'resize-cylinder-radius',
            title: radialFaceOperationName(state.target)
          };
        case 'offset-face':
          return {
            id: 'offset-face',
            icon: 'offset-face',
            title: 'Offset Face'
          };
      }
      break;
    case 'edges':
      return state.op === 'fillet'
        ? { id: 'fillet', icon: 'fillet', title: 'Fillet' }
        : { id: 'chamfer', icon: 'fillet', title: 'Chamfer' };
    case 'region':
      return { id: 'extrude-region', icon: 'extrude', title: 'Extrude' };
    case 'sketch':
      return { id: 'sketch', icon: 'sketch', title: 'Sketch' };
  }
  return null;
}

/** What the running command is acting on. */
export interface CommandTarget {
  kind: 'face' | 'edges' | 'region' | 'sketch';
  count: number;
}

/**
 * The active command, as every surface outside the viewport sees it.
 *
 * Deliberately carries no per-frame drag value: those stay in the viewport's
 * imperative layer so a pointer move costs no React render. What lives here is
 * the semantic lifecycle — which command, on what, in which phase, with which
 * rejection — and it is read, never mirrored into a second piece of state.
 */
export interface CommandSession {
  id: CommandId;
  title: string;
  target: CommandTarget;
  /** Null in sketch mode, which has no value lifecycle of its own. */
  phase: OperationPhase | null;
  /** Exact-kernel rejection owned by this command; cleared when it re-arms. */
  error: CommandDiagnostic | null;
}

export function commandSessionFor(
  state: InteractionState
): CommandSession | null {
  const identity = commandIdentityFor(state);
  if (!identity) {
    return null;
  }
  const target: CommandTarget =
    state.mode === 'edges'
      ? { kind: 'edges', count: state.edges.length }
      : state.mode === 'face'
        ? { kind: 'face', count: 1 }
        : state.mode === 'region'
          ? { kind: 'region', count: 1 }
          : { kind: 'sketch', count: 0 };
  return {
    id: identity.id,
    title: identity.title,
    target,
    phase: isOperationState(state) ? state.phase : null,
    error: isOperationState(state) ? state.error : null
  };
}

/**
 * A stale stored selection fails at EVERY value, so "try again" advice would
 * send the user in circles; the error text carries its own repair guidance.
 */
export function isStaleSelectionError(
  error: CommandDiagnostic | null | undefined
): boolean {
  return /no longer exists/.test(error?.message ?? '');
}

function lifecycleHint(
  state: Extract<InteractionState, { mode: 'face' | 'edges' | 'region' }>,
  armedHint: string
): Pick<ToolCardModel, 'hint' | 'phase' | 'error'> {
  if (state.phase === 'validating') {
    return {
      phase: state.phase,
      hint: 'Checking geometry…'
    };
  }
  if (state.phase === 'failed') {
    return {
      phase: state.phase,
      hint: isStaleSelectionError(state.error)
        ? 'Esc closes the tool.'
        : 'Adjust the value and try again.',
      error: state.error ?? {
        message: 'The exact operation was rejected.'
      }
    };
  }
  return { phase: state.phase, hint: armedHint };
}

export function toolCardFor(state: InteractionState): ToolCardModel | null {
  const identity = commandIdentityFor(state);
  if (!identity) {
    return null;
  }
  const { icon, title } = identity;
  switch (state.mode) {
    case 'face': {
      const capabilities = selectionCapabilities({
        kind: 'face',
        target: state.target
      });
      const actions = capabilities.map((capability) => ({
        id: capability.action,
        label: capability.label,
        enabled: capability.enabled,
        ...(capability.disabledReason
          ? { disabledReason: capability.disabledReason }
          : {}),
        active:
          (state.op === 'offset-face' && capability.action === 'offset-face') ||
          (state.op === 'resize-cylinder-radius' &&
            capability.action === 'resize-radial-face') ||
          (state.op === 'edit-fillet' && capability.action === 'edit-fillet') ||
          (state.op === 'remove-face-feature' &&
            capability.action === 'remove-face-feature')
      }));
      const hint =
        state.op === 'edit-fillet'
          ? 'Drag the radial handle or tap R to edit · set R0 to remove.'
          : state.op === 'remove-face-feature'
            ? `R${state.target.blendRadius ?? '?'} is read-only; this imported blend can be removed.`
            : state.op === 'resize-cylinder-radius'
              ? 'Drag the radial handle or tap the value to set the radius.'
              : 'Drag the arrow to offset the face, or tap the value to type · Space faces it head-on.';
      // Single-capability faces suppress the action row: one button that only
      // restates the title is noise on a card meant to stay out of the way.
      const alwaysShowActions =
        state.op === 'edit-fillet' || state.op === 'remove-face-feature';
      return {
        icon,
        title,
        ...(alwaysShowActions || actions.length > 1 ? { actions } : {}),
        ...lifecycleHint(state, hint)
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
        enabled: capability.enabled,
        ...(capability.disabledReason
          ? { disabledReason: capability.disabledReason }
          : {}),
        active: capability.action === state.op
      }));
      return {
        icon,
        title,
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
        icon,
        title,
        ...lifecycleHint(state, 'Drag the region to pull it into a solid.')
      };
    case 'sketch':
      return {
        icon,
        title,
        hint: state.session.pendingConstraint
          ? 'Pick geometry for the constraint · Esc cancels.'
          : state.session.tool === 'select'
            ? 'Select an entity to edit its exact values.'
            : state.session.tool === 'circle'
              ? state.session.circleMode === 'center-radius'
                ? 'Place a center, then set the radius. Hold Shift for free placement.'
                : state.session.circleMode === 'two-point-diameter'
                  ? 'Place opposite diameter endpoints. Tab cycles overlapping snaps.'
                  : 'Place three circumference points. Collinear input is rejected.'
              : 'Draw with exact geometry snaps. Esc ends a chain.'
      };
    case 'idle':
      return null;
  }
}
