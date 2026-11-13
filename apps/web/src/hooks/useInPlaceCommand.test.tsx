import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { InPlaceCommandBar } from '../components/InPlaceCommandBar';
import { cancelCommandChipEntry } from '../lib/inPlace/chipCancel';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type {
  BodyId,
  FeatureId,
  FeatureWarning,
  ProjectDocument,
  SketchId
} from '@openzcad/shared';
import type { InPlaceEditSeed } from '../lib/inPlace/edit';
import {
  mergeSweptFaces,
  useInPlaceCommand,
  type UseInPlaceCommandOptions
} from './useInPlaceCommand';
import type {
  FacePick,
  InPlaceRequest,
  ProfilePick
} from '../lib/inPlace/tools';
import { GROUND_FRAME, placementFrame } from '../lib/inPlace/primitives';

const FRONT: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 0, y: -1, z: 0 }
};
const TOP: PlaneBasis = {
  origin: { x: 0, y: 0, z: 30 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
};
const SKETCH = 'sketch_1' as SketchId;
const OTHER = 'sketch_2' as SketchId;
const BODY = 'body_preview' as BodyId;
const PICK: ProfilePick = {
  sketchId: SKETCH,
  reference: { all: true, sourceEntityIds: ['a', 'b'] },
  regionFingerprint: 7
};
const SECOND: ProfilePick = {
  sketchId: OTHER,
  reference: { all: true, sourceEntityIds: ['c'] },
  regionFingerprint: 9
};

function fakeDocument(withBody: boolean): ProjectDocument {
  return {
    derived: {
      bodyRepresentations: withBody ? { [BODY]: {} } : {},
      warnings: withBody ? [] : ['A line is not a closed profile.']
    }
  } as unknown as ProjectDocument;
}

const RECTANGLE = [
  { x: 14, y: 3 },
  { x: 24, y: 3 },
  { x: 24, y: 15 },
  { x: 14, y: 15 }
];

function setupOptions(
  built: InPlaceRequest[],
  commit: (request: InPlaceRequest, title: string) => void,
  publishPreview: (preview: ProjectDocument | null) => void = vi.fn()
): UseInPlaceCommandOptions {
  return {
    sketchViews: [
      {
        sketchId: SKETCH,
        basis: FRONT,
        regions: [{ regionFingerprint: 7, outer: RECTANGLE }]
      },
      {
        sketchId: OTHER,
        basis: TOP,
        regions: [{ regionFingerprint: 9, outer: RECTANGLE }]
      }
    ],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    baseDocument: () => fakeDocument(true),
    derive: async (document) => document.derived,
    buildCommand: (request) => {
      built.push(request);
      return {
        validate: () => undefined,
        apply: (document) => document,
        resultBodyId: BODY
      };
    },
    commit,
    publishPreview,
    onStatus: vi.fn()
  };
}

function setup(overrides: Partial<UseInPlaceCommandOptions> = {}) {
  const commit = vi.fn<(request: InPlaceRequest, title: string) => void>();
  const publishPreview = vi.fn();
  const built: InPlaceRequest[] = [];
  const options: UseInPlaceCommandOptions = {
    ...setupOptions(built, commit, publishPreview),
    ...overrides
  };
  const hook = renderHook(() => useInPlaceCommand(options));
  return { hook, commit, publishPreview, built };
}

describe('useInPlaceCommand: preview warning disposition', () => {
  const warning = (kind: FeatureWarning['kind']): FeatureWarning => ({
    featureId: 'feature_preview' as FeatureId,
    featureName: 'Preview',
    kind,
    message: 'Feature "Preview": The crest is under a 0.4 mm extrusion line.'
  });
  const derivedWith = (entries: FeatureWarning[], body = true) => ({
    ...fakeDocument(body).derived,
    warnings: entries.map((entry) => entry.message),
    featureWarnings: entries
  });

  it.each(['box', 'gear'] as const)(
    'allows Done for a %s advisory and keeps the note visible',
    async (tool) => {
      const { hook, commit, publishPreview } = setup({
        derive: async () => derivedWith([warning('advisory')])
      });
      act(() => hook.result.current.start(tool));
      if (tool === 'gear') {
        act(() => {
          hook.result.current.pickPlane({
            kind: 'principal',
            plane: 'XY',
            origin: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: 1 }
          });
        });
      }
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
      expect(hook.result.current.refusal).toBeNull();
      expect(hook.result.current.hint).toContain(
        'Note: The crest is under a 0.4 mm extrusion line.'
      );
      expect(publishPreview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          derived: expect.objectContaining({
            featureWarnings: [warning('advisory')]
          })
        })
      );
      act(() => {
        expect(hook.result.current.done()).toBe(true);
      });
      expect(commit).toHaveBeenCalledOnce();
    }
  );

  it.each(['build-failed', 'refusal'] as const)(
    'blocks a %s even when a body and an advisory are also present',
    async (kind) => {
      const failure = {
        ...warning(kind),
        message: 'Feature "Preview": Invalid geometry.'
      };
      const { hook, commit } = setup({
        derive: async () => derivedWith([warning('advisory'), failure])
      });
      act(() => hook.result.current.start('box'));
      await waitFor(() =>
        expect(hook.result.current.refusal).toContain('Invalid geometry')
      );
      expect(hook.result.current.canFinish).toBe(false);
      act(() => {
        expect(hook.result.current.done()).toBe(false);
      });
      expect(commit).not.toHaveBeenCalled();
    }
  );

  it.each(['suppressed', 'history-fork'] as const)(
    'does not turn a %s diagnostic into a refusal',
    async (kind) => {
      const { hook } = setup({
        derive: async () => derivedWith([warning(kind)])
      });
      act(() => hook.result.current.start('box'));
      await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
      expect(hook.result.current.refusal).toBeNull();
    }
  );

  it('still blocks a missing result body when the only message is an advisory', async () => {
    const { hook } = setup({
      derive: async () => derivedWith([warning('advisory')], false)
    });
    act(() => hook.result.current.start('box'));
    await waitFor(() =>
      expect(hook.result.current.refusal).toMatch(/valid body/)
    );
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('counts legacy warning occurrences instead of hiding a new duplicate', async () => {
    const base = fakeDocument(true);
    base.derived.warnings = ['Legacy failure'];
    const { hook } = setup({
      baseDocument: () => base,
      derive: async () => ({
        ...base.derived,
        warnings: ['Legacy failure', 'Legacy failure']
      })
    });
    act(() => hook.result.current.start('box'));
    await waitFor(() =>
      expect(hook.result.current.refusal).toBe('Legacy failure')
    );
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('removes the previous preview advisory as soon as the request changes', async () => {
    let advisory = true;
    const { hook } = setup({
      derive: async () => derivedWith(advisory ? [warning('advisory')] : [])
    });
    act(() => hook.result.current.start('box'));
    await waitFor(() => expect(hook.result.current.hint).toContain('Note:'));
    advisory = false;
    act(() => {
      hook.result.current.setValue('width', 31);
    });
    expect(hook.result.current.hint).not.toContain('Note:');
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(hook.result.current.hint).not.toContain('Note:');
  });
});

describe('useInPlaceCommand: revolve', () => {
  it('walks profile → axis → angle in its hint', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve'));
    expect(hook.result.current.hint).toMatch(/profile/);
    act(() => hook.result.current.pickProfile(PICK));
    expect(hook.result.current.hint).toMatch(/axis/);
    expect(hook.result.current.axisCandidates.map((c) => c.id)).toEqual([
      'sketch-horizontal',
      'sketch-vertical'
    ]);
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    expect(hook.result.current.hint).toMatch(/angle/);
  });

  it('places one angle handle about the axis, aimed at the region', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    const [handle] = hook.result.current.handles;
    expect(handle).toMatchObject({
      valueId: 'angle',
      kind: 'angle',
      params: {
        center: { x: 0, y: 0, z: 9 },
        startDirection: { x: 1, y: 0, z: 0 }
      }
    });
  });

  it('previews as soon as the axis is picked and finishes with the profile', async () => {
    const { hook, commit, publishPreview, built } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const published = publishPreview.mock.calls.at(-1)?.[0] as
      ProjectDocument | undefined;
    expect(published?.derived.bodyRepresentations[BODY]).toBeDefined();
    // A full turn is stored as an absent angle.
    const full = {
      tool: 'revolve',
      sketchId: SKETCH,
      profile: PICK.reference,
      axis: { axis: 'vertical' }
    };
    expect(built.at(-1)).toEqual(full);
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledWith(
      full,
      'Revolve',
      null,
      expect.any(Function)
    );
    expect(hook.result.current.active).toBe(false);
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });

  it('rebuilds for a new axis and holds Done until that frame lands', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const before = built.length;
    act(() => hook.result.current.pickAxis('sketch-horizontal'));
    // The old axis's frame no longer counts.
    expect(hook.result.current.canFinish).toBe(false);
    await waitFor(() => expect(built.length).toBeGreaterThan(before));
    expect(built.at(-1)).toMatchObject({ axis: { axis: 'horizontal' } });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('ends quietly when another action closes it', () => {
    const onStatus = vi.fn();
    const { hook } = setup({ onStatus });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.cancel(true);
    });
    expect(hook.result.current.active).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('commits a typed expression rather than its value', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    act(() => {
      hook.result.current.setValue('angle', 270, 'sweep * 3');
    });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    expect(commit.mock.calls[0]![0]).toMatchObject({ angleDeg: 'sweep * 3' });
  });

  it('refuses a typed expression outside the range instead of clamping it', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.setValue('angle', 400, 'sweep * 5');
    });
    expect(hook.result.current.refusal).toMatch(/sweep \* 5 is 400/);
    expect(hook.result.current.values.angle ?? 360).toBe(360);
    // Nothing is committed while the refusal stands, the refused value
    // least of all.
    act(() => {
      expect(hook.result.current.done()).toBe(false);
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('reads a typed expression again when the model changes under it', () => {
    let sweep = 90;
    const commit = vi.fn();
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], commit),
      evaluate: (value) => (value === 'sweep * 3' ? sweep * 3 : null),
      baseVersion: 1
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.setValue('angle', 270, 'sweep * 3');
    });
    expect(hook.result.current.values.angle).toBe(270);
    // A collaborator sets sweep to 100: the next version reads 300.
    sweep = 100;
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.values.angle).toBe(300);
  });

  it('refuses a typed count outside its whole range rather than rounding it', () => {
    const { hook } = setup();
    act(() =>
      hook.result.current.start(
        'linear-pattern',
        [],
        [],
        [
          {
            bodyId: BODY,
            min: { x: 0, y: 0, z: 0 },
            max: { x: 10, y: 10, z: 10 }
          }
        ]
      )
    );
    let accepted = true;
    act(() => {
      accepted = hook.result.current.setValue('count', 4.5, undefined);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.refusal).toMatch(/takes/);
    act(() => {
      accepted = hook.result.current.setValue('count', 101, undefined);
    });
    expect(accepted).toBe(false);
    act(() => {
      accepted = hook.result.current.setValue('count', 6, undefined);
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.values.count).toBe(6);
  });

  it('refuses a typed number outside the range instead of clamping it', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('box'));
    act(() => {
      expect(hook.result.current.setValue('width', -5)).toBe(false);
    });
    expect(hook.result.current.refusal).toBe(
      '-5; Box width takes at least 0.001.'
    );
    expect(hook.result.current.values.width).toBe(30);
  });

  it('keeps a sub-degree revolve', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.setValue('angle', 0.5);
    });
    expect(hook.result.current.values.angle).toBe(0.5);
  });

  it('rebuilds the preview when undo or redo replaces the base', async () => {
    let baseVersion = 1;
    const commit = vi.fn<(request: InPlaceRequest, title: string) => void>();
    const built: InPlaceRequest[] = [];
    const hook = renderHook(() =>
      useInPlaceCommand({
        ...setupOptions(built, commit),
        baseVersion
      })
    );
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const before = built.length;
    baseVersion = 2;
    hook.rerender();
    await waitFor(() => expect(built.length).toBeGreaterThan(before));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('clamps a dragged value to its range', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.previewValue('angle', 999));
    expect(hook.result.current.values.angle).toBe(360);
  });

  it('does not finish on a frame built before the model moved', async () => {
    const releases: (() => void)[] = [];
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      derive: (document) =>
        new Promise((resolve) => {
          releases.push(() => resolve(document.derived));
        })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(releases).toHaveLength(1));
    // A collaborator's edit lands while the first frame is still building.
    hook.rerender({ ...options, baseVersion: 2 });
    act(() => releases[0]!());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.result.current.canFinish).toBe(false);
    // The frame on the new base is the one Done may finish on.
    await waitFor(() => expect(releases.length).toBeGreaterThan(1));
    act(() => releases.at(-1)!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('finishes on the frame of a value dragged back to', async () => {
    const releases: (() => void)[] = [];
    // Each build adds a body under a new id, as the real command does: the
    // cached frame must be judged by its own body, not the newest build's.
    let builds = 0;
    const { hook } = setup({
      buildCommand: () => {
        const bodyId = `body_preview_${(builds += 1)}` as BodyId;
        return {
          validate: () => undefined,
          apply: (document) =>
            ({
              ...document,
              derived: {
                ...document.derived,
                bodyRepresentations: { [bodyId]: {} }
              }
            }) as ProjectDocument,
          resultBodyId: bodyId
        };
      },
      derive: (document) =>
        new Promise((resolve) => {
          releases.push(() => resolve(document.derived));
        })
    });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(releases).toHaveLength(1));
    act(() => releases[0]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => hook.result.current.previewValue('angle', 180));
    await waitFor(() => expect(releases).toHaveLength(2));
    act(() => hook.result.current.previewValue('angle', 360));
    // Every request is its own generation, so the drag back rebuilds rather
    // than republishing: the superseded frame settles, then the new one.
    act(() => releases[1]!());
    await waitFor(() => expect(releases).toHaveLength(3));
    expect(hook.result.current.canFinish).toBe(false);
    act(() => releases[2]!());
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('cannot finish while the preview is refused, and says why', async () => {
    const { hook, commit } = setup({ baseDocument: () => fakeDocument(false) });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() =>
      expect(hook.result.current.refusal).toMatch(/not a closed profile/)
    );
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      expect(hook.result.current.done()).toBe(false);
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('takes the last good frame down when a later value is refused', async () => {
    let builds = true;
    const { hook, publishPreview } = setup({
      buildCommand: () => ({
        validate: () => undefined,
        apply: () => fakeDocument(builds),
        resultBodyId: BODY
      })
    });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(publishPreview).toHaveBeenLastCalledWith(expect.anything());
    builds = false;
    act(() => {
      hook.result.current.setValue('angle', 90);
    });
    await waitFor(() =>
      expect(hook.result.current.refusal).toMatch(/not a closed profile/)
    );
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });

  it('keeps the axis for another region of the same sketch', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    act(() =>
      hook.result.current.pickProfile({ ...PICK, regionFingerprint: 8 })
    );
    expect(hook.result.current.slots.axis?.id).toBe('sketch-vertical');
    act(() => hook.result.current.pickProfile(SECOND));
    expect(hook.result.current.slots.axis).toBeNull();
  });

  it('cancels without committing and clears the preview', () => {
    const { hook, commit, publishPreview } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.cancel();
    });
    expect(hook.result.current.active).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });
});

describe('useInPlaceCommand: loft', () => {
  it('collects sections in click order and toggles a repeat off', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('loft'));
    act(() => hook.result.current.pickProfile(PICK));
    expect(hook.result.current.hint).toMatch(/next section/);
    act(() => hook.result.current.pickProfile(SECOND));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(built.at(-1)).toEqual({
      tool: 'loft',
      sections: [
        { sketchId: SKETCH, profile: PICK.reference },
        { sketchId: OTHER, profile: SECOND.reference }
      ],
      mode: 'ruled'
    });
    act(() => hook.result.current.pickProfile(PICK));
    expect(hook.result.current.slots.profiles).toEqual([SECOND]);
    expect(hook.result.current.canFinish).toBe(false);
  });
});

describe('useInPlaceCommand: sweep', () => {
  it('needs a profile and a path, and keeps a path in one sketch', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('sweep', [PICK]));
    expect(hook.result.current.hint).toMatch(/path/);
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'p1' })
    );
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'p2' })
    );
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(built.at(-1)).toMatchObject({
      tool: 'sweep',
      path: { sketchId: OTHER, entityIds: ['p1', 'p2'] }
    });
    // A curve from another sketch starts the path over.
    act(() =>
      hook.result.current.pickCurve({ sketchId: SKETCH, entityId: 'q' })
    );
    expect(hook.result.current.slots.path).toEqual([
      { sketchId: SKETCH, entityId: 'q' }
    ]);
    // Clicking a picked curve takes it back out.
    act(() =>
      hook.result.current.pickCurve({ sketchId: SKETCH, entityId: 'q' })
    );
    expect(hook.result.current.slots.path).toEqual([]);
  });

  it('takes a re-checked path in place of the one it held', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('sweep', [PICK]));
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'p1' })
    );
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'p2' })
    );
    // p1 left the model: the re-check keeps p2 alone, and the profile stays.
    act(() =>
      hook.result.current.setPicks({
        path: [{ sketchId: OTHER, entityId: 'p2' }]
      })
    );
    expect(hook.result.current.slots.path).toEqual([
      { sketchId: OTHER, entityId: 'p2' }
    ]);
    expect(hook.result.current.slots.profiles).toEqual([PICK]);
  });
});

describe('useInPlaceCommand: helical sweep', () => {
  it('walks profile → axis → height, and coils through the profile', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('helical-sweep'));
    expect(hook.result.current.hint).toMatch(/profile/);
    act(() => hook.result.current.pickProfile(PICK));
    // The axis is the user's pick: none is taken for them.
    expect(hook.result.current.slots.axis).toBeNull();
    expect(hook.result.current.hint).toMatch(/axis/);
    expect(hook.result.current.canFinish).toBe(false);
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    expect(hook.result.current.hint).toMatch(/stretch.*end.*turns/);
    // The rectangle is 12 tall: each turn climbs 15, three turns stand 45.
    await waitFor(() =>
      expect(hook.result.current.values.height).toBeCloseTo(45)
    );
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['height', 'turns']
    );
    await waitFor(() =>
      expect((built.at(-1) as { pitch: number }).pitch).toBeCloseTo(15)
    );
    expect(built.at(-1)).toMatchObject({
      tool: 'helical-sweep',
      // The coil runs through the profile: its middle is 19 off the axis.
      radius: 19,
      turns: 3,
      axisDirection: { x: 0, y: 0, z: 1 }
    });
  });

  it('winds turns on at the same spacing, stretches with the arrow, and follows a new axis', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('helical-sweep', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    // The arrow stretches three turns over 30: 10 apart.
    act(() => {
      hook.result.current.setValue('height', 30);
    });
    // Its end dragged out to six turns keeps them 10 apart: it stands 60.
    act(() => {
      hook.result.current.previewValue('turns', 6);
    });
    expect(hook.result.current.values.height).toBeCloseTo(60);
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({ turns: 6, pitch: 10 })
    );
    // The turns ride the coil's end, which starts level with the profile.
    const end = hook.result.current.handles.find(
      (handle) => handle.valueId === 'turns'
    );
    expect(end).toMatchObject({
      kind: 'coil',
      params: {
        center: { x: 0, y: 0, z: 9 },
        axis: { x: 0, y: 0, z: 1 },
        radius: 19,
        pitch: 10
      }
    });
    expect(built.at(-1)).toMatchObject({ axisOrigin: { x: 0, y: 0, z: 9 } });
    act(() => hook.result.current.pickAxis('sketch-horizontal'));
    // The rectangle's middle is 9 above the horizontal axis.
    await waitFor(() => expect(built.at(-1)).toMatchObject({ radius: 9 }));
  });

  it('offers only the axes beside the profile', () => {
    const { hook } = setup({
      sketchViews: [
        {
          sketchId: SKETCH,
          basis: FRONT,
          // Straddling the sketch's horizontal axis, clear of its vertical one.
          regions: [
            {
              regionFingerprint: 7,
              outer: [
                { x: 14, y: -3 },
                { x: 24, y: -3 },
                { x: 24, y: 3 },
                { x: 14, y: 3 }
              ]
            }
          ]
        }
      ]
    });
    act(() => hook.result.current.start('helical-sweep', [PICK]));
    expect(hook.result.current.axisCandidates.map((c) => c.id)).toEqual([
      'sketch-vertical'
    ]);
    // Revolve keeps both: a revolve may turn about its profile's own edge.
    act(() => {
      void hook.result.current.cancel();
    });
    act(() => hook.result.current.start('revolve', [PICK]));
    expect(hook.result.current.axisCandidates.map((c) => c.id)).toEqual([
      'sketch-horizontal',
      'sketch-vertical'
    ]);
  });

  it('switches to pitch & turns without changing the coil', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('helical-sweep', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    act(() => {
      hook.result.current.setValue('height', 30);
    });
    act(() => hook.result.current.setOption('size', 'pitch'));
    expect(hook.result.current.values.pitch).toBeCloseTo(10);
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['pitch', 'turns']
    );
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({ pitch: 10, turns: 3 })
    );
  });
});

describe('useInPlaceCommand: thread', () => {
  // An M6 boss 12 tall up +Z, clicked on its side near the top.
  const BOSS: FacePick = {
    bodyId: 'body_a' as BodyId,
    hash: 31,
    topologyId: 'f31',
    surfaceType: 'cylinder',
    cylinder: {
      axisStart: { x: 0, y: 0, z: 0 },
      axisEnd: { x: 0, y: 0, z: 12 },
      radius: 3
    },
    point: { x: 0, y: -3, z: 10 }
  };

  it('takes the face, runs it whole, and stops short where its end is dragged', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('thread'));
    expect(hook.result.current.hint).toMatch(/cylindrical face/);
    let taken = false;
    act(() => {
      taken = hook.result.current.pickFace(BOSS);
    });
    expect(taken).toBe(true);
    expect(hook.result.current.hint).toMatch(/Drag the arrow/);
    // The face gives the length: the whole of it, until the end moves.
    await waitFor(() => expect(hook.result.current.values.length).toBe(12));
    expect(hook.result.current.handles).toEqual([
      expect.objectContaining({
        valueId: 'length',
        kind: 'linear',
        params: {
          origin: { x: 0, y: -3, z: 12 },
          direction: { x: -0, y: -0, z: -1 }
        },
        max: 12
      })
    ]);
    await waitFor(() =>
      expect(built.at(-1)).toEqual({
        tool: 'thread',
        thread: {
          targetBodyId: 'body_a',
          faceHash: 31,
          profile: 'printable',
          clearance: 0.1,
          // Picked near the top: it starts there, whole or not.
          anchor: 'end',
          chamferStart: true,
          chamferEnd: true
        }
      })
    );
    // The arrow dragged 4 up from the bottom: 8 threaded down from the top.
    act(() => {
      hook.result.current.previewValue('length', 8);
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { length: 8, anchor: 'end' }
      })
    );
    expect(
      (built.at(-1) as { thread: { chamferStart?: true } }).thread.chamferStart
    ).toBeUndefined();
    // And back out to the end: whole again.
    act(() => {
      hook.result.current.previewValue('length', 12);
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { chamferStart: true, chamferEnd: true }
      })
    );
    expect(
      (built.at(-1) as { thread: { length?: number } }).thread.length
    ).toBeUndefined();
    // Whole, it still starts at the top it was picked near.
    expect(built.at(-1)).toMatchObject({ thread: { anchor: 'end' } });
  });

  it('refuses a typed length past the face end instead of threading the whole face', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.values.length).toBe(12));
    let taken = true;
    act(() => {
      taken = hook.result.current.setValue('length', 20);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(
      /^20; a thread here runs at most 12/
    );
    expect(hook.result.current.canFinish).toBe(false);
    expect(hook.result.current.values.length).toBe(12);
    // As an expression too.
    act(() => {
      taken = hook.result.current.setValue('length', 15, 'boss_h + 3');
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(/^boss_h \+ 3 is 15; /);
    // The far end itself is taken, and runs the whole face.
    act(() => {
      taken = hook.result.current.setValue('length', 12);
    });
    expect(taken).toBe(true);
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { chamferStart: true, chamferEnd: true, anchor: 'end' }
      })
    );
    expect(
      (built.at(-1) as { thread: { length?: number } }).thread.length
    ).toBeUndefined();
  });

  it('refuses an offset that would push a set length past the face end (re-check #1)', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.values.length).toBe(12));
    let taken = false;
    act(() => {
      taken = hook.result.current.setValue('length', 10);
    });
    expect(taken).toBe(true);
    // 3 + 10 overshoots the 12 face: refused, never a quiet 9 mm thread.
    act(() => {
      taken = hook.result.current.setValue('offset', 3);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(
      /^3; with the length at 10, the offset can be at most 2\./
    );
    expect(hook.result.current.values.offset).toBe(0);
    expect(hook.result.current.values.length).toBe(10);
    // An offset that fits is taken, and the length kept as set.
    act(() => {
      taken = hook.result.current.setValue('offset', 1);
    });
    expect(taken).toBe(true);
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { length: 10, offset: 1, anchor: 'end' }
      })
    );
  });

  it('runs a whole-face thread on to the far end as its offset moves', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.values.length).toBe(12));
    // Untouched, the length follows the offset.
    act(() => {
      hook.result.current.setValue('offset', 3);
    });
    await waitFor(() => expect(hook.result.current.values.length).toBe(9));
    expect(hook.result.current.refusal).toBeNull();
    // Dragged back out to the end, it still runs there when the offset moves.
    act(() => {
      hook.result.current.previewValue('length', 9);
    });
    act(() => {
      hook.result.current.setValue('offset', 5);
    });
    expect(hook.result.current.values.length).toBe(7);
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({ thread: { offset: 5 } })
    );
    expect(
      (built.at(-1) as { thread: { length?: number } }).thread.length
    ).toBeUndefined();
  });

  it('keeps an Options refusal and holds Done while the row applies (re-check #2)', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    let taken = true;
    act(() => {
      taken = hook.result.current.setValue('offset', 12);
    });
    expect(taken).toBe(false);
    // The offset has no handle, only its Options row: the reason stays.
    expect(hook.result.current.handles.map((h) => h.valueId)).toEqual([
      'length'
    ]);
    expect(hook.result.current.refusal).toMatch(
      /^12; the face is only 12 long\./
    );
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      taken = hook.result.current.setValue('offset', 2);
    });
    expect(taken).toBe(true);
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  /** The thread command wired to its Options bar, as the app wires it. */
  function ThreadWithOptions(props: { options: UseInPlaceCommandOptions }) {
    const command = useInPlaceCommand(props.options);
    const started = useRef(false);
    useEffect(() => {
      if (started.current) return;
      started.current = true;
      command.start('thread', [], [BOSS]);
    }, [command]);
    const offset = command.values.offset ?? 0;
    return (
      <>
        {/* The length's chip keypad, as the app routes a typed entry. */}
        {[13, 8].map((length) => (
          <button
            key={length}
            type="button"
            onClick={() => command.setValue('length', length)}
          >
            {`Chip length ${length}`}
          </button>
        ))}
        <InPlaceCommandBar
          title="Thread"
          hint={command.hint}
          refusal={command.refusal}
          canFinish={command.canFinish}
          values={[
            {
              id: 'offset',
              label: 'Offset',
              text: String(offset),
              value: offset,
              step: 0.1,
              min: 0
            }
          ]}
          onValueCommit={(id, text) => command.setValue(id, Number(text))}
          onValueRestore={command.dropRefusal}
          onDone={vi.fn()}
          onCancel={vi.fn()}
        />
      </>
    );
  }

  it('keeps a chip refusal when another Options entry is abandoned (third re-check)', async () => {
    render(<ThreadWithOptions options={setupOptions([], vi.fn())} />);
    const done = screen.getByRole('button', { name: /Done/ });
    const bar = () =>
      screen.getByRole('group', { name: 'Thread command' }).textContent ?? '';
    await waitFor(() => expect(done).toBeEnabled());
    // 1. Length 13 on its chip: refused, Done held.
    fireEvent.click(screen.getByRole('button', { name: 'Chip length 13' }));
    await waitFor(() => expect(done).toBeDisabled());
    expect(bar()).toContain('a thread here runs at most 12');
    // 2. Offset 12 typed in Options, refused, then abandoned by leaving.
    const field = screen.getByRole('textbox', { name: 'Offset' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '12' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(bar()).toContain('the face is only 12 long');
    fireEvent.blur(field);
    expect(field).toHaveValue('0');
    // 3. The length's refusal still stands: shown, and Done held.
    await waitFor(() =>
      expect(bar()).toContain('a thread here runs at most 12')
    );
    expect(bar()).not.toContain('the face is only 12 long');
    expect(done).toBeDisabled();
    // The length fixed on its chip: nothing refused, Done back.
    fireEvent.click(screen.getByRole('button', { name: 'Chip length 8' }));
    await waitFor(() => expect(done).toBeEnabled());
    expect(bar()).not.toContain('runs at most');
  });

  it('lets a refused Options entry go when its field is put back (second re-check #1)', async () => {
    render(<ThreadWithOptions options={setupOptions([], vi.fn())} />);
    const done = screen.getByRole('button', { name: /Done/ });
    await waitFor(() => expect(done).toBeEnabled());
    const field = screen.getByRole('textbox', { name: 'Offset' });
    const refuse = () => {
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: '12' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(done).toBeDisabled();
      expect(
        screen.getByRole('group', { name: 'Thread command' }).textContent
      ).toContain('the face is only 12 long');
    };
    // Escape puts the field back to 0: Done no longer waits on the 12.
    refuse();
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(field).toHaveValue('0');
    await waitFor(() => expect(done).toBeEnabled());
    // Leaving the field drops the refused entry the same way.
    refuse();
    fireEvent.blur(field);
    expect(field).toHaveValue('0');
    await waitFor(() => expect(done).toBeEnabled());
    // The held value entered again clears it too, though nothing changes.
    refuse();
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field).not.toHaveAttribute('aria-invalid');
    await waitFor(() => expect(done).toBeEnabled());
  });

  it('drops the refusal of a chip when it is reopened and canceled, and only then (fourth re-check)', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    // Length 13 entered on its chip: refused. The app then puts the chip's
    // baseline back, which leaves the refusal standing.
    act(() => {
      hook.result.current.setValue('length', 13);
    });
    act(() => {
      hook.result.current.restoreValue('length', 12, undefined, false);
    });
    expect(hook.result.current.refusal).toMatch(/^13; a thread here runs/);
    expect(hook.result.current.canFinish).toBe(false);
    // An offset refused in Options as well: its refusal is its own.
    act(() => {
      hook.result.current.setValue('offset', 12);
    });
    expect(hook.result.current.refusal).toMatch(/^12; the face is only/);
    // The length chip reopened and canceled (Escape, untyped): its refusal
    // goes, and only its own; the offset's still holds Done.
    act(() => {
      cancelCommandChipEntry(
        hook.result.current,
        'length',
        12,
        undefined,
        false
      );
    });
    expect(hook.result.current.refusal).toMatch(/^12; the face is only/);
    expect(hook.result.current.canFinish).toBe(false);
    expect(hook.result.current.values.length).toBe(12);
    act(() => {
      hook.result.current.dropRefusal('offset');
    });
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  /** A stored partial thread, 10 long from 2 up, reopened from History. */
  const STORED: InPlaceEditSeed = {
    featureId: 'feat_t' as FeatureId,
    nodeId: 'node_t',
    name: 'Thread 1',
    data: {
      featureKind: 'thread',
      targetBodyId: 'body_a' as BodyId,
      faceHash: 31,
      profile: 'printable',
      clearance: 0.1,
      length: 10,
      offset: 2
    },
    resultBodyId: BODY,
    ownBodyIds: [BODY],
    slots: {
      profiles: [],
      axisId: null,
      path: [],
      guide: [],
      faces: [{ ...BOSS, point: undefined }],
      bodies: [],
      plane: null,
      edges: []
    },
    values: { length: 10, offset: 2 },
    raws: {},
    touched: ['length', 'offset'],
    options: {
      profile: 'printable',
      size: 'auto',
      fit: 'print',
      chamfer: 'none',
      hand: 'right'
    },
    axes: [],
    choices: {},
    lockedOptions: [],
    notice: null
  };

  it('keeps an existing printing advisory visible while editing its thread', async () => {
    const base = fakeDocument(true);
    const advisory: FeatureWarning = {
      featureId: STORED.featureId,
      featureName: STORED.name,
      kind: 'advisory',
      message: 'Feature "Thread 1": The crest is narrow.'
    };
    base.derived.warnings = [advisory.message];
    base.derived.featureWarnings = [advisory];
    const { hook } = setup({
      baseDocument: () => base,
      derive: async () => base.derived
    });
    act(() => hook.result.current.edit('thread', STORED));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(hook.result.current.hint).toContain('Note: The crest is narrow.');
    expect(hook.result.current.refusal).toBeNull();
  });

  it('blocks an edited thread that still has its baseline failure despite a pass-through body', async () => {
    const base = fakeDocument(true);
    const failure: FeatureWarning = {
      featureId: STORED.featureId,
      featureName: STORED.name,
      kind: 'build-failed',
      message: 'Feature "Thread 1": The thread did not build.'
    };
    base.derived.warnings = [failure.message];
    base.derived.featureWarnings = [failure];
    const { hook } = setup({
      baseDocument: () => base,
      derive: async () => base.derived
    });
    act(() => hook.result.current.edit('thread', STORED));
    await waitFor(() =>
      expect(hook.result.current.refusal).toContain('thread did not build')
    );
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('keeps a stored length that reaches the face end, refusing an offset that would cut it (second re-check #2)', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.edit('thread', STORED));
    // Untouched, it goes back as stored.
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { length: 10, offset: 2 }
      })
    );
    let taken = true;
    act(() => {
      taken = hook.result.current.setValue('offset', 3);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(
      /^3; with the length at 10, the offset can be at most 2\./
    );
    expect(hook.result.current.values.length).toBe(10);
    expect(hook.result.current.values.offset).toBe(2);
    // A smaller offset keeps the stored length as stored.
    act(() => {
      taken = hook.result.current.setValue('offset', 1);
    });
    expect(taken).toBe(true);
    expect(hook.result.current.values.length).toBe(10);
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        thread: { length: 10, offset: 1 }
      })
    );
  });

  it('refuses an offset a length expression cannot follow, and keeps the expression (second re-check #3)', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('thread', [], [BOSS]));
    await waitFor(() => expect(hook.result.current.values.length).toBe(12));
    let taken = false;
    act(() => {
      taken = hook.result.current.setValue('length', 12, 'face_h');
    });
    expect(taken).toBe(true);
    // Typed as an expression, it is stored as written, even at the end.
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({ thread: { length: 'face_h' } })
    );
    act(() => {
      taken = hook.result.current.setValue('offset', 3);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(
      /^3; the length is face_h \(12\), so the offset can be at most 0; change the length too\./
    );
    expect(hook.result.current.values.length).toBe(12);
    expect(hook.result.current.raws.length).toBe('face_h');
    expect(built.at(-1)).toMatchObject({ thread: { length: 'face_h' } });
    expect(
      (built.at(-1) as { thread: { offset?: number } }).thread.offset
    ).toBeUndefined();
  });
});

describe('Options-only refusals in another tool (gear)', () => {
  it('keeps a refused Options value until it is taken or its row hides', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('gear'));
    act(() => hook.result.current.setOption('gearType', 'worm'));
    let taken = true;
    act(() => {
      taken = hook.result.current.setValue('starts', 20);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(/^20; /);
    // A choice that hides the row lets the refusal go, as a hidden chip's.
    act(() => hook.result.current.setOption('gearType', 'spur'));
    expect(hook.result.current.refusal).toBeNull();
    // A row that stays shown keeps it until a value is taken.
    act(() => {
      taken = hook.result.current.setValue('pressureAngleDeg', 60);
    });
    expect(taken).toBe(false);
    expect(hook.result.current.refusal).toMatch(/^60; /);
    act(() => {
      taken = hook.result.current.setValue('pressureAngleDeg', 25);
    });
    expect(taken).toBe(true);
    expect(hook.result.current.refusal).toBeNull();
  });
});

describe('useInPlaceCommand: hole step chips', () => {
  const FACE: FacePick = {
    bodyId: 'body_a' as BodyId,
    hash: 11,
    topologyId: 'f11',
    surfaceType: 'plane',
    normal: { x: 0, y: 0, z: 1 },
    centroid: { x: 10, y: 5, z: 4 },
    point: { x: 12, y: 6, z: 4 }
  };

  it('sizes an unset step from the bore and keeps one the user set', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'counterbore'));
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['diameter', 'counterboreDiameter', 'counterboreDepth']
    );
    act(() => {
      hook.result.current.setValue('diameter', 4);
    });
    await waitFor(() =>
      expect(hook.result.current.values.counterboreDiameter).toBe(7.2)
    );
    expect(hook.result.current.values.counterboreDepth).toBe(2);
    act(() => {
      hook.result.current.setValue('counterboreDepth', 3, 'cb_depth');
    });
    act(() => {
      hook.result.current.setValue('diameter', 5);
    });
    await waitFor(() =>
      expect(hook.result.current.values.counterboreDiameter).toBe(9)
    );
    expect(hook.result.current.raws.counterboreDepth).toBe('cb_depth');
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        state: {
          value: {
            style: 'counterbore',
            diameter: '5',
            counterboreDiameter: '9',
            counterboreDepth: 'cb_depth'
          }
        }
      })
    );
  });

  it('a refused entry holds Done until a value is taken, then clears', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'countersink'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    let accepted = true;
    act(() => {
      accepted = hook.result.current.setValue('countersinkAngleDeg', 180);
    });
    expect(accepted).toBe(false);
    // The chip is back on the value before; Done must not commit that as
    // if it were what was typed.
    expect(hook.result.current.refusal).toMatch(/takes/);
    expect(hook.result.current.canFinish).toBe(false);
    // The value that was there before, typed again, is taken and clears it.
    act(() => {
      accepted = hook.result.current.setValue(
        'countersinkAngleDeg',
        hook.result.current.values.countersinkAngleDeg ?? 90
      );
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('another value changing leaves a refused entry holding Done', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'countersink'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.setValue('countersinkAngleDeg', 180);
    });
    act(() => {
      hook.result.current.setValue('diameter', 8);
    });
    expect(hook.result.current.refusal).toMatch(/countersink angle/);
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('an option that leaves the refused value shown keeps Done held', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'countersink'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.setValue('countersinkAngleDeg', 180);
    });
    // Blind depth changes the hole but still shows the refused angle.
    act(() => hook.result.current.setOption('depthMode', 'blind'));
    expect(hook.result.current.refusal).toMatch(/countersink angle/);
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('a style that hides the refused value lets Done go', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'countersink'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.setValue('countersinkAngleDeg', 180);
    });
    expect(hook.result.current.canFinish).toBe(false);
    act(() => hook.result.current.setOption('style', 'simple'));
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('a countersink shows its diameter and angle chips', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'countersink'));
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['diameter', 'countersinkDiameter', 'countersinkAngleDeg']
    );
    // The angle is the full included angle, strictly inside 0°–180°.
    let accepted = true;
    act(() => {
      accepted = hook.result.current.setValue(
        'countersinkAngleDeg',
        180,
        '180'
      );
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.refusal).toMatch(
      /more than 0 and less than 180/
    );
    // Any angle inside the open interval is the card's, decimals included.
    act(() => {
      accepted = hook.result.current.setValue(
        'countersinkAngleDeg',
        0.5,
        '0.5'
      );
    });
    expect(accepted).toBe(true);
    // A typed end of the open range is refused too, not nudged inside it.
    act(() => {
      accepted = hook.result.current.setValue('countersinkAngleDeg', 180);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.values.countersinkAngleDeg).toBe(0.5);
    expect(hook.result.current.refusal).toBe(
      '180; Hole countersink angle takes more than 0 and less than 180.'
    );
    // Every value strictly inside the open range is taken as typed.
    act(() => {
      accepted = hook.result.current.setValue(
        'countersinkAngleDeg',
        179.9999995
      );
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.values.countersinkAngleDeg).toBe(179.9999995);
    // A step's sizes take any positive value, as the card did.
    act(() => {
      accepted = hook.result.current.setValue('countersinkDiameter', 0.005);
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.values.countersinkDiameter).toBe(0.005);
  });

  it('a canceled chip entry leaves the step following the bore', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('hole', [], [FACE]));
    act(() => hook.result.current.setOption('style', 'counterbore'));
    // The keypad previews what is typed, then Escape puts the value back.
    act(() => hook.result.current.previewValue('counterboreDiameter', 14));
    expect(hook.result.current.touched).toContain('counterboreDiameter');
    act(() =>
      hook.result.current.restoreValue(
        'counterboreDiameter',
        10.8,
        undefined,
        false
      )
    );
    act(() => {
      hook.result.current.setValue('diameter', 4);
    });
    await waitFor(() =>
      expect(hook.result.current.values.counterboreDiameter).toBe(7.2)
    );

    // The bore moves while the step's keypad is open, then Escape: the step,
    // still unset, takes the default as it stands now.
    act(() => hook.result.current.previewValue('counterboreDiameter', 14));
    act(() => {
      hook.result.current.setValue('diameter', 5);
    });
    act(() =>
      hook.result.current.restoreValue(
        'counterboreDiameter',
        7.2,
        undefined,
        false
      )
    );
    expect(hook.result.current.values.counterboreDiameter).toBe(9);
  });
});

describe('a draft hinge placed by a click', () => {
  const face = (hash: number, point?: { x: number; y: number; z: number }) => ({
    bodyId: 'body_a' as BodyId,
    hash,
    topologyId: `f${hash}`,
    surfaceType: 'plane',
    normal: { x: 1, y: 0, z: 0 },
    centroid: { x: 0, y: 0, z: hash },
    ...(point ? { point } : {})
  });

  it('a drafted face clicked again takes the hinge instead of leaving', () => {
    const { hook } = setup();
    // As an edit seeds them: the faces, no clicked point.
    act(() => hook.result.current.start('draft', [], [face(1), face(2)]));
    act(() => hook.result.current.setOption('neutral', 'point'));
    act(() => {
      hook.result.current.pickFace(face(2, { x: 5, y: 6, z: 7 }));
    });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1, 2]);
    expect(hook.result.current.slots.faces[1]?.point).toEqual({
      x: 5,
      y: 6,
      z: 7
    });
    // The latest click is the hinge: no other face keeps a point.
    act(() => {
      hook.result.current.pickFace(face(1, { x: 1, y: 1, z: 1 }));
    });
    expect(hook.result.current.slots.faces.map((f) => f.point ?? null)).toEqual(
      [{ x: 1, y: 1, z: 1 }, null]
    );
    // Without a clicked hinge, a picked face clicked again leaves the set.
    act(() => hook.result.current.setOption('neutral', 'base'));
    act(() => {
      hook.result.current.pickFace(face(1, { x: 1, y: 1, z: 1 }));
    });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([2]);
  });
});

describe('a box sweep into a face-list command', () => {
  const face = (bodyId: string, hash: number) =>
    ({ bodyId: bodyId as BodyId, hash, topologyId: `f${hash}` }) as FacePick;

  it('keeps the picked body and adds only new faces', () => {
    expect(
      mergeSweptFaces(
        [face('a', 1)],
        [face('a', 1), face('a', 2), face('b', 3), face('b', 4)]
      ).map((f) => f.hash)
    ).toEqual([1, 2]);
  });

  it('takes the body the sweep caught most of when nothing is picked', () => {
    expect(
      mergeSweptFaces([], [face('a', 1), face('b', 2), face('b', 3)]).map(
        (f) => f.hash
      )
    ).toEqual([2, 3]);
  });
});

describe('review: option and plane resets', () => {
  const BODY_PICK = {
    bodyId: 'body_a' as BodyId,
    min: { x: 0, y: 0, z: 0 },
    max: { x: 20, y: 10, z: 4 }
  };
  const YZ = {
    kind: 'principal' as const,
    plane: 'YZ' as const,
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 1, y: 0, z: 0 }
  };
  const XZ = {
    kind: 'principal' as const,
    plane: 'XZ' as const,
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 }
  };

  it('a new plane drops a typed offset, not only its value', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('mirror', [], [], [BODY_PICK]));
    act(() => {
      hook.result.current.pickPlane(YZ);
    });
    act(() => {
      hook.result.current.setValue('offset', 5, 'width / 4');
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        state: { value: { origin: { x: '(width / 4)' } } }
      })
    );
    act(() => {
      hook.result.current.pickPlane(XZ);
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        state: { value: { origin: { x: '0', y: '0', z: '0' } } }
      })
    );
  });

  it("a grid's two directions trade places instead of matching", () => {
    const { hook } = setup();
    act(() => hook.result.current.start('grid-pattern', [], [], [BODY_PICK]));
    act(() => hook.result.current.setOption('axis2', 'x'));
    expect(hook.result.current.options).toMatchObject({
      axis: 'y',
      axis2: 'x'
    });
  });
});

describe('review: a sweep guide rail', () => {
  it('curve clicks build the rail while Options say so', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('sweep', [PICK]));
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'p1' })
    );
    act(() => hook.result.current.setOption('curves', 'guide'));
    act(() =>
      hook.result.current.pickCurve({ sketchId: OTHER, entityId: 'g1' })
    );
    expect(hook.result.current.slots.path.map((c) => c.entityId)).toEqual([
      'p1'
    ]);
    expect(hook.result.current.slots.guide.map((c) => c.entityId)).toEqual([
      'g1'
    ]);
    expect(hook.result.current.hint).toMatch(/Rail of 1/);
  });
});

describe('useInPlaceCommand: primitives', () => {
  it('previews the card default at once, and Enter commits it', async () => {
    const { hook, commit, built } = setup();
    act(() => hook.result.current.start('box'));
    expect(hook.result.current.hint).toMatch(/footprint/);
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(built.at(-1)).toEqual({
      tool: 'primitive',
      kind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 },
      position: { x: 0, y: 0, z: 0 }
    });
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledWith(
      built.at(-1),
      'Box',
      null,
      expect.any(Function)
    );
  });

  it('takes a footprint: its plane, the press and the drawn sizes', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('box'));
    // A typed width is replaced by the drawn one.
    act(() => {
      hook.result.current.setValue('width', 12, 'w');
    });
    act(() => {
      expect(
        hook.result.current.placeFootprint(
          { frame: placementFrame({ x: 0, y: 0, z: 1 }), signU: 1, signV: 1 },
          { width: 20, depth: 15, x: -10, y: 5, z: 6 }
        )
      ).toBe(true);
    });
    expect(hook.result.current.raws).toEqual({});
    expect(hook.result.current.hint).toMatch(/arrows/);
    await waitFor(() =>
      expect(built.at(-1)).toEqual({
        tool: 'primitive',
        kind: 'box',
        dimensions: { width: 20, height: 15, depth: 24 },
        position: { x: -10, y: 5, z: 6 }
      })
    );
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['width', 'depth', 'height']
    );
  });

  it('moves a hung box corner with its height, unless typed', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('box'));
    act(() => {
      hook.result.current.placeFootprint(
        {
          frame: placementFrame({ x: 0, y: 0, z: 1 }),
          signU: 1,
          signV: 1,
          hangs: 'z'
        },
        { width: 10, depth: 6, x: 0, y: 0, z: -4 }
      );
    });
    act(() => {
      hook.result.current.previewValue('height', 10);
    });
    expect(hook.result.current.values.z).toBe(10);
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        dimensions: { depth: 10 },
        position: { z: 10 }
      })
    );
    // A canceled entry puts the corner back with the height.
    act(() => {
      hook.result.current.restoreValue('height', 24, undefined, true);
    });
    expect(hook.result.current.values.z).toBe(-4);
    act(() => {
      hook.result.current.previewValue('height', 10);
    });
    // A typed Corner Z is the user's: a height change leaves it.
    act(() => {
      hook.result.current.setValue('z', 3, 'floor');
    });
    act(() => {
      hook.result.current.previewValue('height', 12);
    });
    expect(hook.result.current.raws.z).toBe('floor');
    expect(hook.result.current.values.z).toBe(3);
  });

  it('lets a drawn footprint lift the refusal of the size it replaces', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('cylinder'));
    act(() => {
      hook.result.current.setValue('radius', -2);
    });
    expect(hook.result.current.refusal).toMatch(/radius takes/);
    act(() => {
      hook.result.current.placeFootprint(
        { frame: GROUND_FRAME, signU: 1, signV: 1 },
        { radius: 4, x: 0, y: 0, z: 0 }
      );
    });
    expect(hook.result.current.refusal).toBeNull();
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('lets one cone end come to a point, never both', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('cone'));
    let accepted = false;
    act(() => {
      accepted = hook.result.current.setValue('topRadius', 0);
    });
    expect(accepted).toBe(true);
    act(() => {
      accepted = hook.result.current.setValue('bottomRadius', 0);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.refusal).toBe(
      '0; At least one radius must be greater than zero.'
    );
    expect(hook.result.current.values.bottomRadius).toBe(6);
    expect(hook.result.current.canFinish).toBe(false);
    // A drag to zero beside it simply does not take.
    act(() => {
      hook.result.current.previewValue('bottomRadius', 0);
    });
    expect(hook.result.current.values.bottomRadius).toBe(6);
  });

  it('keeps a typed position parametric', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start('cylinder'));
    act(() => {
      hook.result.current.setValue('x', 15, 'gap');
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        kind: 'cylinder',
        position: { x: 'gap', y: 0, z: 0 }
      })
    );
  });

  it('names each start anew, even of the same tool', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('box'));
    const first = hook.result.current.sessionId;
    act(() => hook.result.current.start('box'));
    expect(hook.result.current.sessionId).not.toBe(first);
    act(() => {
      hook.result.current.cancel(true);
    });
    expect(hook.result.current.sessionId).toBeNull();
  });

  it('refuses a footprint for a command placed some other way', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve'));
    expect(
      hook.result.current.placeFootprint(
        { frame: GROUND_FRAME, signU: 1, signV: 1 },
        { radius: 4 }
      )
    ).toBe(false);
  });
});

describe('U09 phase 6: datums and a picture', () => {
  const PLANE_A = {
    kind: 'plane' as const,
    key: 'canonical:XY',
    source: { type: 'canonical' as const, plane: 'XY' as const, offset: 0 },
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 }
  };

  it('judges a datum by its check, not by a body', async () => {
    let resolved = false;
    const { hook, commit } = setup({
      buildCommand: () => ({
        validate: () => undefined,
        apply: (document) => document,
        resultBodyId: undefined,
        check: () => {
          if (!resolved) throw new Error('Plane 1 did not resolve.');
        }
      })
    });
    act(() => hook.result.current.start('datum-plane'));
    expect(hook.result.current.pickRef(PLANE_A)).toBe(true);
    await waitFor(() =>
      expect(hook.result.current.refusal).toBe('Plane 1 did not resolve.')
    );
    expect(hook.result.current.canFinish).toBe(false);
    resolved = true;
    act(() => hook.result.current.previewValue('offset', 4));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledWith(
      {
        tool: 'datum-plane',
        definition: { kind: 'offset', source: PLANE_A.source, offset: 4 }
      },
      'Plane 1',
      null,
      expect.any(Function)
    );
  });

  it('refuses a source kind the tool does not take', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve'));
    expect(hook.result.current.pickRef(PLANE_A)).toBe(false);
  });

  it('refuses a plane for a picture that has not resolved', () => {
    const { hook } = setup({
      imagePlaneBasis: (plane) => (plane.type === 'datum' ? null : TOP)
    });
    const record = {
      imageId: 'image_1',
      name: 'Drawing',
      pixelWidth: 200,
      pixelHeight: 100,
      width: 100,
      opacity: 0.6
    } as never;
    act(() =>
      hook.result.current.start('reference-image', [], [], [], {
        image: { record, plane: null, center: { u: 0, v: 0 }, calibration: [] }
      })
    );
    act(() => {
      hook.result.current.placeImage({
        plane: { type: 'datum', datumFeatureId: 'datum_1' as never }
      });
    });
    expect(hook.result.current.slots.image?.plane).toBeNull();
    expect(hook.result.current.refusal).toMatch(/has not resolved/);
    expect(hook.result.current.canFinish).toBe(false);
  });

  it('places a picture with no kernel build, and writes the real distance into its width', () => {
    const basis: PlaneBasis = TOP;
    const { hook, commit, built } = setup({ imagePlaneBasis: () => basis });
    const record = {
      imageId: 'image_1',
      name: 'Drawing',
      pixelWidth: 200,
      pixelHeight: 100,
      width: 100,
      opacity: 0.6,
      center: { u: 0, v: 0 },
      rotationDeg: 0
    } as never;
    act(() =>
      hook.result.current.start('reference-image', [], [], [], {
        image: { record, plane: null, center: { u: 0, v: 0 }, calibration: [] }
      })
    );
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      hook.result.current.placeImage({
        plane: { type: 'canonical', plane: 'XY', offset: 0 },
        point: { x: 0, y: 0, z: 30 }
      });
    });
    expect(hook.result.current.canFinish).toBe(true);
    act(() => hook.result.current.setOption('clicks', 'scale'));
    act(() => {
      hook.result.current.placeImage({ point: { x: -50, y: 25, z: 30 } });
    });
    act(() => {
      hook.result.current.placeImage({ point: { x: 0, y: 25, z: 30 } });
    });
    // 100 of 200 pixels at width 100: 50 apart.
    expect(hook.result.current.values.span).toBeCloseTo(50);
    let accepted = false;
    act(() => {
      accepted = hook.result.current.setValue('span', 10);
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.values.width).toBeCloseTo(20);
    // A distance that would make it wider than a picture can be is refused,
    // and Done waits until a distance is taken.
    act(() => {
      accepted = hook.result.current.setValue('span', 1e7);
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.refusal).toMatch(/cannot take/);
    expect(hook.result.current.canFinish).toBe(false);
    // An unrelated option leaves it refused.
    act(() => hook.result.current.setOption('opacity', '0.4'));
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      accepted = hook.result.current.setValue('span', 10);
    });
    expect(hook.result.current.canFinish).toBe(true);
    act(() => {
      hook.result.current.done();
    });
    expect(built).toEqual([]);
    const [request, title] = commit.mock.calls[0]!;
    expect(title).toBe('Image');
    expect(request).toMatchObject({
      tool: 'reference-image',
      image: { width: 20, opacity: 0.4 }
    });
  });
});

describe('useInPlaceCommand: editing a stored feature', () => {
  const SEED: InPlaceEditSeed = {
    featureId: 'feat_1' as FeatureId,
    nodeId: 'node_1',
    name: 'Cut 2',
    data: {
      featureKind: 'boolean',
      operation: 'subtract',
      targetBodyIds: ['body_a' as BodyId, 'body_b' as BodyId]
    },
    resultBodyId: BODY,
    ownBodyIds: [BODY],
    slots: {
      profiles: [],
      axisId: null,
      path: [],
      guide: [],
      faces: [],
      bodies: [
        {
          bodyId: 'body_a' as BodyId,
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 }
        },
        {
          bodyId: 'body_b' as BodyId,
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 }
        }
      ],
      plane: null,
      edges: []
    },
    values: {},
    raws: {},
    touched: [],
    options: { operation: 'subtract', keepOriginals: 'none' },
    axes: [],
    choices: {},
    lockedOptions: ['keepOriginals'],
    notice: null
  };

  it('previews and commits the edit, under its own name', async () => {
    const buildCommand = vi.fn<UseInPlaceCommandOptions['buildCommand']>(
      () => ({
        validate: () => undefined,
        apply: (document) => document,
        resultBodyId: BODY
      })
    );
    const { hook, commit } = setup({ buildCommand });
    act(() => hook.result.current.edit('subtract', SEED));
    expect(hook.result.current.editing).toBe(SEED);
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    expect(buildCommand).toHaveBeenLastCalledWith(
      {
        tool: 'boolean',
        operation: 'subtract',
        targetBodyIds: ['body_a', 'body_b']
      },
      'Subtract',
      SEED
    );
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'subtract' }),
      'Cut 2',
      SEED,
      expect.any(Function)
    );
  });

  it("reads an edited plane's written fields again when the model changes", () => {
    let offset = 5;
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      evaluate: (value) =>
        value === 'gap'
          ? offset
          : typeof value === 'number'
            ? value
            : Number(value),
      baseVersion: 1
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('mirror', {
        ...SEED,
        data: {
          featureKind: 'mirror',
          targetBodyId: 'body_a' as BodyId,
          plane: {
            origin: { x: 'gap', y: 0, z: 0 },
            normal: { x: 1, y: 0, z: 0 }
          }
        } as never,
        slots: {
          ...SEED.slots,
          bodies: [],
          plane: {
            kind: 'saved',
            origin: { x: 5, y: 0, z: 0 },
            normal: { x: 1, y: 0, z: 0 },
            fields: {
              origin: { x: 'gap', y: '0', z: '0' },
              normal: { x: '1', y: '0', z: '0' }
            }
          }
        }
      })
    );
    offset = 8;
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.plane).toMatchObject({
      kind: 'saved',
      origin: { x: 8, y: 0, z: 0 }
    });
  });

  it('takes an edited plane retyped by someone else as the feature stores it now', () => {
    const mirror = (x: number) => ({
      featureKind: 'mirror',
      targetBodyId: 'body_a' as BodyId,
      plane: { origin: { x, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    let stored = mirror(5);
    const base = () =>
      ({
        nodes: {
          node_1: {
            id: 'node_1',
            kind: 'feature',
            featureId: SEED.featureId,
            name: 'Mirror',
            data: stored
          }
        },
        derived: { bodyRepresentations: { [BODY]: {} }, warnings: [] }
      }) as unknown as ProjectDocument;
    let document = base();
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseDocument: () => document,
      evaluate: (value) => Number(value),
      baseVersion: 1
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('mirror', {
        ...SEED,
        data: stored as never,
        slots: {
          ...SEED.slots,
          bodies: [],
          plane: {
            kind: 'saved',
            origin: { x: 5, y: 0, z: 0 },
            normal: { x: 1, y: 0, z: 0 },
            fields: {
              origin: { x: '5', y: '0', z: '0' },
              normal: { x: '1', y: '0', z: '0' }
            }
          }
        }
      })
    );
    stored = mirror(12);
    document = base();
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.plane).toMatchObject({
      kind: 'saved',
      origin: { x: 12, y: 0, z: 0 },
      fields: { origin: { x: '12' } }
    });
  });

  it('takes a value changed by someone else unless the user changed it', () => {
    let live: Record<string, number> = { planeOX: 5, planeOY: 0 };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      evaluate: (value) => Number(value),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'mirror',
        seed: { ...edit, values: { ...live }, raws: {} }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('mirror', {
        ...SEED,
        values: { planeOX: 5, planeOY: 0 },
        options: { planeMode: 'typed' }
      })
    );
    act(() => {
      hook.result.current.setValue('planeOY', 3);
    });
    live = { planeOX: 12, planeOY: 9 };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.values).toMatchObject({
      planeOX: 12,
      planeOY: 3
    });
    // The feature coming to match the user's value does not make it the
    // feature's again.
    live = { planeOX: 12, planeOY: 3 };
    hook.rerender({ ...options, baseVersion: 3 });
    live = { planeOX: 12, planeOY: 7 };
    hook.rerender({ ...options, baseVersion: 4 });
    expect(hook.result.current.values.planeOY).toBe(3);
  });

  it('follows whether the feature stores a value at all', () => {
    let live: { values: Record<string, number>; touched: string[] } = {
      values: { depth: 8 },
      touched: ['depth']
    };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'subtract',
        seed: { ...edit, values: live.values, raws: {}, touched: live.touched }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('subtract', {
        ...SEED,
        values: { depth: 8 },
        touched: ['depth']
      })
    );
    // A collaborator stores a size that was absent: it is the feature's own.
    live = { values: { depth: 8, step: 3 }, touched: ['depth', 'step'] };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.touched).toContain('step');
    // And drops it again: absent once more, for its default to follow.
    live = { values: { depth: 8 }, touched: ['depth'] };
    hook.rerender({ ...options, baseVersion: 3 });
    expect(hook.result.current.touched).not.toContain('step');
    expect(hook.result.current.values).not.toHaveProperty('step');
  });

  it('takes an option changed by someone else unless the user changed it', () => {
    let live: Record<string, string> = {
      planeMode: 'typed',
      keepOriginal: 'no'
    };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'split',
        seed: { ...edit, options: { ...live } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('split', {
        ...SEED,
        values: {},
        options: { planeMode: 'typed', keepOriginal: 'no' }
      })
    );
    act(() => {
      hook.result.current.setOption('planeMode', 'picked');
    });
    live = { planeMode: 'typed', keepOriginal: 'yes' };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.options).toMatchObject({
      planeMode: 'picked',
      keepOriginal: 'yes'
    });
  });

  it('takes picks re-pointed by someone else unless the user repicked them', () => {
    const body = (bodyId: string, size = 1) => ({
      bodyId: bodyId as BodyId,
      min: { x: 0, y: 0, z: 0 },
      max: { x: size, y: size, z: size }
    });
    let bodies = [body('body_a'), body('body_b')];
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'subtract',
        seed: { ...edit, slots: { ...edit.slots, bodies } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('subtract', {
        ...SEED,
        slots: { ...SEED.slots, bodies: [body('body_a'), body('body_b')] }
      })
    );
    // The same bodies measured again are not a change.
    bodies = [body('body_a', 2), body('body_b')];
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.bodies[0]?.max.x).toBe(1);
    // An undo re-points the cutter: the untouched list follows.
    bodies = [body('body_a'), body('body_c')];
    hook.rerender({ ...options, baseVersion: 3 });
    expect(hook.result.current.slots.bodies.map((b) => b.bodyId)).toEqual([
      'body_a',
      'body_c'
    ]);
    // Once the user picks, the list is theirs.
    act(() => {
      hook.result.current.pickBody(body('body_d'));
    });
    bodies = [body('body_a'), body('body_e')];
    hook.rerender({ ...options, baseVersion: 4 });
    expect(hook.result.current.slots.bodies.map((b) => b.bodyId)).toContain(
      'body_d'
    );
  });

  it('re-arms with the command that now makes the feature', () => {
    let live: { tool: 'subtract' | 'union' | 'scale'; seed: InPlaceEditSeed } =
      {
        tool: 'subtract',
        seed: SEED
      };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: () => live
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() => hook.result.current.edit('subtract', SEED));
    // Another Boolean operation is this command's option, not a new one.
    live = {
      tool: 'union',
      seed: { ...SEED, options: { ...SEED.options, operation: 'union' } }
    };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.tool).toBe('union');
    expect(hook.result.current.editing).toBe(SEED);
    // A feature another command makes now re-arms that command.
    const scaled = { ...SEED, options: { pivot: 'origin', copy: 'no' } };
    live = { tool: 'scale', seed: scaled };
    hook.rerender({ ...options, baseVersion: 3 });
    expect(hook.result.current.tool).toBe('scale');
    expect(hook.result.current.editing).toBe(scaled);
  });

  it('ends an edit of a feature no in-place command edits any more', () => {
    let live: { tool: 'subtract'; seed: InPlaceEditSeed } | null = {
      tool: 'subtract',
      seed: SEED
    };
    const onStatus = vi.fn();
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      onStatus,
      baseVersion: 1,
      reseed: () => live
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() => hook.result.current.edit('subtract', SEED));
    live = null;
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.editing).toBeNull();
    expect(onStatus).toHaveBeenCalledWith(
      expect.stringMatching(/no longer edited here/)
    );
  });

  it('a face found again under a new hash is still the seeded pick', () => {
    const face = (hash: number, faceHash: number) => ({
      bodyId: 'body_a' as BodyId,
      hash,
      topologyId: `f${hash}`,
      reference: { kind: 'lineage', name: 'top' } as never,
      centroid: { x: 0, y: 0, z: faceHash }
    });
    let faces = [face(1, 1)];
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'shell',
        seed: { ...edit, slots: { ...edit.slots, faces } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('shell', {
        ...SEED,
        options: {},
        slots: { ...SEED.slots, bodies: [], faces: [face(1, 1)] }
      })
    );
    // An upstream rebuild renames the face's hash (the live re-check).
    act(() => hook.result.current.setPicks({ faces: [face(7, 1)] }));
    // A collaborator then changes the faces: the untouched slot follows.
    faces = [
      face(7, 1),
      { ...face(9, 2), reference: { kind: 'lineage', name: 'side' } as never }
    ];
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([7, 9]);
  });

  it('a re-armed edit drops a refusal typed in the edit before it', () => {
    let live: {
      tool: 'linear-pattern' | 'grid-pattern';
      seed: InPlaceEditSeed;
    } = {
      tool: 'linear-pattern',
      seed: SEED
    };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: () => live
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('linear-pattern', { ...SEED, options: {} })
    );
    act(() => {
      hook.result.current.setValue('count', 0.5, '0.5');
    });
    expect(hook.result.current.refusal).toMatch(/takes/);
    live = { tool: 'grid-pattern', seed: { ...SEED, options: {} } };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.tool).toBe('grid-pattern');
    expect(hook.result.current.refusal ?? '').not.toMatch(/takes/);
  });

  it('keeps a clicked draft hinge on its face as the faces follow the feature', () => {
    const face = (
      hash: number,
      point?: { x: number; y: number; z: number }
    ) => ({
      bodyId: 'body_a' as BodyId,
      hash,
      topologyId: `f${hash}`,
      surfaceType: 'plane',
      normal: { x: 1, y: 0, z: 0 },
      centroid: { x: 0, y: 0, z: hash },
      ...(point ? { point } : {})
    });
    let stored = [face(1), face(2)];
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'draft',
        seed: { ...edit, slots: { ...edit.slots, faces: stored } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('draft', {
        ...SEED,
        options: { neutral: 'point' },
        slots: { ...SEED.slots, bodies: [], faces: [face(1), face(2)] }
      })
    );
    act(() => {
      hook.result.current.pickFace(face(2, { x: 5, y: 6, z: 7 }));
    });
    // A collaborator drafts another face: it joins, the hinge stays put.
    stored = [face(1), face(2), face(4)];
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([
      1, 2, 4
    ]);
    expect(hook.result.current.slots.faces[1]?.point).toEqual({
      x: 5,
      y: 6,
      z: 7
    });
    // And takes the hinge's face out: the hinge asks for a click again.
    stored = [face(1), face(4)];
    hook.rerender({ ...options, baseVersion: 3 });
    expect(hook.result.current.slots.faces.map((f) => f.hash)).toEqual([1, 4]);
    expect(hook.result.current.slots.faces.some((f) => f.point)).toBe(false);
  });

  it('builds a helix saved axis that only reads once the model changes', () => {
    let rise: number | null = null;
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      evaluate: (value) => (value === 'rise' ? rise : Number(value)),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'helical-sweep',
        seed: { ...edit, slots: { ...edit.slots, axisId: 'saved' } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    const data = {
      featureKind: 'helical-sweep',
      profile: { sketchId: SKETCH },
      axisOrigin: { x: 0, y: 0, z: 'rise' },
      axisDirection: { x: 0, y: 0, z: 1 }
    } as never;
    // Armed while its parameter does not resolve: no saved axis yet.
    act(() =>
      hook.result.current.edit('helical-sweep', {
        ...SEED,
        data,
        axes: [],
        options: {},
        slots: { ...SEED.slots, bodies: [], profiles: [PICK], axisId: null }
      })
    );
    expect(hook.result.current.slots.axis).toBeNull();
    rise = 10;
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.axis?.origin).toEqual({
      x: 0,
      y: 0,
      z: 10
    });
  });

  it('keeps a hole moved by a click when the feature is read again', () => {
    const face = {
      bodyId: 'body_a' as BodyId,
      hash: 11,
      topologyId: 'f11',
      surfaceType: 'plane',
      normal: { x: 0, y: 0, z: 1 },
      centroid: { x: 10, y: 5, z: 4 }
    };
    const stored = {
      ...face,
      point: { x: 10, y: 5, z: 4 },
      savedPosition: true as const
    };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'hole',
        seed: { ...edit, slots: { ...edit.slots, faces: [{ ...stored }] } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('hole', {
        ...SEED,
        options: { place: 'clicked', depthMode: 'through', style: 'simple' },
        slots: { ...SEED.slots, bodies: [], faces: [stored] }
      })
    );
    // Clicked elsewhere on the same face: the hole moves there.
    act(() => {
      hook.result.current.pickFace({ ...face, point: { x: 14, y: 7, z: 4 } });
    });
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.faces[0]?.point).toEqual({
      x: 14,
      y: 7,
      z: 4
    });
    expect(hook.result.current.slots.faces[0]?.savedPosition).toBeUndefined();
  });

  it('a re-check read before the live reseed does not undo it', () => {
    const curve = (entityId: string) => ({ sketchId: SKETCH, entityId });
    let path = [curve('a')];
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'sweep',
        seed: { ...edit, slots: { ...edit.slots, path } }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('sweep', {
        ...SEED,
        options: {},
        slots: { ...SEED.slots, bodies: [], profiles: [PICK], path }
      })
    );
    const read = hook.result.current.slots;
    // One update re-points the path to b and deletes a: the reseed takes b,
    // then the re-check, which read a, reports a gone.
    path = [curve('b')];
    hook.rerender({ ...options, baseVersion: 2 });
    act(() => hook.result.current.setPicks({ path: [] }, read));
    expect(hook.result.current.slots.path.map((c) => c.entityId)).toEqual([
      'b'
    ]);
    // Read from the slots as they are now, it applies.
    act(() =>
      hook.result.current.setPicks({ path: [] }, hook.result.current.slots)
    );
    expect(hook.result.current.slots.path).toEqual([]);
  });

  it('a derived step size still takes the size the feature comes to store', () => {
    const face = {
      bodyId: 'body_a' as BodyId,
      hash: 11,
      topologyId: 'f11',
      surfaceType: 'plane',
      normal: { x: 0, y: 0, z: 1 },
      centroid: { x: 10, y: 5, z: 4 },
      point: { x: 10, y: 5, z: 4 },
      savedPosition: true as const
    };
    let live: { values: Record<string, number>; touched: string[] } = {
      values: { diameter: 10 },
      touched: ['diameter']
    };
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      baseVersion: 1,
      reseed: (edit) => ({
        tool: 'hole',
        seed: { ...edit, values: live.values, raws: {}, touched: live.touched }
      })
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('hole', {
        ...SEED,
        values: { diameter: 10 },
        touched: ['diameter'],
        options: {
          place: 'clicked',
          depthMode: 'through',
          style: 'counterbore'
        },
        slots: { ...SEED.slots, bodies: [], faces: [face] }
      })
    );
    // Unset, the counterbore follows the bore: 1.8 × 10.
    expect(hook.result.current.values.counterboreDiameter).toBe(18);
    // A collaborator stores one: it is the feature's own now.
    live = {
      values: { diameter: 10, counterboreDiameter: 11 },
      touched: ['diameter', 'counterboreDiameter']
    };
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.values.counterboreDiameter).toBe(11);
    expect(hook.result.current.touched).toContain('counterboreDiameter');
  });

  it('previews a re-armed edit that builds the same thing', async () => {
    const { hook } = setup();
    act(() => hook.result.current.edit('subtract', SEED));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.cancel();
      hook.result.current.edit('subtract', { ...SEED });
    });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it("reads a helix's saved axis again when the model changes", () => {
    let rise = 10;
    const options: UseInPlaceCommandOptions = {
      ...setupOptions([], vi.fn()),
      evaluate: (value) => (value === 'rise' ? rise : null),
      baseVersion: 1
    };
    const hook = renderHook(
      (props: UseInPlaceCommandOptions) => useInPlaceCommand(props),
      { initialProps: options }
    );
    act(() =>
      hook.result.current.edit('helical-sweep', {
        ...SEED,
        data: {
          featureKind: 'helical-sweep',
          profile: { sketchId: SKETCH },
          axisOrigin: { x: 0, y: 0, z: 'rise' },
          axisDirection: { x: 0, y: 0, z: 1 }
        } as never,
        axes: [
          {
            id: 'saved',
            label: 'Its saved axis',
            origin: { x: 0, y: 0, z: 10 },
            direction: { x: 0, y: 0, z: 1 },
            choice: { saved: true }
          }
        ],
        slots: {
          ...SEED.slots,
          bodies: [],
          profiles: [PICK],
          axisId: 'saved'
        }
      })
    );
    rise = 25;
    hook.rerender({ ...options, baseVersion: 2 });
    expect(hook.result.current.slots.axis?.origin).toEqual({
      x: 0,
      y: 0,
      z: 25
    });
  });

  it('keeps a new feature open until its commit lands, and open to retry if refused', async () => {
    let settle: (committed: boolean) => void = () => undefined;
    const commit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        })
    );
    const { hook } = setup({ commit });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    // Validating: still open, its picks kept, no second Done, and no
    // Cancel that would claim nothing was added.
    expect(hook.result.current.active).toBe(true);
    expect(hook.result.current.canFinish).toBe(false);
    let closed = true;
    act(() => {
      closed = hook.result.current.cancel();
    });
    expect(closed).toBe(false);
    expect(hook.result.current.active).toBe(true);
    // Refused (or held off by another exact operation): there to retry.
    await act(async () => {
      settle(false);
      await Promise.resolve();
    });
    expect(hook.result.current.active).toBe(true);
    expect(hook.result.current.slots.profiles).toHaveLength(1);
    expect(hook.result.current.canFinish).toBe(true);
    act(() => {
      hook.result.current.done();
    });
    // Landed: the command ends.
    await act(async () => {
      settle(true);
      await Promise.resolve();
    });
    expect(hook.result.current.active).toBe(false);
  });

  it('withdraws a validating commit when another command takes over', async () => {
    let withdrawn: () => boolean = () => false;
    const commit = vi.fn(
      (
        _request: InPlaceRequest,
        _title: string,
        _edit: InPlaceEditSeed | null,
        isWithdrawn: () => boolean
      ) => {
        withdrawn = isWithdrawn;
        return new Promise<boolean>(() => undefined);
      }
    );
    const { hook } = setup({ commit });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    expect(withdrawn()).toBe(false);
    // A tool switch closes it quietly: the candidate is no longer wanted.
    act(() => {
      hook.result.current.cancel(true);
    });
    expect(hook.result.current.active).toBe(false);
    expect(withdrawn()).toBe(true);
  });

  it('keeps an edit open until its commit lands, and open to retry if refused', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.edit('subtract', SEED));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    // Validating: still the edit, and no second Done; its inputs hold
    // still, so what lands is what is shown.
    expect(hook.result.current.editing).toBe(SEED);
    expect(hook.result.current.canFinish).toBe(false);
    act(() => {
      hook.result.current.setOption('operation', 'union');
      hook.result.current.pickBody({
        bodyId: 'body_c' as BodyId,
        min: { x: 0, y: 0, z: 0 },
        max: { x: 1, y: 1, z: 1 }
      });
    });
    expect(hook.result.current.options.operation).toBe('subtract');
    expect(hook.result.current.slots.bodies).toHaveLength(2);
    // Refused: the edit is there to correct, and Done can go again.
    act(() => hook.result.current.settleEdit(SEED, false));
    expect(hook.result.current.editing).toBe(SEED);
    expect(hook.result.current.canFinish).toBe(true);
    act(() => {
      hook.result.current.done();
    });
    // Landed: the edit ends.
    act(() => hook.result.current.settleEdit(SEED, true));
    expect(hook.result.current.editing).toBeNull();
  });

  it('switches operation with its bodies, and hides a locked option', () => {
    const { hook } = setup();
    act(() => hook.result.current.edit('subtract', SEED));
    expect(hook.result.current.optionSpecs.map((option) => option.id)).toEqual([
      'operation'
    ]);
    act(() => hook.result.current.setOption('operation', 'union'));
    expect(hook.result.current.tool).toBe('union');
    expect(hook.result.current.slots.bodies).toHaveLength(2);
  });

  it('says the feature is unchanged when canceled', () => {
    const onStatus = vi.fn();
    const { hook } = setup({ onStatus });
    act(() => hook.result.current.edit('subtract', SEED));
    act(() => {
      hook.result.current.cancel();
    });
    expect(onStatus).toHaveBeenCalledWith('Edit canceled; Cut 2 is unchanged.');
    expect(hook.result.current.editing).toBeNull();
  });
});

describe('useInPlaceCommand: fillet edges', () => {
  const edge = (bodyId: string, hash: number) => ({
    bodyId: bodyId as BodyId,
    hash,
    topologyId: `e${hash}`
  });

  it("collects one body's edges in pick order and toggles a repeat off", () => {
    const { hook } = setup();
    act(() =>
      hook.result.current.start('fillet', [], [], [], { edges: [edge('a', 1)] })
    );
    act(() => {
      hook.result.current.pickEdge(edge('a', 2));
    });
    expect(hook.result.current.slots.edges.map((e) => e.hash)).toEqual([1, 2]);
    act(() => {
      hook.result.current.pickEdge(edge('a', 1));
    });
    expect(hook.result.current.slots.edges.map((e) => e.hash)).toEqual([2]);
    // Another body's edge starts the set over.
    act(() => {
      hook.result.current.pickEdge(edge('b', 7));
    });
    expect(hook.result.current.slots.edges).toEqual([edge('b', 7)]);
    // Select all replaces the set, keeping one body.
    act(() => {
      hook.result.current.setEdges([edge('a', 1), edge('a', 2), edge('b', 3)]);
    });
    expect(hook.result.current.slots.edges.map((e) => e.hash)).toEqual([1, 2]);
  });

  it('refuses an edge while a command takes none', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('shell'));
    let taken = true;
    act(() => {
      taken = hook.result.current.pickEdge(edge('a', 1));
    });
    expect(taken).toBe(false);
  });
});

describe("useInPlaceCommand: editing a fillet's edge set", () => {
  const named = (hash: number) => ({
    bodyId: 'body_a' as BodyId,
    hash,
    topologyId: `e${hash}`,
    reference: { kind: 'edge', currentHash: hash } as never
  });

  it('goes hash-only with an added edge, and names the set again once it is dropped', async () => {
    const seed: InPlaceEditSeed = {
      featureId: 'feat_f' as FeatureId,
      nodeId: 'node_f',
      name: 'Rim',
      data: {
        featureKind: 'fillet',
        targetBodyId: 'body_a' as BodyId,
        edgeHashes: [1, 2],
        radius: 2
      },
      resultBodyId: BODY,
      ownBodyIds: [BODY],
      slots: {
        profiles: [],
        axisId: null,
        path: [],
        guide: [],
        faces: [],
        bodies: [],
        plane: null,
        edges: [named(1), named(2)]
      },
      values: { radius: 2 },
      raws: {},
      touched: ['radius'],
      options: { law: 'constant' },
      axes: [],
      choices: {},
      lockedOptions: [],
      notice: null
    };
    const { hook, built } = setup();
    act(() => hook.result.current.edit('fillet', seed));
    const added = { bodyId: 'body_a' as BodyId, hash: 3, topologyId: 'e3' };
    act(() => {
      hook.result.current.pickEdge(added);
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({ edgeHashes: [1, 2, 3] })
    );
    expect(built.at(-1)).not.toHaveProperty('edgeReferences');
    act(() => {
      hook.result.current.pickEdge(added);
    });
    await waitFor(() =>
      expect(built.at(-1)).toMatchObject({
        edgeHashes: [1, 2],
        edgeReferences: [named(1).reference, named(2).reference]
      })
    );
  });
});

describe('useInPlaceCommand: axes and directions picked in the model', () => {
  const EDGE_AXIS = {
    kind: 'edge' as const,
    source: {
      type: 'edge' as const,
      bodyId: 'body_a' as BodyId,
      edgeReference: {} as never
    }
  };
  /** A model edge along Z at x = 40, in the FRONT sketch's plane (y = 0). */
  const line = (y = 0) => ({
    id: `edge:body_a:${y}`,
    label: 'The picked edge',
    origin: { x: 40, y, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    choice: { define: EDGE_AXIS }
  });
  const BOX = {
    bodyId: 'body_a' as BodyId,
    min: { x: 0, y: 0, z: 0 },
    max: { x: 10, y: 10, z: 10 }
  };

  it('a revolve takes a picked edge in its plane, and lets it go again', () => {
    const onStatus = vi.fn();
    const { hook } = setup({ onStatus });
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.pickAxisLine(line());
    });
    expect(hook.result.current.axisCandidates[0]?.id).toBe('edge:body_a:0');
    expect(hook.result.current.slots.axis?.id).toBe('edge:body_a:0');
    expect(hook.result.current.request).toMatchObject({
      tool: 'revolve',
      axis: { newAxis: EDGE_AXIS }
    });
    // Clicked again, it comes back out.
    act(() => {
      hook.result.current.pickAxisLine(line());
    });
    expect(hook.result.current.slots.axis).toBeNull();
    expect(hook.result.current.axisCandidates.map((c) => c.id)).not.toContain(
      'edge:body_a:0'
    );
    // Off the profile's plane, it is refused in words.
    act(() => {
      hook.result.current.pickAxisLine(line(5));
    });
    expect(hook.result.current.slots.axis).toBeNull();
    expect(onStatus).toHaveBeenCalledWith(
      expect.stringMatching(/leaves the profile's sketch plane/)
    );
  });

  it('a new profile on another sketch lets the picked line go', () => {
    const { hook } = setup();
    act(() => hook.result.current.start('revolve', [PICK]));
    act(() => {
      hook.result.current.pickAxisLine(line());
    });
    act(() => hook.result.current.pickProfile(SECOND));
    expect(hook.result.current.slots.axis).toBeNull();
    expect(hook.result.current.axisCandidates.map((c) => c.id)).not.toContain(
      'edge:body_a:0'
    );
  });

  it('a linear pattern reads a picked line or face normal as its direction', () => {
    const { hook } = setup({
      datumAxes: {
        ['axis_1' as FeatureId]: {
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 1, z: 1 }
        }
      }
    });
    act(() => hook.result.current.start('linear-pattern', [], [], [BOX]));
    act(() => {
      hook.result.current.pickDirection({ x: 0, y: 0, z: -2 });
    });
    expect(hook.result.current.options.axis).toBe('custom');
    expect(hook.result.current.values).toMatchObject({
      dirX: 0,
      dirY: 0,
      dirZ: -1
    });
    expect(hook.result.current.touched).toEqual(
      expect.arrayContaining(['dirX', 'dirY', 'dirZ'])
    );
    // A drawn datum axis is a direction too, not an axis slot.
    expect(hook.result.current.axisCandidates.map((c) => c.id)).toEqual([
      'datum:axis_1'
    ]);
    act(() => hook.result.current.pickAxis('datum:axis_1'));
    expect(hook.result.current.slots.axis).toBeNull();
    expect(hook.result.current.values.dirY).toBeCloseTo(Math.SQRT1_2);
    // Along a world axis, it is that axis.
    act(() => {
      hook.result.current.pickAxisLine({
        ...line(),
        direction: { x: 1, y: 0, z: 0 }
      });
    });
    expect(hook.result.current.options.axis).toBe('x');
    expect(hook.result.current.request).toMatchObject({ axis: 'x' });
  });
});
