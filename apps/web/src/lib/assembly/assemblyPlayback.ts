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
  type AssemblyPlaybackState
} from './assemblyRuntime';
import { TOOL_PREVIEW_JOINT_ID } from './assemblyView';

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
 * Drives playback and the joint tool preview while either runs: one
 * requestAnimationFrame loop writing transient overrides into the runtime.
 * Mount once where the assembly is shown.
 */
export function useAssemblyPlaybackDriver(set: AssemblySet | undefined): void {
  useEffect(() => {
    if (!set) return;
    let frame = 0;
    let previewStart = 0;
    const tick = (now: number) => {
      frame = 0;
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
      } else {
        previewStart = 0;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const kick = () => {
      const runtime = getAssemblyRuntime();
      const running =
        runtime.playback !== null ||
        (runtime.jointTool?.preview === true &&
          runtime.jointTool.step === 'review');
      if (running && !frame) frame = requestAnimationFrame(tick);
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
