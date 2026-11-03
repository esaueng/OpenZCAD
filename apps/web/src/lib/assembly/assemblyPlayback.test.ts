import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pivotProject } from '../../components/assembly/motionTestFixture';
import { useAssemblyPlaybackDriver } from './assemblyPlayback';
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
