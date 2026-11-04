import { useSyncExternalStore } from 'react';
import type {
  AssemblyDofLimit,
  AssemblyFrame,
  AssemblyFrameSource,
  AssemblyJointKind,
  AssemblyPlacement,
  AssemblyPlayback,
  BodyId
} from '@openzcad/shared';

/**
 * The Assemble workspace's transient state (AS01/AS02/AS06/AS07): what is
 * selected, the joint tool's picks, and every value that moves parts on
 * screen without being saved — a drag in progress, an Animate sweep, a
 * motion study playing or scrubbed. Saved content lives only in
 * `document.assembly` and changes only through `assembly.*` commands; this
 * store never writes the document. It commits through the handlers the app
 * registers, so the viewport and the panels can each read and drive it
 * without threading props through the app shell.
 */

/** A joint end the user picked in the viewport, in its component's coordinates. */
export interface AssemblyFramePick {
  componentId: string;
  bodyId: BodyId;
  /** In the component's modelled (unplaced) coordinates. */
  frame: AssemblyFrame;
  source: AssemblyFrameSource;
}

export interface AssemblyJointToolState {
  /** Which end the next viewport pick fills; 'review' once both are set. */
  step: 'parent' | 'child' | 'review';
  /** The end that stays (target). Picked second in the UI, stored as parent. */
  parent: AssemblyFramePick | null;
  /** The end that moves. Picked first in the UI. */
  child: AssemblyFramePick | null;
  kind: AssemblyJointKind;
  /** Reverse the moving end's axis (snapped joints only). */
  flip: boolean;
  /** Quarter turns of the moving end's frame about its axis (snapped joints). */
  quarterTurns: number;
  /** Plays the joint's motion while the tool is open. */
  preview: boolean;
  /**
   * Limits the new joint starts with, per free value of `kind`; absent or
   * null leaves a value unlimited. Cleared when the kind changes.
   */
  limits?: (AssemblyDofLimit | null)[];
}

export type AssemblyPlaybackState =
  | {
      kind: 'joint';
      jointId: string;
      dof: number;
      mode: AssemblyPlayback;
      /** Seconds for one sweep across the range. */
      sweepS: number;
      /** performance.now() at start, ms. */
      startedAtMs: number;
    }
  | {
      kind: 'study';
      studyId: string;
      /** Playback speed multiplier (0.5, 1, 2). */
      speed: number;
      /** Study time at `startedAtMs`, seconds. */
      fromS: number;
      startedAtMs: number;
    };

export interface AssemblyRuntimeState {
  /** True while the Assemble workspace (or a playing View) shows the assembly. */
  active: boolean;
  selectedComponentId: string | null;
  selectedJointId: string | null;
  selectedStudyId: string | null;
  /** Joint values shown instead of the saved ones; never saved. */
  overrides: ReadonlyMap<string, readonly number[]>;
  /** Placements of free components shown instead of the saved ones. */
  placementOverrides: ReadonlyMap<string, AssemblyPlacement>;
  playback: AssemblyPlaybackState | null;
  /** The motion study playhead, seconds, while a study is open. */
  studyTimeS: number;
  jointTool: AssemblyJointToolState | null;
}

/** Commits the app performs on the store's behalf (registered by App). */
export interface AssemblyCommitHandlers {
  /** One undo step: the values a drag or a position left the joints at. */
  commitPose(
    values: Record<string, number[]>,
    placements?: Record<string, AssemblyPlacement>
  ): void;
  /** The joint tool's Create: the app builds and executes the joint command. */
  createJoint(tool: AssemblyJointToolState): void;
}

const INITIAL: AssemblyRuntimeState = {
  active: false,
  selectedComponentId: null,
  selectedJointId: null,
  selectedStudyId: null,
  overrides: new Map(),
  placementOverrides: new Map(),
  playback: null,
  studyTimeS: 0,
  jointTool: null
};

let state: AssemblyRuntimeState = INITIAL;
const listeners = new Set<() => void>();
let handlers: AssemblyCommitHandlers | null = null;

/**
 * Takes a joint pose commit while a motion study is open, keying it at the
 * playhead instead of saving the rest pose. True when it took the pose.
 */
export type StudyPoseSink = (values: Record<string, number[]>) => boolean;
let studyPoseSink: StudyPoseSink | null = null;

function emit(next: AssemblyRuntimeState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

function patch(partial: Partial<AssemblyRuntimeState>): void {
  emit({ ...state, ...partial });
}

export function getAssemblyRuntime(): AssemblyRuntimeState {
  return state;
}

export function subscribeAssemblyRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding; pass a selector that returns a stable value. */
export function useAssemblyRuntime<T>(
  select: (s: AssemblyRuntimeState) => T
): T {
  return useSyncExternalStore(
    subscribeAssemblyRuntime,
    () => select(state),
    () => select(INITIAL)
  );
}

export function registerAssemblyCommitHandlers(
  next: AssemblyCommitHandlers | null
): void {
  handlers = next;
}

/** The open motion study timeline registers itself while it can edit. */
export function registerStudyPoseSink(next: StudyPoseSink | null): void {
  studyPoseSink = next;
}

export const assemblyRuntime = {
  /** Back to nothing selected, nothing playing, no tool: on project switch. */
  reset(): void {
    emit({ ...INITIAL, active: state.active });
  },
  setActive(active: boolean): void {
    if (active === state.active) return;
    // Leaving the workspace stops motion and drops unsaved poses.
    patch(
      active
        ? { active }
        : {
            active,
            playback: null,
            overrides: new Map(),
            placementOverrides: new Map(),
            jointTool: null
          }
    );
  },
  selectComponent(componentId: string | null): void {
    patch({
      selectedComponentId: componentId,
      selectedJointId: componentId ? null : state.selectedJointId
    });
  },
  selectJoint(jointId: string | null): void {
    patch({
      selectedJointId: jointId,
      selectedComponentId: jointId ? null : state.selectedComponentId
    });
  },
  selectStudy(studyId: string | null): void {
    patch({ selectedStudyId: studyId, studyTimeS: 0 });
  },
  /** A transient value for one joint (drag, scrub); null drops it. */
  setOverride(jointId: string, values: readonly number[] | null): void {
    const overrides = new Map(state.overrides);
    if (values) overrides.set(jointId, [...values]);
    else overrides.delete(jointId);
    patch({ overrides });
  },
  /** Replaces every transient joint value at once (playback frames). */
  setOverrides(overrides: ReadonlyMap<string, readonly number[]>): void {
    patch({ overrides });
  },
  setPlacementOverride(
    componentId: string,
    placement: AssemblyPlacement | null
  ): void {
    const placementOverrides = new Map(state.placementOverrides);
    if (placement) placementOverrides.set(componentId, placement);
    else placementOverrides.delete(componentId);
    patch({ placementOverrides });
  },
  clearOverrides(): void {
    if (state.overrides.size === 0 && state.placementOverrides.size === 0)
      return;
    patch({ overrides: new Map(), placementOverrides: new Map() });
  },
  /**
   * Saves the transient values as one undo step and clears them. While a
   * motion study is open its timeline keys them at the playhead instead and
   * the study then shows them.
   */
  commitOverrides(): void {
    if (state.overrides.size === 0 && state.placementOverrides.size === 0)
      return;
    const values = Object.fromEntries(
      [...state.overrides].map(([id, v]) => [id, [...v]])
    );
    // A free part's placement is not part of a study: that pose saves.
    if (
      studyPoseSink &&
      state.selectedStudyId &&
      state.placementOverrides.size === 0 &&
      studyPoseSink(values)
    )
      return;
    if (!handlers) return;
    const placements = Object.fromEntries(state.placementOverrides);
    handlers.commitPose(
      values,
      state.placementOverrides.size > 0 ? placements : undefined
    );
    patch({ overrides: new Map(), placementOverrides: new Map() });
  },
  startJointSweep(
    jointId: string,
    dof: number,
    mode: AssemblyPlayback,
    sweepS: number
  ): void {
    patch({
      playback: {
        kind: 'joint',
        jointId,
        dof,
        mode,
        sweepS,
        startedAtMs: performance.now()
      },
      selectedJointId: jointId
    });
  },
  startStudy(studyId: string, speed = 1, fromS = state.studyTimeS): void {
    patch({
      playback: {
        kind: 'study',
        studyId,
        speed,
        fromS,
        startedAtMs: performance.now()
      },
      selectedStudyId: studyId
    });
  },
  /** Stops playback; the parts return to their saved values. */
  stop(): void {
    if (!state.playback && state.overrides.size === 0) return;
    patch({ playback: null, overrides: new Map() });
  },
  setStudyTime(t: number): void {
    patch({ studyTimeS: Math.max(0, t) });
  },
  openJointTool(kind: AssemblyJointKind = 'revolute'): void {
    patch({
      playback: null,
      overrides: new Map(),
      jointTool: {
        step: 'child',
        parent: null,
        child: null,
        kind,
        flip: false,
        quarterTurns: 0,
        preview: true
      }
    });
  },
  /** Fills the end the tool is waiting for with a viewport pick. */
  pickJointFrame(pick: AssemblyFramePick): void {
    const tool = state.jointTool;
    if (!tool || tool.step === 'review') return;
    if (tool.step === 'child') {
      patch({ jointTool: { ...tool, child: pick, step: 'parent' } });
      return;
    }
    if (tool.child && tool.child.componentId === pick.componentId) return;
    patch({ jointTool: { ...tool, parent: pick, step: 'review' } });
  },
  updateJointTool(
    partial: Partial<Omit<AssemblyJointToolState, 'parent' | 'child'>>
  ): void {
    if (!state.jointTool) return;
    patch({ jointTool: { ...state.jointTool, ...partial } });
  },
  /** Clears one end so the next pick fills it again. */
  repickJointEnd(end: 'parent' | 'child'): void {
    const tool = state.jointTool;
    if (!tool) return;
    patch({ jointTool: { ...tool, [end]: null, step: end } });
  },
  createJoint(): void {
    const tool = state.jointTool;
    if (!tool || tool.step !== 'review' || !handlers) return;
    handlers.createJoint(tool);
    patch({ jointTool: null, overrides: new Map() });
  },
  closeJointTool(): void {
    if (state.jointTool) patch({ jointTool: null, overrides: new Map() });
  }
};
