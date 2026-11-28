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
import {
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type TopologySelection
} from '@openzcad/shared';
import {
  loadProjectMeasurements,
  saveProjectMeasurements
} from '../lib/localProjectStore';
import type { Measurement, MeasurementTarget } from '../lib/measurements';
import type { StoredMeasurementRecord } from '../lib/measurementRecord';
import { downloadText } from '../lib/model';
import type * as ModelModule from '../lib/model';
import {
  useMeasurementWorkbench,
  type MeasurementWorkbenchInput
} from './useMeasurementWorkbench';

vi.mock('../lib/localProjectStore', () => ({
  loadProjectMeasurements: vi.fn(),
  saveProjectMeasurements: vi.fn()
}));

vi.mock('../lib/model', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelModule>()),
  downloadText: vi.fn()
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
  vi.restoreAllMocks();
  vi.mocked(downloadText).mockClear();
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

  it('preserves a hydrated timestamp until measurement content changes', async () => {
    vi.useFakeTimers();
    const doc = createProjectDocument(
      'Measure timestamp',
      toUserId('user_measure_timestamp')
    );
    const stored = record(doc.projectId, [
      measurement('measurement-stored', false)
    ]);
    load.mockResolvedValue(stored);

    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true }))
    );

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.measurementHydratedProjectId).toBe(doc.projectId);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).not.toHaveBeenCalled();

    const remoteMeasurement = measurement('measurement-cloud', false);
    act(() => {
      result.current.applyStoredMeasurements([remoteMeasurement]);
      result.current.setMeasurementUnit('cm');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).not.toHaveBeenCalled();

    const changed = { ...remoteMeasurement, note: 'edited note' };
    act(() => result.current.setMeasurements([changed]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      projectId: doc.projectId,
      measurements: [changed]
    });
    expect(save.mock.calls[0]![0].updatedAt).not.toBe(stored.updatedAt);
  });
});

describe('measurement picks', () => {
  it('rejects stale body measurements until staged analysis arrives', async () => {
    const doc = createProjectDocument(
      'Staged measure',
      toUserId('user_measure')
    );
    const body: BodyRepresentation = {
      bodyId: toBodyId('body-1'),
      name: 'Box',
      source: 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: new Float32Array(),
        indices: new Uint32Array()
      },
      faceCount: 0,
      color: '#fff',
      exportableStep: true,
      consumed: false,
      volume: 12,
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 3 } }
    };
    const selection: TopologySelection = {
      bodyId: body.bodyId,
      kind: 'body'
    };
    const setStatus = vi.fn();
    const pendingInput = input({
      doc,
      modelingLocked: true,
      geometryPending: true,
      representations: { 'body-1': body },
      renderedRepresentations: { 'body-1': body },
      viewerBodies: [body],
      setStatus
    });
    const { result, rerender } = renderHook(
      (props: MeasurementWorkbenchInput) => useMeasurementWorkbench(props),
      { initialProps: pendingInput }
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    expect(result.current.previewMeasurement(selection)).toBeNull();
    act(() => {
      expect(result.current.handleMeasurementPick(selection, false)).toBe(true);
    });
    expect(result.current.measurements).toEqual([]);
    expect(result.current.measurementSession.first).toBeNull();
    expect(setStatus).toHaveBeenCalledWith(
      'Measurements are unavailable while the model finishes updating.'
    );

    const completedBody = {
      ...body,
      volume: 24,
      bbox: { ...body.bbox, max: { x: 4, y: 2, z: 3 } }
    };
    rerender({
      ...pendingInput,
      geometryPending: false,
      exactGeometryReady: true,
      representations: { 'body-1': completedBody },
      renderedRepresentations: { 'body-1': completedBody },
      viewerBodies: [completedBody]
    });
    expect(result.current.previewMeasurement(selection)).not.toBeNull();
    act(() => {
      result.current.handleMeasurementPick(selection, false);
    });
    // A pick reads live; only Keep records it.
    expect(result.current.measurements).toEqual([]);
    expect(result.current.measurementSession.primary?.kind).toBe('single');
    act(() => {
      expect(result.current.keepMeasurementReading()).toBe(true);
    });
    expect(result.current.measurementSession.first).toBeNull();
    expect(result.current.measurements).toHaveLength(1);
    expect(result.current.measurements[0]!.result).toEqual({
      value: 24,
      dimension: 'volume',
      components: { x: 4, y: 2, z: 3 }
    });
    expect(result.current.measurements[0]!.sourceRevision).toBe(doc.version);
    // Recorded and drawn, it is not previewed again beside its own chip
    // (I54: two identical "80.00 mm" chips).
    expect(result.current.previewMeasurement(selection)).toBeNull();
  });

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

describe('measurements across a stored-unit conversion', () => {
  // An unnamed planar face (a Boolean's split face publishes no lineage),
  // so only its ADR-011 hash names it, and the conversion changes that.
  const plate = (scale: number, hash: number): BodyRepresentation => ({
    bodyId: toBodyId('body-1'),
    name: 'Union',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: new Float32Array(),
      indices: new Uint32Array()
    },
    faceCount: 1,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 48 * scale ** 3,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 4 * scale, y: 6 * scale, z: 2 * scale }
    },
    topology: {
      faces: [
        {
          topologyId: `face:${hash}`,
          hash,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: 24 * scale ** 2,
            center: { x: 2 * scale, y: 3 * scale, z: 2 * scale },
            centroid: { x: 2 * scale, y: 3 * scale, z: 2 * scale },
            centroidProvenance: 'exact',
            normal: { x: 0, y: 0, z: 1 }
          }
        }
      ],
      edges: []
    }
  });

  it('carries an unnamed face from the bodies it was measured on (#2361)', async () => {
    const doc = createProjectDocument('Converted', toUserId('user_measure'));
    const mm = plate(1, 21);
    const { createSmartMeasurement } = await import('../lib/measurements');
    const stored = createSmartMeasurement(
      mm,
      { bodyId: mm.bodyId, kind: 'face', topologyId: 'face:21', hash: 21 },
      { x: 2, y: 3, z: 2 },
      doc.version,
      'mm'
    )!;
    expect(stored.kind).toBe('face-area');
    load.mockResolvedValue(record(doc.projectId, [stored]));
    const initialProps = input({
      doc,
      modelingLocked: true,
      exactGeometryReady: true,
      representations: { 'body-1': mm },
      renderedRepresentations: { 'body-1': mm },
      viewerBodies: [mm]
    });
    const { result, rerender } = renderHook(
      (props: MeasurementWorkbenchInput) => useMeasurementWorkbench(props),
      { initialProps }
    );
    await waitFor(() =>
      expect(result.current.measurements[0]?.status).toBe('current')
    );

    // Converted to inches: one new revision, the same face scaled, new hash.
    const inch = plate(1 / 25.4, 921);
    rerender({
      ...initialProps,
      doc: { ...doc, units: 'inch', version: doc.version + 1 },
      representations: { 'body-1': inch },
      renderedRepresentations: { 'body-1': inch },
      viewerBodies: [inch]
    });
    await waitFor(() =>
      expect(result.current.measurements[0]).toMatchObject({
        status: 'current',
        sourceUnit: 'inch',
        sourceRevision: doc.version + 1
      })
    );
    const [row] = result.current.measurements;
    expect(row!.targets[0]!.hash).toBe(921);
    expect(row!.result.value).toBeCloseTo(24 / 25.4 ** 2, 12);
  });

  it('still carries it when the stored list lands after the conversion (#2433)', async () => {
    const doc = createProjectDocument('Converted', toUserId('user_measure'));
    const mm = plate(1, 21);
    const { createSmartMeasurement } = await import('../lib/measurements');
    const stored = createSmartMeasurement(
      mm,
      { bodyId: mm.bodyId, kind: 'face', topologyId: 'face:21', hash: 21 },
      { x: 2, y: 3, z: 2 },
      doc.version,
      'mm'
    )!;
    // The device's list is still loading through the conversion.
    let restore!: (value: StoredMeasurementRecord | null) => void;
    load.mockReturnValue(
      new Promise<StoredMeasurementRecord | null>((resolve) => {
        restore = resolve;
      })
    );
    const initialProps = input({
      doc,
      modelingLocked: true,
      exactGeometryReady: true,
      representations: { 'body-1': mm },
      renderedRepresentations: { 'body-1': mm },
      viewerBodies: [mm]
    });
    const { result, rerender } = renderHook(
      (props: MeasurementWorkbenchInput) => useMeasurementWorkbench(props),
      { initialProps }
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    const inch = plate(1 / 25.4, 921);
    const converted = {
      ...initialProps,
      doc: { ...doc, units: 'inch' as const, version: doc.version + 1 },
      representations: { 'body-1': inch },
      renderedRepresentations: { 'body-1': inch },
      viewerBodies: [inch]
    };
    rerender(converted);
    // Another inch arrival (a re-render of the same build) before the list.
    rerender({ ...converted, representations: { 'body-1': { ...inch } } });
    await act(async () => {
      restore(record(doc.projectId, [stored]));
    });
    await waitFor(() =>
      expect(result.current.measurements[0]).toMatchObject({
        status: 'current',
        sourceUnit: 'inch'
      })
    );
    const [row] = result.current.measurements;
    expect(row!.targets[0]!.hash).toBe(921);
    expect(row!.result.value).toBeCloseTo(24 / 25.4 ** 2, 12);
  });
});

describe('measurement annotations', () => {
  it('suspends saved measurements during staged edits without persisting transient state', async () => {
    const doc = createProjectDocument(
      'Saved measure',
      toUserId('user_measure')
    );
    const body: BodyRepresentation = {
      bodyId: toBodyId('body-1'),
      name: 'Box',
      source: 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: new Float32Array(),
        indices: new Uint32Array()
      },
      faceCount: 0,
      color: '#fff',
      exportableStep: true,
      consumed: false,
      volume: 12,
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 3 } }
    };
    const { createSmartMeasurement } = await import('../lib/measurements');
    const stored = createSmartMeasurement(
      body,
      { bodyId: body.bodyId, kind: 'body' },
      undefined,
      doc.version,
      doc.units
    )!;
    load.mockResolvedValue(record(doc.projectId, [stored]));
    const clipboard = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue();
    const initialProps = input({
      doc,
      modelingLocked: true,
      exactGeometryReady: true,
      representations: { 'body-1': body },
      renderedRepresentations: { 'body-1': body },
      viewerBodies: [body]
    });
    const { result, rerender } = renderHook(
      (props: MeasurementWorkbenchInput) => useMeasurementWorkbench(props),
      { initialProps }
    );
    await waitFor(() =>
      expect(result.current.measurementAnnotations).toHaveLength(1)
    );
    const saved = result.current.measurements;
    rerender({
      ...initialProps,
      doc: { ...doc, version: doc.version + 1 },
      geometryPending: true,
      exactGeometryReady: false
    });
    expect(result.current.measurementAnnotations).toEqual([]);
    await act(async () => {
      await result.current.copyMeasurements();
      await result.current.copyMeasurements(saved[0]);
      result.current.exportMeasurements();
    });
    expect(clipboard).not.toHaveBeenCalled();
    expect(downloadText).not.toHaveBeenCalled();
    expect(result.current.measurements).toBe(saved);
    expect(result.current.measurements[0]).toMatchObject({
      status: 'current',
      sourceRevision: doc.version,
      result: { value: 12 }
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    for (const [persisted] of save.mock.calls) {
      expect(persisted.measurements[0]).toMatchObject({
        status: 'current',
        sourceRevision: doc.version,
        result: { value: 12 }
      });
    }

    const completedBody = {
      ...body,
      volume: 24,
      bbox: { ...body.bbox, max: { x: 4, y: 2, z: 3 } }
    };
    rerender({
      ...initialProps,
      doc: { ...doc, version: doc.version + 1 },
      representations: { 'body-1': completedBody },
      renderedRepresentations: { 'body-1': completedBody },
      viewerBodies: [completedBody]
    });
    await waitFor(() =>
      expect(result.current.measurements[0]).toMatchObject({
        status: 'current',
        sourceRevision: doc.version + 1,
        result: { value: 24 }
      })
    );
    expect(result.current.measurementAnnotations[0]!.anchor).toEqual({
      x: 2,
      y: 1,
      z: 1.5
    });
    await act(async () => {
      await result.current.copyMeasurements();
      result.current.exportMeasurements();
    });
    expect(clipboard).toHaveBeenCalledOnce();
    expect(downloadText).toHaveBeenCalledOnce();
  });

  it('reports no annotations without measurements or a draft', async () => {
    const doc = createProjectDocument('Measure F', toUserId('user_measure_f'));
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc, modelingLocked: true }))
    );

    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    expect(result.current.measurements).toEqual([]);
    expect(result.current.measurementSession.first).toBeNull();
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

  it('places an area label against the face on screen, not the committed one', async () => {
    // A parameter preview hands the viewport other bodies than the committed
    // ones. The label's face box must come from what is drawn — here the top
    // face previewed up from z = 30 to z = 45 — or label and leader would
    // stand beside the face as it was before the edit.
    const doc = createProjectDocument('Measure H', toUserId('user_measure_h'));
    const bodyAt = (z: number): BodyRepresentation => ({
      bodyId: toBodyId('body-1'),
      name: 'Box',
      source: 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: Float32Array.from([0, 0, z, 10, 0, z, 10, 20, z]),
        indices: Uint32Array.from([0, 1, 2])
      },
      faceCount: 1,
      color: '#fff',
      exportableStep: true,
      consumed: false,
      volume: 1,
      bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z } },
      topology: {
        edges: [],
        faces: [
          {
            topologyId: 'face-1',
            hash: 1,
            triangleStart: 0,
            triangleCount: 1,
            geometry: {
              surfaceType: 'plane',
              area: 200,
              center: { x: 5, y: 10, z }
            }
          }
        ]
      }
    });
    const area: Measurement = {
      ...measurement('measurement-area', true),
      kind: 'face-area',
      label: 'Top face',
      targets: [
        {
          ...target,
          kind: 'face',
          topologyId: 'face-1',
          semantic: 'face-center'
        }
      ],
      result: { value: 200, dimension: 'area' }
    };
    load.mockResolvedValue(record(doc.projectId, [area]));

    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': bodyAt(30) },
          renderedRepresentations: { 'body-1': bodyAt(45) },
          viewerBodies: [bodyAt(45)]
        })
      )
    );

    await waitFor(() =>
      expect(result.current.measurementAnnotations).toHaveLength(1)
    );
    expect(result.current.measurementAnnotations[0]!.extent).toMatchObject({
      bodyId: 'body-1',
      min: { z: 45 },
      max: { z: 45 }
    });
  });

  it('names a face pick the way the dock does and draws its live reading', async () => {
    // A planar face picked for Distance carries the internal semantic "pick";
    // the canvas once read "A · pick" while the dock named the face.
    const doc = createProjectDocument('Measure I', toUserId('user_measure_i'));
    const body = twoFaceBody();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body]
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    act(() => {
      result.current.handleMeasurementPick(faceSelection, false, {
        point: { x: 2, y: 3, z: 5 }
      });
    });

    const session = result.current.measurementSession;
    expect(session.first?.label).toBeTruthy();
    expect(session.first?.label).not.toContain('pick');
    expect(session.second).toBeNull();
    expect(session.primary?.kind).toBe('single');
    expect(session.primary?.measurement.kind).toBe('face-area');
    const live = result.current.measurementAnnotations.find(
      (annotation) => annotation.id === 'measurement-draft'
    );
    expect(live?.selected).toBe(true);
    expect(live?.label).toBe(session.primary?.formatted.value);
  });

  it('reads two picks every way they relate, and keeps the chosen reading', async () => {
    const doc = createProjectDocument('Measure J', toUserId('user_measure_j'));
    const body = twoFaceBody();
    const setStatus = vi.fn();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body],
          setStatus
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    act(() => {
      result.current.handleMeasurementPick(faceSelection, false, {
        point: { x: 2, y: 3, z: 5 }
      });
    });
    // Picking the same spot again does not compare it with itself.
    act(() => {
      result.current.handleMeasurementPick(faceSelection, false, {
        point: { x: 2, y: 3, z: 5 }
      });
    });
    expect(result.current.measurementSession.second).toBeNull();

    act(() => {
      result.current.handleMeasurementPick(bottomSelection, false, {
        point: { x: 2, y: 3, z: 0 }
      });
    });
    const session = result.current.measurementSession;
    expect(session.second).not.toBeNull();
    const kinds = session.readings.map((reading) => reading.kind);
    // Two parallel faces read as the gap between them first.
    expect(session.primary?.kind).toBe('parallel');
    expect(session.primary?.measurement.result.value).toBeCloseTo(5);
    // The centroids' distance equals the gap, so it is listed once, as the
    // gap.
    expect(kinds).toEqual(['parallel', 'angle']);
    expect(kinds).not.toContain('single');
    // Every figure is listed once.
    const values = session.readings.map(
      (reading) =>
        `${reading.measurement.result.dimension}:${reading.measurement.result.value}`
    );
    expect(new Set(values).size).toBe(values.length);
    // Nothing is recorded until it is kept.
    expect(result.current.measurements).toEqual([]);

    act(() => result.current.chooseMeasurementReading('angle'));
    expect(result.current.measurementSession.primary?.kind).toBe('angle');
    act(() => {
      expect(result.current.keepMeasurementReading()).toBe(true);
    });
    expect(result.current.measurements).toHaveLength(1);
    expect(result.current.measurements[0]!.kind).toBe('angle');
    expect(result.current.measurementSession.first).toBeNull();
    // With nothing picked, Enter is left to whoever else wants it.
    act(() => {
      expect(result.current.keepMeasurementReading()).toBe(false);
    });
  });

  it('compares two points of one face, but not one point with itself', async () => {
    const doc = createProjectDocument('Measure L', toUserId('user_measure_l'));
    const body = twoFaceBody();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body]
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    const pickAt = (x: number) =>
      act(() => {
        result.current.handleMeasurementPick(faceSelection, false, {
          point: { x, y: 3, z: 5 }
        });
      });
    pickAt(2);
    pickAt(2);
    expect(result.current.measurementSession.second).toBeNull();
    pickAt(8);
    const session = result.current.measurementSession;
    expect(session.second).not.toBeNull();
    expect(session.primary?.kind).toBe('distance');
    expect(session.primary?.measurement.result.value).toBeCloseTo(6);
  });

  it('reads named points as a distance first, even where it equals the gap (M13)', async () => {
    const doc = createProjectDocument('Measure M', toUserId('user_measure_m'));
    const body = twoFaceBody();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body]
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => {
      result.current.setMeasuring(true);
      result.current.setMeasurementPointKind('centroid');
    });
    // Points straight above one another: their distance equals the gap.
    for (const [selection, z] of [
      [faceSelection, 5],
      [bottomSelection, 0]
    ] as const) {
      act(() => {
        result.current.handleMeasurementPick(selection, false, {
          point: { x: 5, y: 10, z }
        });
      });
    }
    const session = result.current.measurementSession;
    expect(session.primary?.kind).toBe('distance');
    expect(session.readings.map((reading) => reading.kind)).not.toContain(
      'parallel'
    );
  });

  it('starts over on the body when a double-click picks it after its face', async () => {
    const doc = createProjectDocument('Measure N', toUserId('user_measure_n'));
    const body = twoFaceBody();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body]
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    act(() => {
      result.current.handleMeasurementPick(faceSelection, false, {
        point: { x: 2, y: 3, z: 5 }
      });
    });
    act(() => {
      result.current.handleMeasurementPick(
        { bodyId: body.bodyId, kind: 'body' },
        false,
        { point: { x: 2, y: 3, z: 5 } }
      );
    });
    const session = result.current.measurementSession;
    expect(session.second).toBeNull();
    expect(session.primary?.measurement.kind).toBe('body');
    expect(session.primary?.title).toBe('Size');
  });

  it('starts over on a third pick', async () => {
    const doc = createProjectDocument('Measure K', toUserId('user_measure_k'));
    const body = twoFaceBody();
    const { result } = renderHook(() =>
      useMeasurementWorkbench(
        input({
          doc,
          modelingLocked: true,
          representations: { 'body-1': body },
          renderedRepresentations: { 'body-1': body },
          viewerBodies: [body]
        })
      )
    );
    await waitFor(() => expect(result.current.measurementApi).not.toBeNull());
    act(() => result.current.setMeasuring(true));
    for (const [selection, z] of [
      [faceSelection, 5],
      [bottomSelection, 0],
      [bottomSelection, 0]
    ] as const) {
      act(() => {
        result.current.handleMeasurementPick(selection, false, {
          point: { x: 1, y: 1, z }
        });
      });
    }
    expect(result.current.measurementSession.first).not.toBeNull();
    expect(result.current.measurementSession.second).toBeNull();
    expect(result.current.measurementSession.primary?.kind).toBe('single');
  });
});

const bottomSelection: TopologySelection = {
  bodyId: toBodyId('body-1'),
  kind: 'face',
  topologyId: 'face-2'
};

/** A slab's top and bottom faces: planar, parallel, 5 apart. */
function twoFaceBody(): BodyRepresentation {
  return {
    bodyId: toBodyId('body-1'),
    name: 'Box',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([
        0, 0, 5, 10, 0, 5, 10, 20, 5, 0, 0, 0, 10, 20, 0, 10, 0, 0
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5])
    },
    faceCount: 2,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 5 } },
    topology: {
      edges: [],
      faces: [
        {
          topologyId: 'face-1',
          hash: 1,
          triangleStart: 0,
          triangleCount: 1,
          geometry: {
            surfaceType: 'plane',
            area: 200,
            center: { x: 5, y: 10, z: 5 },
            centroid: { x: 5, y: 10, z: 5 },
            normal: { x: 0, y: 0, z: 1 }
          }
        },
        {
          topologyId: 'face-2',
          hash: 2,
          triangleStart: 1,
          triangleCount: 1,
          geometry: {
            surfaceType: 'plane',
            area: 200,
            center: { x: 5, y: 10, z: 0 },
            centroid: { x: 5, y: 10, z: 0 },
            normal: { x: 0, y: 0, z: -1 }
          }
        }
      ]
    }
  };
}

describe('flushing the measurement write', () => {
  it('writes a reading kept a moment ago before the debounce fires (#2433)', async () => {
    const doc = createProjectDocument('Flushed', toUserId('user_measure'));
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc }))
    );
    await waitFor(() =>
      expect(result.current.measurementHydratedProjectId).toBe(doc.projectId)
    );
    act(() => {
      result.current.setMeasurements([measurement('kept', false)]);
    });
    expect(save).not.toHaveBeenCalled();
    await act(() => result.current.flushMeasurementPersistence(doc.projectId));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toMatchObject({
      projectId: doc.projectId,
      measurements: [expect.objectContaining({ id: 'kept' })]
    });
    // The debounced timer that would have written it is gone.
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('waits for a write already in flight', async () => {
    const doc = createProjectDocument('In flight', toUserId('user_measure'));
    let settle!: () => void;
    save.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );
    const { result } = renderHook(() =>
      useMeasurementWorkbench(input({ doc }))
    );
    await waitFor(() =>
      expect(result.current.measurementHydratedProjectId).toBe(doc.projectId)
    );
    act(() => {
      result.current.setMeasurements([measurement('kept', false)]);
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), {
      timeout: 2000
    });
    let flushed = false;
    const flush = result.current
      .flushMeasurementPersistence(doc.projectId)
      .then(() => {
        flushed = true;
      });
    await Promise.resolve();
    expect(flushed).toBe(false);
    settle();
    await flush;
    expect(flushed).toBe(true);
  });
});
