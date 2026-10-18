import { describe, expect, it } from 'vitest';
import type { FaceDragTraceEvent } from '../apps/web/src/lib/faceDragTrace';
import {
  distribution,
  summarizeFaceDragTrace
} from './support/faceDragTraceSummary';

const at = (
  t: number,
  kind: FaceDragTraceEvent['kind'],
  fields: Omit<FaceDragTraceEvent, 'kind' | 't'> = {}
): FaceDragTraceEvent => ({ t, kind, ...fields });

describe('face-drag trace summary', () => {
  it('measures each pointer event to the frame that first shows it or a later value', () => {
    const summary = summarizeFaceDragTrace(
      [
        at(0, 'pointer', { value: 1 }),
        at(1, 'request', { value: 1, ms: 0.5 }),
        at(16, 'pointer', { value: 2 }),
        at(32, 'pointer', { value: 3 }),
        at(40, 'reply', { ms: 39, detail: { queueMs: 1, kernelMs: 30 } }),
        at(41, 'publish', { value: 1 }),
        at(41.5, 'request', { value: 3, ms: 0.5 }),
        at(50, 'install', { ms: 4, detail: { renderChanged: 1 } }),
        at(60, 'frame', { ms: 3, detail: { presented: 1 } }),
        at(80, 'reply', { ms: 38.5, detail: { queueMs: 0, kernelMs: 30 } }),
        at(81, 'publish', { value: 3 }),
        at(90, 'install', { ms: 5, detail: { renderChanged: 1 } }),
        at(100, 'frame', { ms: 3, detail: { presented: 1 } }),
        at(150, 'install', { ms: 9, detail: { renderChanged: 1 } }),
        at(160, 'frame', { ms: 3, detail: { presented: 1 } })
      ],
      { releaseAt: 120 }
    );
    expect(summary.presentedFrames).toBe(2);
    expect(summary.firstGeometryMs).toBe(60);
    // Pointer 1 shows at 60; pointers 2 and 3 are caught up by value 3 at 100.
    expect(summary.pointerToPresentedMs).toMatchObject({
      n: 3,
      p50: 68,
      max: 84
    });
    expect(summary.stages.kernelMs.p50).toBe(30);
    expect(summary.stages.transportMs.max).toBe(8.5);
    expect(summary.stages.publishToInstalledMs).toMatchObject({ n: 2, max: 9 });
    expect(summary.stages.installedToFrameMs).toMatchObject({ n: 2, max: 10 });
    expect(summary.releaseToFrameMs).toBe(40);
  });

  it('gives a refused or stale value no presented frame', () => {
    const summary = summarizeFaceDragTrace([
      at(0, 'pointer', { value: 1 }),
      at(1, 'request', { value: 1 }),
      at(30, 'reply', { ms: 29, detail: { ok: 0 } }),
      at(30, 'refusal', { value: 1, message: 'invalid' }),
      at(40, 'frame', { detail: { presented: 0 } })
    ]);
    expect(summary.refusals).toBe(1);
    expect(summary.presentedFrames).toBe(0);
    expect(summary.pointerToPresentedMs.n).toBe(0);
  });

  it('reports nearest-rank percentiles', () => {
    expect(distribution([5, 1, 4, 2, 3])).toEqual({
      n: 5,
      p50: 3,
      p95: 5,
      max: 5,
      mean: 3
    });
    expect(distribution([]).p95).toBeNull();
  });
});
