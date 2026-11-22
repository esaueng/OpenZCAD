import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pivotProject } from '../../components/assembly/motionTestFixture';
import { playbackFrame, useAssemblyPlaybackDriver } from './assemblyPlayback';
import { assemblyRuntime, getAssemblyRuntime } from './assemblyRuntime';
import { TOOL_PREVIEW_JOINT_ID } from './assemblyView';

let frames: Map<number, FrameRequestCallback>;

function frame(now: number) {
  const pending = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of pending) callback(now);
  });
}

beforeEach(() => {
  frames = new Map();
  let nextId = 0;
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  assemblyRuntime.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  assemblyRuntime.reset();
});

it.each(['joint', 'study'] as const)(
  'keeps one pending frame during %s playback and stops without saving',
  (kind) => {
    const document = pivotProject().document;
    const saved = JSON.stringify(document);
    const { unmount } = renderHook(() =>
      useAssemblyPlaybackDriver(document.assembly)
    );
    act(() => {
      if (kind === 'joint')
        assemblyRuntime.startJointSweep('j_pivot', 0, 'ping-pong', 2);
      else assemblyRuntime.startStudy('study_1');
    });
    expect(frames.size).toBe(1);
    const poses = new Set<number>();
    for (let i = 1; i <= 60; i++) {
      frame(1000 + i * 16);
      expect(frames.size).toBe(1);
      poses.add(getAssemblyRuntime().overrides.get('j_pivot')![0]!);
    }
    expect(poses.size).toBeGreaterThan(30);
    act(() => assemblyRuntime.stop());
    frame(2100);
    expect(frames.size).toBe(0);
    expect(getAssemblyRuntime().overrides.size).toBe(0);
    expect(JSON.stringify(document)).toBe(saved);
    unmount();
  }
);

it('keeps one pending joint-tool preview frame and cancels it on unmount', () => {
  const document = pivotProject().document;
  const { unmount } = renderHook(() =>
    useAssemblyPlaybackDriver(document.assembly)
  );
  act(() => {
    assemblyRuntime.openJointTool('revolute');
    assemblyRuntime.updateJointTool({ step: 'review' });
  });
  for (let i = 1; i <= 60; i++) {
    frame(1000 + i * 16);
    expect(frames.size).toBe(1);
  }
  expect(getAssemblyRuntime().overrides.has(TOOL_PREVIEW_JOINT_ID)).toBe(true);
  act(() => assemblyRuntime.updateJointTool({ preview: false }));
  frame(2100);
  expect(frames.size).toBe(0);
  expect(getAssemblyRuntime().overrides.has(TOOL_PREVIEW_JOINT_ID)).toBe(false);
  act(() => assemblyRuntime.updateJointTool({ preview: true }));
  expect(frames.size).toBe(1);
  unmount();
  expect(frames.size).toBe(0);
});

it('finishes a one-shot study without leaving another callback queued', () => {
  const document = pivotProject().document;
  const assembly = document.assembly!;
  const { unmount } = renderHook(() =>
    useAssemblyPlaybackDriver({
      ...assembly,
      studies: assembly.studies.map((study) => ({ ...study, playback: 'once' }))
    })
  );
  act(() => assemblyRuntime.startStudy('study_1'));
  frame(3500);
  expect(getAssemblyRuntime().playback).toBeNull();
  expect(getAssemblyRuntime().overrides.get('j_pivot')).toEqual([90]);
  expect(frames.size).toBe(0);
  unmount();
});

it('stops a finite joint sweep after its cycles, back on the saved pose', () => {
  const document = pivotProject().document;
  const assembly = document.assembly!;
  const set = {
    ...assembly,
    joints: assembly.joints.map((joint) =>
      joint.id === 'j_pivot'
        ? { ...joint, values: [15], limits: [{ min: -30, max: 60 }] }
        : joint
    )
  };
  const { unmount } = renderHook(() => useAssemblyPlaybackDriver(set));
  // Two ping-pong cycles of 1 s sweeps: 4 s, then a settle to 15°.
  act(() => assemblyRuntime.startJointSweep('j_pivot', 0, 'ping-pong', 1, 2));
  const playback = getAssemblyRuntime().playback!;
  expect(playback).toMatchObject({ kind: 'joint', cycles: 2 });
  const at = (s: number) => playbackFrame(set, playback, 1000 + s * 1000);
  expect(at(1)?.overrides.get('j_pivot')).toEqual([60]);
  expect(at(4)?.overrides.get('j_pivot')).toEqual([-30]);
  expect(at(4)?.done).toBe(false);
  const settling = at(4.2)?.overrides.get('j_pivot')?.[0];
  expect(settling).toBeGreaterThan(-30);
  expect(settling).toBeLessThan(15);
  expect(at(5)).toMatchObject({ done: true, settled: true });

  for (let i = 1; i <= 400; i++) {
    frame(1000 + i * 16);
    if (!getAssemblyRuntime().playback) break;
    expect(frames.size).toBe(1);
  }
  // Paused: no clock, no override, no queued frame; Play starts it again.
  expect(getAssemblyRuntime().playback).toBeNull();
  expect(getAssemblyRuntime().overrides.size).toBe(0);
  expect(frames.size).toBe(0);
  act(() => assemblyRuntime.startJointSweep('j_pivot', 0, 'ping-pong', 1));
  expect(getAssemblyRuntime().playback).not.toHaveProperty('cycles');
  expect(frames.size).toBe(1);
  unmount();
});

it('keeps an unbounded joint sweep running past any cycle count', () => {
  const set = pivotProject().document.assembly!;
  act(() => assemblyRuntime.startJointSweep('j_pivot', 0, 'ping-pong', 1));
  const playback = getAssemblyRuntime().playback!;
  expect(playbackFrame(set, playback, 1000 + 600_000)).toMatchObject({
    done: false
  });
});
