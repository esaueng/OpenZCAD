import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type { BodyId, ProjectDocument, SketchId } from '@openzcad/shared';
import {
  useInPlaceCommand,
  type UseInPlaceCommandOptions
} from './useInPlaceCommand';
import type { InPlaceRequest, ProfilePick } from '../lib/inPlace/tools';

/**
 * U11 slice 2a, cell 2 (superseded input), hook half. Value A is typed and
 * its frame is still building when value B (or a new axis) replaces it. A's
 * reply is the delayed worker reply: it lands after B was asked for and
 * before B's own frame. Whatever A's reply says, it is not about B:
 *
 * - it must not enable Done (B has not been shown);
 * - it must not say A's refusal while B is the request on screen;
 * - B's own frame decides Done and the refusal once it lands.
 *
 * This is the mechanism behind the Split bar seen briefly showing a refusal
 * for an earlier value: Split, like Revolve here, previews through this
 * hook, and neither names a refused input (`refusedInputs`). Its browser
 * neighbours are in `test/e2e/selection-preview-feedback.spec.ts`. Refusals
 * are asserted by presence, never by their sentence.
 */

const FRONT: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 0, y: -1, z: 0 }
};
const SKETCH = 'sketch_1' as SketchId;
const BODY = 'body_preview' as BodyId;
const PICK: ProfilePick = {
  sketchId: SKETCH,
  reference: { all: true, sourceEntityIds: ['a', 'b'] },
  regionFingerprint: 7
};
const RECTANGLE = [
  { x: 14, y: 3 },
  { x: 24, y: 3 },
  { x: 24, y: 15 },
  { x: 14, y: 15 }
];

/** A frame that builds the body, or one the kernel refused. */
function frame(builds: boolean): ProjectDocument {
  return {
    derived: {
      bodyRepresentations: builds ? { [BODY]: {} } : {},
      warnings: builds ? [] : ['A line is not a closed profile.']
    }
  } as unknown as ProjectDocument;
}

/**
 * A command whose worker replies only when the test says so. `outcomes`
 * decides, build by build, whether the frame builds; each derive waits in
 * `replies` until released.
 */
function delayedWorker(outcomes: boolean[]) {
  const replies: (() => void)[] = [];
  const built: InPlaceRequest[] = [];
  const publishPreview = vi.fn<(preview: ProjectDocument | null) => void>();
  const options: UseInPlaceCommandOptions = {
    sketchViews: [
      {
        sketchId: SKETCH,
        basis: FRONT,
        regions: [{ regionFingerprint: 7, outer: RECTANGLE }]
      }
    ],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    baseDocument: () => frame(true),
    derive: (document) =>
      new Promise((resolve) => {
        replies.push(() => resolve(document.derived));
      }),
    buildCommand: (request) => {
      const builds = outcomes[built.length] ?? true;
      built.push(request);
      return {
        validate: () => undefined,
        apply: () => frame(builds),
        resultBodyId: BODY
      };
    },
    commit: vi.fn(),
    publishPreview,
    onStatus: vi.fn()
  };
  const hook = renderHook(() => useInPlaceCommand(options));
  return { hook, replies, built, publishPreview };
}

/**
 * Waits until `count` builds have started. The previewer runs one build at
 * a time and starts the next only after the previous reply was published,
 * so once build `count` starts, every earlier reply has reached publish()
 * and the newest is held: the state under test, with no fixed sleep.
 */
const buildsStarted = (replies: unknown[], count: number) =>
  waitFor(() => expect(replies).toHaveLength(count));

describe('U11 cell 2: a delayed reply for a superseded value', () => {
  // Pinned gap, failure class Command state (U01, useInPlaceCommand.ts):
  // GEOMETRY_PREVIEW_SCHEDULING publishes intermediate frames, and the
  // hook's publish() sets the refusal from any frame it is handed without
  // checking that frame's key against the current request. A superseded
  // refusal is therefore said under the newer value until that value's own
  // frame lands. Expected: a frame whose key is not the current request's
  // sets no refusal (Done is already gated on the key). Flip to it() when
  // fixed.
  it.fails(
    'a refusal of value A that lands after B is typed is not said for B',
    async () => {
      // Frame 0 (the armed default) builds, A is refused, B builds.
      const { hook, replies, built } = delayedWorker([true, false, true]);
      act(() => hook.result.current.start('revolve', [PICK]));
      act(() => hook.result.current.pickAxis('sketch-vertical'));
      await waitFor(() => expect(replies).toHaveLength(1));
      act(() => replies[0]!());
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));

      // A is typed and its frame starts; B is typed while A is in flight.
      act(() => {
        void hook.result.current.setValue('angle', 90);
      });
      await waitFor(() => expect(replies).toHaveLength(2));
      act(() => {
        void hook.result.current.setValue('angle', 180);
      });
      expect(hook.result.current.canFinish).toBe(false);

      // A's refusal arrives. B's frame has started and is held: B is the
      // request on screen and has no frame yet.
      act(() => replies[1]!());
      await buildsStarted(replies, 3);
      expect(JSON.stringify(built[1])).toContain('90');
      expect(JSON.stringify(built[2])).toContain('180');
      expect(hook.result.current.canFinish).toBe(false);
      // Command state: A's refusal must not stand under B's value.
      expect(hook.result.current.refusal).toBeNull();

      // B's own frame lands and builds: Done is B's, and nothing is refused.
      act(() => replies[2]!());
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
      expect(hook.result.current.refusal).toBeNull();
    }
  );

  it('a valid frame of value A that lands after B is typed does not enable Done', async () => {
    // Frame 0 builds, A builds, B is refused.
    const { hook, replies, publishPreview } = delayedWorker([
      true,
      true,
      false
    ]);
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => replies[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));

    act(() => {
      void hook.result.current.setValue('angle', 90);
    });
    await waitFor(() => expect(replies).toHaveLength(2));
    act(() => {
      void hook.result.current.setValue('angle', 180);
    });
    act(() => replies[1]!());
    await buildsStarted(replies, 3);
    // A built, but Done commits what is typed: B, which has not been shown.
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      expect(hook.result.current.done()).toBe(false);
    });

    // B's refusal is B's own: said, Done held, and the preview taken down.
    act(() => replies[2]!());
    await waitFor(() => expect(hook.result.current.refusal).not.toBeNull());
    expect(hook.result.current.canFinish).toBe(false);
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });

  // Same pinned gap (Command state), the target changed instead of the value.
  it.fails(
    'a refusal for the old axis that lands after a new axis is picked is not said for it',
    async () => {
      // Frame 0 (vertical axis) is refused late; the horizontal axis builds.
      const { hook, replies, built } = delayedWorker([false, true]);
      act(() => hook.result.current.start('revolve', [PICK]));
      act(() => hook.result.current.pickAxis('sketch-vertical'));
      await waitFor(() => expect(replies).toHaveLength(1));
      // The target changes while the first frame is in flight.
      act(() => hook.result.current.pickAxis('sketch-horizontal'));
      act(() => replies[0]!());
      // The new axis's frame has started and is held.
      await buildsStarted(replies, 2);
      expect(JSON.stringify(built[1])).not.toBe(JSON.stringify(built[0]));
      expect(hook.result.current.canFinish).toBe(false);
      // Command state: the old axis's refusal is not the new axis's.
      expect(hook.result.current.refusal).toBeNull();

      act(() => replies[1]!());
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
      expect(hook.result.current.refusal).toBeNull();
    }
  );
});
