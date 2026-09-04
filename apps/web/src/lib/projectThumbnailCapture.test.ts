import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  toArtifactId,
  toProjectId,
  type BodyRepresentation
} from '@openzcad/shared';
import {
  createThumbnailCapture,
  type StagedThumbnail,
  type ThumbnailCaptureHost
} from './projectThumbnailCapture';

const PROJECT = toProjectId('proj_capture');
const BOX = { id: 'body_box' } as unknown as BodyRepresentation;

interface FakeHost extends ThumbnailCaptureHost {
  render: ReturnType<typeof vi.fn<ThumbnailCaptureHost['render']>>;
  load: ReturnType<typeof vi.fn<ThumbnailCaptureHost['load']>>;
  save: ReturnType<typeof vi.fn<ThumbnailCaptureHost['save']>>;
}

function host(overrides: Partial<FakeHost> = {}): FakeHost {
  return {
    render: vi.fn<ThumbnailCaptureHost['render']>((bodies) =>
      bodies.length === 0 ? null : `data:image/webp;base64,${bodies.length}`
    ),
    load: vi.fn<ThumbnailCaptureHost['load']>().mockResolvedValue(null),
    save: vi.fn<ThumbnailCaptureHost['save']>().mockResolvedValue(undefined),
    queue: (work) => Promise.resolve().then(work),
    ...overrides
  };
}

function staged(
  version: number,
  bodies: BodyRepresentation[] = [BOX]
): StagedThumbnail {
  return {
    projectId: PROJECT,
    version,
    updatedAt: `2026-09-04T21:00:0${version}.000Z`,
    bodies
  };
}

afterEach(() => vi.useRealTimers());

describe('createThumbnailCapture', () => {
  it('captures a staged part once the idle timer comes due', async () => {
    vi.useFakeTimers();
    const capture = createThumbnailCapture({ idleMs: 4000 });
    const captured = vi.fn();
    capture.subscribe(captured);
    const h = host();

    capture.stage(staged(3), h);
    await vi.advanceTimersByTimeAsync(3999);
    expect(h.render).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(h.render).toHaveBeenCalledWith([BOX]);
    expect(h.save).toHaveBeenCalledWith(PROJECT, {
      source: 'data:image/webp;base64,1',
      version: 3,
      updatedAt: '2026-09-04T21:00:03.000Z'
    });
    expect(captured).toHaveBeenCalledWith({
      projectId: PROJECT,
      version: 3,
      updatedAt: '2026-09-04T21:00:03.000Z',
      source: 'data:image/webp;base64,1'
    });
  });

  it('writes the record on flush without waiting for the timer', async () => {
    // The journey that used to lose the card: model, then leave within the
    // idle window. The record has to exist before flush resolves, because the
    // shelf that loads next reads it straight away.
    vi.useFakeTimers();
    const capture = createThumbnailCapture({ idleMs: 4000 });
    const h = host();

    capture.stage(staged(3), h);
    await capture.flush();

    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.save.mock.calls[0]?.[1]).toMatchObject({ version: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('replaces the empty-phase record with the modelled version', async () => {
    // A new project records "no geometry" for its first version; the box
    // added a moment later must overwrite it on the way out.
    vi.useFakeTimers();
    const capture = createThumbnailCapture({ idleMs: 4000 });
    const h = host();

    capture.stage(staged(1, []), h);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.save).toHaveBeenLastCalledWith(
      PROJECT,
      expect.objectContaining({ source: null, version: 1 })
    );

    capture.stage(staged(3), h);
    await vi.advanceTimersByTimeAsync(500);
    await capture.flush();

    expect(h.save).toHaveBeenLastCalledWith(
      PROJECT,
      expect.objectContaining({
        source: 'data:image/webp;base64,1',
        version: 3
      })
    );
  });

  it('does not render a version that is already on disk', async () => {
    const capture = createThumbnailCapture();
    const captured = vi.fn();
    capture.subscribe(captured);
    const h = host({
      load: vi.fn<ThumbnailCaptureHost['load']>().mockResolvedValue({
        projectId: PROJECT,
        source: 'data:image/webp;base64,OLD',
        artifactId: toArtifactId('artifact_old'),
        version: 3,
        updatedAt: '2026-09-04T21:00:03.000Z'
      })
    });

    capture.stage(staged(3), h);
    await capture.flush();

    expect(h.render).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, artifactId: 'artifact_old' })
    );
  });

  it('flushes with nothing staged, and with the staged version written', async () => {
    const capture = createThumbnailCapture();
    await expect(capture.flush()).resolves.toBeUndefined();
    const h = host();
    capture.stage(staged(2), h);
    await capture.flush();
    await capture.flush();
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('captures the newer version staged while a capture is in flight', async () => {
    const capture = createThumbnailCapture();
    let releaseSave: () => void = () => undefined;
    const h = host({
      save: vi
        .fn<ThumbnailCaptureHost['save']>()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              releaseSave = resolve;
            })
        )
        .mockResolvedValue(undefined)
    });

    capture.stage(staged(2), h);
    const first = capture.flush();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    capture.stage(staged(4, [BOX, BOX]), h);
    releaseSave();
    await first;

    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1]?.[1]).toMatchObject({
      source: 'data:image/webp;base64,2',
      version: 4
    });
  });

  it('keeps the existing record when the render fails, and retries on the next flush', async () => {
    const capture = createThumbnailCapture();
    const h = host({
      render: vi
        .fn<ThumbnailCaptureHost['render']>()
        .mockImplementationOnce(() => {
          throw new Error('no webgl context');
        })
        .mockReturnValue('data:image/webp;base64,OK')
    });

    capture.stage(staged(3), h);
    await capture.flush();
    expect(h.save).not.toHaveBeenCalled();

    await capture.flush();
    expect(h.save).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ source: 'data:image/webp;base64,OK' })
    );
  });

  it('forgets a discarded entry so a later flush cannot resurrect it', async () => {
    vi.useFakeTimers();
    const capture = createThumbnailCapture({ idleMs: 4000 });
    const h = host();

    capture.stage(staged(3), h);
    capture.discard();
    await vi.advanceTimersByTimeAsync(10_000);
    await capture.flush();

    expect(h.render).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});
