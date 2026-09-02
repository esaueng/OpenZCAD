import { act, renderHook, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toBodyId, toUserId, type TopologySelection } from '@openzcad/shared';
import {
  loadProjectMeasurements,
  saveProjectMeasurements
} from '../lib/localProjectStore';
import type { Measurement, MeasurementTarget } from '../lib/measurements';
import type { StoredMeasurementRecord } from '../lib/measurementRecord';
import {
  useMeasurementWorkbench,
  type MeasurementWorkbenchInput
} from './useMeasurementWorkbench';

vi.mock('../lib/localProjectStore', () => ({
  loadProjectMeasurements: vi.fn(),
  saveProjectMeasurements: vi.fn()
}));

// The hook defers `../lib/measurements` to a dynamic import. Warming the module
// registry here keeps that import a microtask, so the fake-timer case below can
// flush it and the pre-arrival case below can still lose the race deliberately.
beforeAll(async () => {
  await import('../lib/measurements');
});

const load = vi.mocked(loadProjectMeasurements);
const save = vi.mocked(saveProjectMeasurements);

const target: MeasurementTarget = {
  bodyId: toBodyId('body-1'),
  bodyName: 'Cylinder',
  kind: 'edge',
  label: 'Edge 1',
  semantic: 'edge-midpoint',
  quality: 'exact-kernel'
};

function measurement(id: string, annotated: boolean): Measurement {
  return {
    id,
    kind: 'edge-length',
    label: 'Edge 1',
    targets: [target],
    result: { value: 12, dimension: 'length' },
    quality: 'exact-kernel',
    status: 'current',
    sourceRevision: 1,
    sourceUnit: 'mm',
    visible: true,
    ...(annotated
      ? {
          annotation: {
            anchor: { x: 0, y: 0, z: 0 },
            segments: [
              { start: { x: 0, y: 0, z: 0 }, end: { x: 12, y: 0, z: 0 } }
            ]
          }
        }
      : {})
  };
}

function record(
  projectId: string,
  measurements: Measurement[]
): StoredMeasurementRecord {
  return {
    projectId,
    version: 1,
    updatedAt: '2024-01-01T00:00:00.000Z',
    measurements,
    display: { unit: 'inch', precision: 3, radialDisplay: 'radius' }
  };
}

const faceSelection: TopologySelection = {
  bodyId: toBodyId('body-1'),
  kind: 'face',
  topologyId: 'face-1'
};

function input(
  overrides: Partial<MeasurementWorkbenchInput> = {}
): MeasurementWorkbenchInput {
  return {
    doc: null,
    modelingLocked: false,
    exactGeometryReady: false,
    representations: {},
    renderedRepresentations: {},
    viewerBodies: [],
    setStatus: vi.fn(),
    ...overrides
  };
}

beforeEach(() => {
  load.mockReset();
  save.mockReset();
  load.mockResolvedValue(null);
  save.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('measurement workbench persistence', () => {
  it('hydrates measurements and display options per project', async () => {
    const docA = createProjectDocument('Measure A', toUserId('user_measure_a'));
    const docB = createProjectDocument(
      'Measure B',
      toUserId('user_measure_b'),
      'cm'
    );
    const stored = measurement('measurement-1', false);
    load.mockImplementation((projectId: string) =>
      Promise.resolve(
        projectId === docA.projectId ? record(projectId, [stored]) : null
      )
    );

    const { result, rerender } = renderHook(
      (props: MeasurementWorkbenchInput) => useMeasurementWorkbench(props),
      { initialProps: input({ doc: docA, modelingLocked: true }) }
    );

    await waitFor(() => expect(result.current.measurements).toEqual([stored]));
    expect(result.current.measurementDisplay).toEqual({
      unit: 'inch',
      precision: 3,
      radialDisplay: 'radius'
    });

    rerender(input({ doc: docB, modelingLocked: true }));

    await waitFor(() =>
      expect(result.current.measurementHydratedProjectId).toBe(docB.projectId)
    );
    expect(result.current.measurements).toEqual([]);
    expect(result.current.measurementDisplay).toEqual({
      unit: 'cm',
      precision: 2,
      radialDisplay: 'diameter'
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, docA.projectId);
    expect(load).toHaveBeenNthCalledWith(2, docB.projectId);
  });

  it('holds writes back until the stored list has answered', async () => {
    vi.useFakeTimers();
    const doc = createProjectDocument('Measure C', toUserId('user_measure_c'));
    let settle: (value: StoredMeasurementRecord | null) => void = () => {};
    load.mockImplementation(
      () =>
        new Promise<StoredMeasurementRecord | null>((resolve) => {
          settle = resolve;
        })
    );

    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true }))
    );

    const pending = measurement('measurement-pending', false);
    act(() => result.current.setMeasurements([pending]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // An empty first render must never outrun a slow read and erase the record
    // it was still loading.
    expect(save).not.toHaveBeenCalled();

    // Settle and re-render first: the debounce is only armed by the effect that
    // runs once this project counts as hydrated.
    await act(async () => {
      settle(null);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      projectId: doc.projectId,
      version: 1,
      measurements: [pending],
      display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' }
    });
  });
});

describe('measurement picks', () => {
  it('leaves a pick alone when no measuring session is running', async () => {
    const doc = createProjectDocument('Measure D', toUserId('user_measure_d'));
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true, setStatus }))
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());

    expect(result.current.measuring).toBe(false);
    let consumed = true;
    act(() => {
      consumed = result.current.handleMeasurementPick(faceSelection, false);
    });
    expect(consumed).toBe(false);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('consumes a pick that lands before the measurement library does', async () => {
    const doc = createProjectDocument('Measure E', toUserId('user_measure_e'));
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true, setStatus }))
    );

    // No await between here and the pick: the deferred import has not had a
    // microtask to resolve in, which is the frame or two a fast picker can hit.
    act(() => result.current.setMeasuring(true));
    expect(result.current.measurementApi).toBeNull();
    let consumed = false;
    act(() => {
      consumed = result.current.handleMeasurementPick(faceSelection, false);
    });

    expect(consumed).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(
      'Measure is still loading. Try that pick again.'
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
  });
});

describe('measurement annotations', () => {
  it('reports no annotations without measurements or a draft', async () => {
    const doc = createProjectDocument('Measure F', toUserId('user_measure_f'));
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true }))
    );

    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    expect(result.current.measurements).toEqual([]);
    expect(result.current.measurementDraft).toBeNull();
    expect(result.current.measurementAnnotations).toEqual([]);
  });

  it('annotates a hydrated measurement under its own id', async () => {
    const doc = createProjectDocument('Measure G', toUserId('user_measure_g'));
    const stored = measurement('measurement-annotated', true);
    load.mockResolvedValue(record(doc.projectId, [stored]));

    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true }))
    );

    await waitFor(() =>
      expect(result.current.measurementAnnotations).toHaveLength(1)
    );
    expect(result.current.measurementAnnotations[0]!.id).toBe(
      'measurement-annotated'
    );
  });
});
