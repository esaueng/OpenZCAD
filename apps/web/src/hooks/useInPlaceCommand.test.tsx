import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type {
  BodyId,
  FeatureId,
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
    expect(commit).toHaveBeenCalledWith(full, 'Revolve', null);
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
    act(() => hook.result.current.cancel(true));
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
    act(() => hook.result.current.cancel());
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
  it('suggests a radius through the profile and keeps a value the user set', async () => {
    const { hook } = setup();
    act(() => hook.result.current.start('helical-sweep', [PICK]));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    // The rectangle's middle sits 19 from the vertical axis and it is 12 tall.
    await waitFor(() =>
      expect(hook.result.current.values.radius).toBeCloseTo(19)
    );
    expect(hook.result.current.values.pitch).toBeCloseTo(15);
    expect(hook.result.current.handles.map((handle) => handle.valueId)).toEqual(
      ['radius', 'pitch', 'turns']
    );
    act(() => {
      hook.result.current.setValue('radius', 25);
    });
    act(() =>
      hook.result.current.pickProfile({ ...PICK, regionFingerprint: 8 })
    );
    expect(hook.result.current.values.radius).toBe(25);
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
    expect(hook.result.current.hint).toMatch(/Guide rail of 1/);
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
      plane: null
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
      SEED
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

  it('finishes a suppressed feature edit that builds no body', async () => {
    // Suppressed, the feature publishes no body: the preview still stands.
    const { hook } = setup({
      buildCommand: () => ({
        validate: () => undefined,
        apply: () =>
          ({
            derived: { bodyRepresentations: {}, warnings: [] }
          }) as unknown as ProjectDocument,
        resultBodyId: BODY
      })
    });
    act(() =>
      hook.result.current.edit('subtract', { ...SEED, suppressed: true })
    );
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
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
    act(() => hook.result.current.cancel());
    expect(onStatus).toHaveBeenCalledWith('Edit canceled; Cut 2 is unchanged.');
    expect(hook.result.current.editing).toBeNull();
  });
});
