import { useEffect } from 'react';
import {
  ASSEMBLY_JOINT_DOFS,
  jointSweepRange,
  jointSweepValue,
  motionStudyValues,
  playbackTime,
  type AssemblySet
} from '@openzcad/shared';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  subscribeAssemblyRuntime,
  type AssemblyJointToolState,
  type AssemblyMotionSetupState,
  type AssemblyPlaybackState
} from './assemblyRuntime';
import {
  MOTION_SETUP_PREVIEW_JOINT_ID,
  TOOL_PREVIEW_JOINT_ID
} from './assemblyView';

/**
 * AS06/AS07 playback. Every frame is computed from elapsed time alone
 * (never by accumulating per-frame steps), so a dropped frame or a slow
 * device shows the same motion at the same moment.
 */

export interface PlaybackFrame {
  overrides: Map<string, number[]>;
  /** The study playhead, for a study. */
  studyTimeS?: number;
  done: boolean;
}

export function playbackFrame(
  set: AssemblySet,
  playback: AssemblyPlaybackState,
  nowMs: number
): PlaybackFrame | null {
  const elapsedS = Math.max(0, (nowMs - playback.startedAtMs) / 1000);
  if (playback.kind === 'joint') {
    const joint = set.joints.find((j) => j.id === playback.jointId);
    if (!joint) return null;
    const range = jointSweepRange(joint, playback.dof);
    if (!range) return null;
    const { value, done } = jointSweepValue(
      range,
      playback.mode,
      playback.sweepS,
      elapsedS
    );
    const values = [...joint.values];
    values[playback.dof] = value;
    return { overrides: new Map([[joint.id, values]]), done };
  }
  const study = set.studies.find((s) => s.id === playback.studyId);
  if (!study) return null;
  const { t, done } = playbackTime(
    study.playback,
    playback.fromS + elapsedS * playback.speed,
    study.durationS
  );
  return { overrides: motionStudyValues(set, study, t), studyTimeS: t, done };
}

/** The joint tool's looping preview of the motion it is about to create. */
export function toolPreviewValues(
  tool: AssemblyJointToolState,
  elapsedS: number
): number[] | null {
  if (!tool.preview || tool.step !== 'review') return null;
  const units = ASSEMBLY_JOINT_DOFS[tool.kind];
  if (units.length === 0) return null;
  const swing = 0.5 - 0.5 * Math.cos(elapsedS * 2.2);
  return units.map((unit, index) =>
    index === 0 ? (unit === 'deg' ? 30 * swing : 20 * swing) : 0
  );
}

/**
 * Set up motion's preview: the exact sweep Create will play, through the
 * draft's range and cycle. "Once" repeats here so the preview stays visible.
 */
export function motionSetupPreviewValues(
  setup: AssemblyMotionSetupState,
  elapsedS: number
): number[] | null {
  const joint = setup.preview;
  if (!setup.previewing || !joint) return null;
  const range = jointSweepRange(joint, 0);
  if (!range) return null;
  const mode = setup.draft.mode === 'once' ? 'loop' : setup.draft.mode;
  return [jointSweepValue(range, mode, setup.draft.sweepS, elapsedS).value];
}

function motionSetupRunning(setup: AssemblyMotionSetupState | null): boolean {
  return setup?.previewing === true && setup.preview !== null;
}

/**
 * Drives playback and the joint tool preview while either runs: one
 * requestAnimationFrame loop writing transient overrides into the runtime.
 * Mount once where the assembly is shown.
 */
export function useAssemblyPlaybackDriver(set: AssemblySet | undefined): void {
  useEffect(() => {
    if (!set) return;
    let frame = 0;
    let ticking = false;
    let previewStart = 0;
    const tick = (now: number) => {
      frame = 0;
      // Runtime notifications are synchronous. Publishing a pose must not
      // let our subscriber start a second loop while this frame is running.
      ticking = true;
      try {
        const runtime = getAssemblyRuntime();
        if (runtime.playback) {
          const next = playbackFrame(set, runtime.playback, now);
          if (!next) {
            assemblyRuntime.stop();
            return;
          }
          assemblyRuntime.setOverrides(next.overrides);
          if (next.studyTimeS !== undefined)
            assemblyRuntime.setStudyTime(next.studyTimeS);
          if (next.done) {
            // Once: leave the last frame showing, stop the clock.
            stopClockKeepPose();
            return;
          }
        } else if (runtime.jointTool) {
          if (!previewStart) previewStart = now;
          const values = toolPreviewValues(
            runtime.jointTool,
            (now - previewStart) / 1000
          );
          if (!values) {
            previewStart = 0;
            if (runtime.overrides.has(TOOL_PREVIEW_JOINT_ID))
              assemblyRuntime.setOverride(TOOL_PREVIEW_JOINT_ID, null);
            return;
          }
          assemblyRuntime.setOverride(TOOL_PREVIEW_JOINT_ID, values);
        } else if (runtime.motionSetup) {
          if (!previewStart) previewStart = now;
          const values = motionSetupPreviewValues(
            runtime.motionSetup,
            (now - previewStart) / 1000
          );
          if (!values) {
            previewStart = 0;
            if (runtime.overrides.has(MOTION_SETUP_PREVIEW_JOINT_ID))
              assemblyRuntime.setOverride(MOTION_SETUP_PREVIEW_JOINT_ID, null);
            return;
          }
          assemblyRuntime.setOverride(MOTION_SETUP_PREVIEW_JOINT_ID, values);
        } else {
          previewStart = 0;
          return;
        }
        frame = requestAnimationFrame(tick);
      } finally {
        ticking = false;
      }
    };
    const kick = () => {
      const runtime = getAssemblyRuntime();
      const running =
        runtime.playback !== null ||
        (runtime.jointTool?.preview === true &&
          runtime.jointTool.step === 'review') ||
        motionSetupRunning(runtime.motionSetup);
      if (running && !frame && !ticking) frame = requestAnimationFrame(tick);
    };
    const unsubscribe = subscribeAssemblyRuntime(kick);
    kick();
    return () => {
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [set]);
}

/** Ends a finished "once" playback but keeps its last pose on screen. */
function stopClockKeepPose(): void {
  const runtime = getAssemblyRuntime();
  if (!runtime.playback) return;
  const overrides = runtime.overrides;
  assemblyRuntime.stop();
  assemblyRuntime.setOverrides(overrides);
}
