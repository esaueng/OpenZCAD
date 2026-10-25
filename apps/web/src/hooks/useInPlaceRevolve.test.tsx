import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import type { BodyId, ProjectDocument, SketchId } from '@openzcad/shared';
import {
  useInPlaceRevolve,
  type InPlaceProfilePick,
  type InPlaceRevolveRequest,
  type UseInPlaceRevolveOptions
} from './useInPlaceRevolve';

const FRONT: PlaneBasis = {
  origin: { x: 0, y: 0, z: 0 },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 0, y: -1, z: 0 }
};
const SKETCH = 'sketch_1' as SketchId;
const BODY = 'body_preview' as BodyId;
const PICK: InPlaceProfilePick = {
  sketchId: SKETCH,
  reference: { all: true, sourceEntityIds: ['a', 'b'] },
  regionFingerprint: 7
};

function fakeDocument(withBody: boolean): ProjectDocument {
  return {
    derived: {
      bodyRepresentations: withBody ? { [BODY]: {} } : {},
      warnings: withBody ? [] : ['A line is not a closed profile.']
    }
  } as unknown as ProjectDocument;
}

function baseOptions(
  built: InPlaceRevolveRequest[],
  commit: (request: InPlaceRevolveRequest) => void,
  publishPreview: (body: unknown) => void = vi.fn()
): UseInPlaceRevolveOptions {
  return {
    sketchViews: [
      {
        sketchId: SKETCH,
        basis: FRONT,
        regions: [
          {
            regionFingerprint: 7,
            outer: [
              { x: 14, y: 3 },
              { x: 24, y: 3 },
              { x: 24, y: 15 },
              { x: 14, y: 15 }
            ]
          }
        ]
      }
    ],
    document: fakeDocument(true),
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
    datumLabel: () => 'Axis',
    onStatus: vi.fn()
  };
}

function setup(overrides: Partial<UseInPlaceRevolveOptions> = {}) {
  const commit = vi.fn<(request: InPlaceRevolveRequest) => void>();
  const publishPreview = vi.fn();
  const built: InPlaceRevolveRequest[] = [];
  const options: UseInPlaceRevolveOptions = {
    ...baseOptions(built, commit, publishPreview),
    ...overrides
  };
  const hook = renderHook(() => useInPlaceRevolve(options));
  return { hook, commit, publishPreview, built };
}

describe('useInPlaceRevolve', () => {
  it('walks profile → axis → angle in its hint', () => {
    const { hook } = setup();
    act(() => hook.result.current.start(null));
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

  it('places the handle about the picked axis, aimed at the region', () => {
    const { hook } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    expect(hook.result.current.placement).toMatchObject({
      center: { x: 0, y: 0, z: 9 },
      startDirection: { x: 1, y: 0, z: 0 }
    });
  });

  it('previews as soon as the axis is picked and finishes with the profile', async () => {
    const { hook, commit, publishPreview, built } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const published = publishPreview.mock.calls.at(-1)?.[0] as
      ProjectDocument | undefined;
    expect(published?.derived.bodyRepresentations[BODY]).toBeDefined();
    // A full turn is stored as an absent angle.
    expect(built.at(-1)).toEqual({
      sketchId: SKETCH,
      profile: PICK.reference,
      axis: { axis: 'vertical' }
    });
    act(() => {
      hook.result.current.done();
    });
    expect(commit).toHaveBeenCalledWith({
      sketchId: SKETCH,
      profile: PICK.reference,
      axis: { axis: 'vertical' }
    });
    expect(hook.result.current.active).toBe(false);
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });

  it('rebuilds for a new axis instead of republishing the old solid', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const before = built.length;
    act(() => hook.result.current.pickAxis('sketch-horizontal'));
    await waitFor(() => expect(built.length).toBeGreaterThan(before));
    expect(built.at(-1)?.axis).toEqual({ axis: 'horizontal' });
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('commits a typed expression rather than its value', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => hook.result.current.setAngle(270, 'sweep * 3'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => {
      hook.result.current.done();
    });
    expect(commit.mock.calls[0]![0].angleDeg).toBe('sweep * 3');
  });

  it('refuses an expression outside the revolve range instead of clamping it', async () => {
    const { hook, commit } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    act(() => hook.result.current.setAngle(400, 'sweep * 5'));
    expect(hook.result.current.refusal).toMatch(/sweep \* 5 is 400°/);
    expect(hook.result.current.angle).toBe(360);
    act(() => {
      hook.result.current.done();
    });
    // The full turn it kept, never the out-of-range expression.
    expect(commit.mock.calls[0]![0].angleDeg ?? 360).toBe(360);
  });

  it('keeps a sub-degree angle', async () => {
    const { hook, built } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    act(() => hook.result.current.setAngle(0.5));
    expect(hook.result.current.angle).toBe(0.5);
    await waitFor(() => expect(built.at(-1)?.angleDeg).toBe(0.5));
  });

  it('rebuilds the preview when the base document changes under it', async () => {
    let document = { ...fakeDocument(true), version: 1 } as ProjectDocument;
    const commit = vi.fn<(request: InPlaceRevolveRequest) => void>();
    const built: InPlaceRevolveRequest[] = [];
    const hook = renderHook(() =>
      useInPlaceRevolve({ ...baseOptions(built, commit), document })
    );
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
    const before = built.length;
    document = { ...document, version: 2 };
    hook.rerender();
    await waitFor(() => expect(built.length).toBeGreaterThan(before));
    await waitFor(() => expect(hook.result.current.canFinish).toBe(true));
  });

  it('cannot finish while the preview is refused, and says why', async () => {
    const { hook, commit } = setup({ baseDocument: () => fakeDocument(false) });
    act(() => hook.result.current.start(PICK));
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
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.pickAxis('sketch-vertical'));
    act(() =>
      hook.result.current.pickProfile({ ...PICK, regionFingerprint: 8 })
    );
    expect(hook.result.current.axisId).toBe('sketch-vertical');
  });

  it('ends quietly when another action closes it', () => {
    const onStatus = vi.fn();
    const { hook } = setup({ onStatus });
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.cancel(true));
    expect(hook.result.current.active).toBe(false);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('cancels without committing and clears the preview', () => {
    const { hook, commit, publishPreview } = setup();
    act(() => hook.result.current.start(PICK));
    act(() => hook.result.current.cancel());
    expect(hook.result.current.active).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(publishPreview).toHaveBeenLastCalledWith(null);
  });
});
