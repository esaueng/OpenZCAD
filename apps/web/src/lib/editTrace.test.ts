import {
  performance as nativePerformance,
  type PerformanceMeasure
} from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let trace: typeof import('./editTrace');
const phases = [
  'packed',
  'received',
  'progress',
  'geometry-ready',
  'analysis-ready',
  'installed',
  'frame'
] as const;

function measures(phase: (typeof phases)[number]): PerformanceMeasure[] {
  return nativePerformance.getEntriesByName(
    `oz:edit.${phase}`,
    'measure'
  ) as PerformanceMeasure[];
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('performance', nativePerformance);
  for (const phase of phases)
    nativePerformance.clearMeasures(`oz:edit.${phase}`);
  trace = await import('./editTrace');
});

afterEach(() => {
  for (const phase of phases)
    nativePerformance.clearMeasures(`oz:edit.${phase}`);
  vi.unstubAllGlobals();
});

describe('edit timing metadata', () => {
  it('does not read or clone project contents when the document is used as a revision', () => {
    const readNodes = vi.fn(() => {
      throw new Error('Timing must not inspect model contents');
    });
    const document = {
      projectId: 'trace-project',
      version: 1,
      get nodes() {
        return readNodes();
      }
    };
    trace.beginEditTrace(document);
    trace.recordEditPhase(document, 'packed');
    expect(readNodes).not.toHaveBeenCalled();
    expect(measures('packed').at(-1)?.detail).toEqual({
      projectId: document.projectId,
      version: document.version
    });
  });

  it('retains scalar projection metrics without retaining the worker packet', () => {
    const message = {
      type: 'projection-delta',
      projectId: 'trace-project',
      version: 2,
      packet: { changes: { body: { positions: new Float32Array(2048) } } }
    };
    trace.beginEditTrace(message);
    trace.recordEditPhase(message, 'received', {
      changedBodies: 1,
      transferredMeshBytes: 8192,
      publication: 'delta'
    });
    expect(measures('received').at(-1)?.detail).toEqual({
      projectId: message.projectId,
      version: message.version,
      changedBodies: 1,
      transferredMeshBytes: 8192,
      publication: 'delta'
    });
  });

  it('keeps bounded per-phase evidence and ignores revisions with no intent', () => {
    const revision = { projectId: 'trace-project', version: 3 };
    trace.recordEditPhase(revision, 'frame');
    expect(measures('frame')).toHaveLength(0);
    trace.beginEditTrace(revision);
    for (let index = 0; index < 65; index++) {
      trace.recordEditPhase(revision, 'frame', { analysis: 'ready' });
    }
    const entries = measures('frame');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toEqual({ ...revision, analysis: 'ready' });
    expect(entries[0]!.duration).toBeGreaterThanOrEqual(0);
  });
});
