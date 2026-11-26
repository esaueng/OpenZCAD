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
/**
 * A frame that builds (`true`), or one the kernel refused: `false`, or the
 * refusal's own sentence, so two refusals can be told apart.
 */
function frame(builds: boolean | string): ProjectDocument {
  const refused =
    builds === true
      ? null
      : builds === false
        ? 'A line is not a closed profile.'
        : builds;
  return {
    derived: {
      bodyRepresentations: refused === null ? { [BODY]: {} } : {},
      warnings: refused === null ? [] : [refused]
    }
  } as unknown as ProjectDocument;
}

/**
 * A command whose worker replies only when the test says so. `outcomes`
 * decides, build by build, whether the frame builds; each derive waits in
 * `replies` until released.
 */
function delayedWorker(outcomes: (boolean | string)[]) {
  const replies: (() => void)[] = [];
  const built: InPlaceRequest[] = [];
  const documents: ProjectDocument[] = [];
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
        apply: () => {
          const document = frame(builds);
          documents.push(document);
          return document;
        },
        resultBodyId: BODY
      };
    },
    commit: vi.fn(),
    publishPreview,
    onStatus: vi.fn()
  };
  const hook = renderHook(() => useInPlaceCommand(options));
  return { hook, replies, built, documents, publishPreview };
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
  // Was a pinned gap (Command state, U01): GEOMETRY_PREVIEW_SCHEDULING
  // publishes intermediate frames, and publish() set the refusal from any
  // frame without checking its key against the current request. A frame
  // whose key is not the current request's now sets no refusal.
  it('a refusal of value A that lands after B is typed is not said for B', async () => {
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
  });

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

  // The same case with the target changed instead of the value.
  it('a refusal for the old axis that lands after a new axis is picked is not said for it', async () => {
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
  });

  // A tool that names the refused input (Fillet, Chamfer, Hole) keeps the
  // last frame that built on screen under its refusal. A late refusal of a
  // value typed after that must not take the kept frame down or move its
  // arrow: the current value's own frame decides.
  it('a late refusal does not take down the frame a fillet keeps', async () => {
    // The default radius builds, 30 is refused, 40 is refused late, 3 builds.
    const { hook, replies, documents, publishPreview } = delayedWorker([
      true,
      false,
      false,
      true
    ]);
    act(() =>
      hook.result.current.start('fillet', [], [], [], {
        edges: [
          {
            bodyId: 'body_a' as BodyId,
            hash: 1,
            topologyId: 'e1',
            middle: { x: 0, y: 0, z: 10 },
            outward: { x: 1, y: 0, z: 0 }
          }
        ]
      })
    );
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => replies[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const kept = documents[0]!;

    act(() => {
      void hook.result.current.setValue('radius', 30);
    });
    await waitFor(() => expect(replies).toHaveLength(2));
    act(() => replies[1]!());
    await waitFor(() => expect(hook.result.current.refusalInput).toBe('R'));
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );

    // 40 is typed, and 3 while 40 is still building.
    act(() => {
      void hook.result.current.setValue('radius', 40);
    });
    await waitFor(() => expect(replies).toHaveLength(3));
    act(() => {
      void hook.result.current.setValue('radius', 3);
    });
    act(() => replies[2]!());
    await buildsStarted(replies, 4);
    // 40's refusal changed nothing: the kept fillet and its arrow stand.
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(hook.result.current.canFinish).toBe(false);

    act(() => replies[3]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(hook.result.current.refusal).toBeNull();
    expect(hook.result.current.refusalInput).toBeNull();
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: documents[3]!.derived })
    );
  });

  // The value goes back to the refused one while another builds: the
  // refused value has had its say, so the frame of the value passed on the
  // way neither replaces the kept fillet nor takes its refusal away.
  it('a late frame does not replace the kept fillet once the refused value is typed again', async () => {
    // The default radius builds, 30 is refused, 3 builds late, 30 again is
    // refused, each refusal in its own words.
    const { hook, replies, documents, publishPreview } = delayedWorker([
      true,
      'The first 30 mm is refused.',
      true,
      'The second 30 mm is refused.'
    ]);
    act(() =>
      hook.result.current.start('fillet', [], [], [], {
        edges: [
          {
            bodyId: 'body_a' as BodyId,
            hash: 1,
            topologyId: 'e1',
            middle: { x: 0, y: 0, z: 10 },
            outward: { x: 1, y: 0, z: 0 }
          }
        ]
      })
    );
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => replies[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const kept = documents[0]!;
    act(() => {
      void hook.result.current.setValue('radius', 30);
    });
    await waitFor(() => expect(replies).toHaveLength(2));
    act(() => replies[1]!());
    await waitFor(() => expect(hook.result.current.refusalInput).toBe('R'));

    act(() => {
      void hook.result.current.setValue('radius', 3);
    });
    await waitFor(() => expect(replies).toHaveLength(3));
    act(() => {
      void hook.result.current.setValue('radius', 30);
    });
    act(() => replies[2]!());
    await buildsStarted(replies, 4);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
    expect(hook.result.current.refusalInput).toBe('R');
    expect(hook.result.current.keptValues?.radius).toBe(2);

    act(() => replies[3]!());
    // The current request's own refusal lands, not the first one left over.
    await waitFor(() =>
      expect(hook.result.current.refusal).toBe('The second 30 mm is refused.')
    );
    expect(hook.result.current.refusalInput).toBe('R');
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(hook.result.current.canFinish).toBe(false);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
  });

  // Review of #2176, finding 1: a superseded frame that built is not drawn
  // over the fillet kept under a refusal, and does not become that kept
  // frame, nor clear the refusal or move its arrow.
  it('a late built frame does not replace the kept fillet or clear its refusal', async () => {
    // The default radius builds, 30 is refused, 3 builds late, 40 is refused.
    const { hook, replies, documents, publishPreview } = delayedWorker([
      true,
      'Radius 30 is refused.',
      true,
      'Radius 40 is refused.'
    ]);
    act(() =>
      hook.result.current.start('fillet', [], [], [], {
        edges: [
          {
            bodyId: 'body_a' as BodyId,
            hash: 1,
            topologyId: 'e1',
            middle: { x: 0, y: 0, z: 10 },
            outward: { x: 1, y: 0, z: 0 }
          }
        ]
      })
    );
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => replies[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const kept = documents[0]!;
    act(() => {
      void hook.result.current.setValue('radius', 30);
    });
    await waitFor(() => expect(replies).toHaveLength(2));
    act(() => replies[1]!());
    await waitFor(() => expect(hook.result.current.refusalInput).toBe('R'));

    // 3 is typed, and 40 while 3 is still building; 3's frame builds.
    act(() => {
      void hook.result.current.setValue('radius', 3);
    });
    await waitFor(() => expect(replies).toHaveLength(3));
    act(() => {
      void hook.result.current.setValue('radius', 40);
    });
    act(() => replies[2]!());
    await buildsStarted(replies, 4);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
    expect(hook.result.current.refusal).toBe('Radius 30 is refused.');
    expect(hook.result.current.refusalInput).toBe('R');
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(hook.result.current.canFinish).toBe(false);

    // 40's own refusal keeps the 2 mm fillet, not the 3 mm frame.
    act(() => replies[3]!());
    await waitFor(() =>
      expect(hook.result.current.refusal).toBe('Radius 40 is refused.')
    );
    expect(hook.result.current.refusalInput).toBe('R');
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
  });

  // Review of #2176, finding 2: a value typed away and back (90, 180, 90)
  // is a new request with the old key. The first 90's reply is not its
  // verdict: built, it does not enable Done; refused, it says nothing.
  it.each([
    ['built', true],
    ['refused', 'The first 90° is refused.']
  ] as const)(
    "the first reply of a value typed away and back, %s, is not the new request's",
    async (_label, firstReply) => {
      // Frame 0 builds, the first 90 replies late, the second 90 builds.
      const { hook, replies, built, publishPreview } = delayedWorker([
        true,
        firstReply,
        true
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
      act(() => {
        void hook.result.current.setValue('angle', 90);
      });
      expect(hook.result.current.canFinish).toBe(false);

      act(() => replies[1]!());
      await buildsStarted(replies, 3);
      // The new 90 is building its own frame: the first one decides nothing.
      expect(JSON.stringify(built[2])).toBe(JSON.stringify(built[1]));
      expect(hook.result.current.canFinish).toBe(false);
      act(() => {
        expect(hook.result.current.done()).toBe(false);
      });
      expect(hook.result.current.refusal).toBeNull();
      expect(publishPreview).not.toHaveBeenLastCalledWith(null);

      act(() => replies[2]!());
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
      expect(hook.result.current.refusal).toBeNull();
    }
  );

  // A superseded frame that built is drawn while nothing is refused (so a
  // drag follows the hand), but it is never the kept frame: the current
  // request's refusal puts the last current frame back under it.
  it('a refusal after a drawn superseded frame keeps the last current fillet', async () => {
    // The default radius builds, 3 builds late, 30 is refused.
    const { hook, replies, documents, publishPreview } = delayedWorker([
      true,
      true,
      'Radius 30 is refused.'
    ]);
    act(() =>
      hook.result.current.start('fillet', [], [], [], {
        edges: [
          {
            bodyId: 'body_a' as BodyId,
            hash: 1,
            topologyId: 'e1',
            middle: { x: 0, y: 0, z: 10 },
            outward: { x: 1, y: 0, z: 0 }
          }
        ]
      })
    );
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => replies[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const kept = documents[0]!;
    act(() => {
      void hook.result.current.setValue('radius', 3);
    });
    await waitFor(() => expect(replies).toHaveLength(2));
    act(() => {
      void hook.result.current.setValue('radius', 30);
    });
    act(() => replies[1]!());
    await buildsStarted(replies, 3);
    // Drawn, but not Done's and not kept.
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: documents[1]!.derived })
    );
    expect(hook.result.current.canFinish).toBe(false);

    act(() => replies[2]!());
    await waitFor(() =>
      expect(hook.result.current.refusal).toBe('Radius 30 is refused.')
    );
    expect(hook.result.current.refusalInput).toBe('R');
    expect(hook.result.current.keptValues?.radius).toBe(2);
    expect(publishPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ derived: kept.derived })
    );
  });
});
