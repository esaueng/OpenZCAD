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
  it('reports proxy frames separately from exact geometry and the accepted commit', () => {
    const summary = summarizeFaceDragTrace(
      [at(0, 'pointer', { value: 1 }), at(8, 'frame')],
      {
        releaseAt: 10,
        committedFrameAt: 25,
        proxyFrameLatenciesMs: [8, 9, NaN, -1]
      }
    );
    expect(summary.proxyPresentedFrames).toBe(2);
    expect(summary.pointerToProxyFrameMs.max).toBe(9);
    expect(summary.presentedFrames).toBe(0);
    expect(summary.pointerToPresentedMs.n).toBe(0);
    expect(summary.releaseToFrameMs).toBe(15);
  });

  it('uses the accepted ready frame when a commit reuses its exact preview', () => {
    const trace = [
      at(10, 'install', { detail: { renderChanged: 1 } }),
      at(12, 'frame', { detail: { presented: 1 } }),
      at(25, 'install', { detail: { renderChanged: 0 } }),
      at(30, 'frame')
    ];
    expect(
      summarizeFaceDragTrace(trace, { releaseAt: 20 }).releaseToFrameMs
    ).toBeNull();
    expect(
      summarizeFaceDragTrace(trace, { releaseAt: 20, committedFrameAt: 30 })
        .releaseToFrameMs
    ).toBe(10);
    // A later unrelated geometry installation must not replace that witness.
    trace.push(
      at(40, 'install', { detail: { renderChanged: 1 } }),
      at(50, 'frame', { detail: { presented: 1 } })
    );
    expect(
      summarizeFaceDragTrace(trace, { releaseAt: 20, committedFrameAt: 30 })
        .releaseToFrameMs
    ).toBe(10);
  });

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

describe('face-drag trace summary, cached republishes', () => {
  it('times a cached republish from the move that returned to it, without a reply', () => {
    const summary = summarizeFaceDragTrace([
      at(0, 'pointer', { value: 1 }),
      at(1, 'request', { value: 1 }),
      at(30, 'reply', { ms: 29, detail: { kernelMs: 25 } }),
      at(31, 'publish', { value: 1, detail: { cached: 0 } }),
      at(40, 'install', { detail: { renderChanged: 1 } }),
      at(45, 'frame', { detail: { presented: 1 } }),
      at(50, 'pointer', { value: 2 }),
      at(51, 'request', { value: 2 }),
      at(200, 'pointer', { value: 1 }),
      at(201, 'publish', { value: 1, detail: { cached: 1 } }),
      at(210, 'install', { detail: { renderChanged: 1 } }),
      at(220, 'frame', { detail: { presented: 1 } })
    ]);
    // Only the built frame has a reply to measure from.
    expect(summary.stages.replyToPublishMs).toMatchObject({ n: 1, max: 1 });
    expect(summary.presentedFrames).toBe(2);
    // Pointer 1 → 45; pointers 2 and 3 are caught up by the republish at 220.
    expect(summary.pointerToPresentedMs).toMatchObject({ n: 3, max: 170 });
  });
});
