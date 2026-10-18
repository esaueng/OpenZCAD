import type { FaceDragTraceEvent } from '../../apps/web/src/lib/faceDragTrace';

export interface Distribution {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  mean: number | null;
}

export interface FaceDragTraceSummary {
  pointerEvents: number;
  requests: number;
  replies: number;
  refusals: number;
  presentedFrames: number;
  /** First pointer value applied to the first frame showing exact geometry. */
  firstGeometryMs: number | null;
  /**
   * For every pointer event, the time until a frame presented geometry built
   * from that event or a later one. This is the user-visible lag.
   */
  pointerToPresentedMs: Distribution;
  /** Same, ignoring the first 300 ms of the drag. */
  steadyPointerToPresentedMs: Distribution;
  /** Rendered frame intervals while the pointer moved. */
  frameIntervalMs: Distribution;
  /** Main-thread time of each frame callback, and its WebGL submission. */
  frameWorkMs: Distribution;
  renderMs: Distribution;
  /** Exact geometry updates per second while the pointer moved. */
  geometryUpdatesPerSecond: number | null;
  stages: {
    buildMs: Distribution;
    sendMs: Distribution;
    queueMs: Distribution;
    kernelMs: Distribution;
    /** Round trip minus worker queue and kernel time: messaging and copies. */
    transportMs: Distribution;
    roundTripMs: Distribution;
    replyToPublishMs: Distribution;
    /** Publish to the end of viewer installation: React plus installation. */
    publishToInstalledMs: Distribution;
    installMs: Distribution;
    installedToFrameMs: Distribution;
  };
  /** Release to the first frame installed after it (validated commit). */
  releaseToFrameMs: number | null;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0)
    return { n: 0, p50: null, p95: null, max: null, mean: null };
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
  };
}

const sameValue = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9;

/**
 * Pairs stages of one face-drag trace (see `apps/web/src/lib/faceDragTrace.ts`)
 * into latencies. A preview is presented by the first `frame` marked
 * `presented` after the first changed `install` following its `publish`.
 */
export function summarizeFaceDragTrace(
  events: readonly FaceDragTraceEvent[],
  options: { releaseAt?: number } = {}
): FaceDragTraceSummary {
  const trace = [...events].sort((a, b) => a.t - b.t);
  const releaseAt = options.releaseAt ?? Number.POSITIVE_INFINITY;
  const during = trace.filter((event) => event.t <= releaseAt);
  const pointers = during.filter((event) => event.kind === 'pointer');
  const requests = during.filter((event) => event.kind === 'request');
  const replies = during.filter((event) => event.kind === 'reply');
  const installs = trace.filter(
    (event) => event.kind === 'install' && event.detail?.renderChanged === 1
  );
  const frames = trace.filter((event) => event.kind === 'frame');
  const presentedFrames = frames.filter(
    (event) => event.detail?.presented === 1
  );

  const replyToPublish: number[] = [];
  const publishToInstalled: number[] = [];
  const installMs: number[] = [];
  const installedToFrame: number[] = [];
  const presented: { value: number; publishAt: number; frameAt: number }[] =
    [];
  for (const publish of during.filter((event) => event.kind === 'publish')) {
    const reply = [...replies].reverse().find((event) => event.t <= publish.t);
    if (reply) replyToPublish.push(publish.t - reply.t);
    const install = installs.find((event) => event.t >= publish.t);
    if (!install) continue;
    const next = during.find(
      (event) => event.kind === 'publish' && event.t > publish.t
    );
    // A later publish installed in the same React commit owns that install.
    if (next && next.t <= install.t) continue;
    publishToInstalled.push(install.t - publish.t);
    installMs.push(install.ms ?? 0);
    const frame = presentedFrames.find((event) => event.t >= install.t);
    if (!frame) continue;
    installedToFrame.push(frame.t - install.t);
    presented.push({
      value: publish.value!,
      publishAt: publish.t,
      frameAt: frame.t
    });
  }

  // Each presented value covers every pointer event up to the one it was
  // requested from; later presented values cover the rest.
  const lag: { at: number; ms: number }[] = [];
  let covered = 0;
  for (const shown of presented) {
    const request = [...requests]
      .reverse()
      .find(
        (event) => event.t <= shown.publishAt && sameValue(event.value, shown.value)
      );
    if (!request) continue;
    let source = -1;
    for (let index = pointers.length - 1; index >= 0; index -= 1) {
      const pointer = pointers[index]!;
      if (pointer.t <= request.t && sameValue(pointer.value, shown.value)) {
        source = index;
        break;
      }
    }
    for (; covered <= source; covered += 1)
      lag.push({
        at: pointers[covered]!.t,
        ms: shown.frameAt - pointers[covered]!.t
      });
  }

  const dragStart = pointers[0]?.t;
  const dragEnd = pointers.at(-1)?.t;
  const dragFrames =
    dragStart === undefined
      ? []
      : frames.filter((event) => event.t >= dragStart && event.t <= dragEnd!);
  const intervals = dragFrames
    .slice(1)
    .map((event, index) => event.t - dragFrames[index]!.t);
  const presentedDuringDrag =
    dragStart === undefined
      ? 0
      : presented.filter(
          (shown) => shown.frameAt >= dragStart && shown.frameAt <= dragEnd!
        ).length;
  const durationS =
    dragStart === undefined ? 0 : (dragEnd! - dragStart) / 1000;

  const afterRelease = installs.find((event) => event.t > releaseAt);
  const releaseFrame = afterRelease
    ? presentedFrames.find((event) => event.t >= afterRelease.t)
    : undefined;

  const detail = (key: string) =>
    replies
      .map((event) => event.detail?.[key])
      .filter((value): value is number => value !== undefined);
  return {
    pointerEvents: pointers.length,
    requests: requests.length,
    replies: replies.length,
    refusals: during.filter((event) => event.kind === 'refusal').length,
    presentedFrames: presented.length,
    firstGeometryMs:
      presented[0] && dragStart !== undefined
        ? Math.round((presented[0].frameAt - dragStart) * 10) / 10
        : null,
    pointerToPresentedMs: distribution(lag.map((entry) => entry.ms)),
    steadyPointerToPresentedMs: distribution(
      lag
        .filter((entry) => dragStart !== undefined && entry.at - dragStart >= 300)
        .map((entry) => entry.ms)
    ),
    frameIntervalMs: distribution(intervals),
    frameWorkMs: distribution(dragFrames.map((event) => event.ms ?? 0)),
    renderMs: distribution(
      dragFrames.map((event) => event.detail?.renderMs ?? 0)
    ),
    geometryUpdatesPerSecond:
      durationS > 0 ? Math.round((presentedDuringDrag / durationS) * 10) / 10 : null,
    stages: {
      buildMs: distribution(requests.map((event) => event.ms ?? 0)),
      sendMs: distribution(detail('sendMs')),
      queueMs: distribution(detail('queueMs')),
      kernelMs: distribution(detail('kernelMs')),
      transportMs: distribution(
        replies
          .filter((event) => event.detail?.kernelMs !== undefined)
          .map(
            (event) =>
              (event.ms ?? 0) -
              (event.detail!.kernelMs ?? 0) -
              (event.detail!.queueMs ?? 0)
          )
      ),
      roundTripMs: distribution(replies.map((event) => event.ms ?? 0)),
      replyToPublishMs: distribution(replyToPublish),
      publishToInstalledMs: distribution(publishToInstalled),
      installMs: distribution(installMs),
      installedToFrameMs: distribution(installedToFrame)
    },
    releaseToFrameMs:
      releaseFrame && Number.isFinite(releaseAt)
        ? Math.round((releaseFrame.t - releaseAt) * 10) / 10
        : null
  };
}
