import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toArtifactId, type ProjectSummary } from '@openzcad/shared';
import { PartThumbnail } from './PartThumbnail';

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: `project_${Math.random().toString(36).slice(2)}`,
    name: 'Bright Penguin',
    updatedAt: '2026-08-06T19:22:15.000Z',
    ...overrides
  } as ProjectSummary;
}

describe('PartThumbnail', () => {
  it('renders the cached image without asking for anything else', async () => {
    const project = summary({
      thumbnailArtifactId: toArtifactId('artifact_cached')
    });
    const loadThumbnail = vi.fn().mockResolvedValue('data:image/webp;base64,AA');
    const publishThumbnail = vi.fn();

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,AA');
    expect(loadThumbnail).toHaveBeenCalledTimes(1);
    expect(loadThumbnail).toHaveBeenCalledWith(project);
    expect(publishThumbnail).not.toHaveBeenCalled();
  });

  it('publishes a device-only cached image in the background', async () => {
    const project = summary();
    const loadThumbnail = vi.fn().mockResolvedValue('data:image/webp;base64,AA');
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    expect(
      await screen.findByRole('presentation', { hidden: true })
    ).toHaveAttribute('src', 'data:image/webp;base64,AA');
    await waitFor(() =>
      expect(publishThumbnail).toHaveBeenCalledWith(project)
    );
  });

  it('renders a preview the cold cache had to produce', async () => {
    // The shelf that matters: every project predates the cache, so a tile with
    // no cached image has to be able to ask for one or it never gets a picture.
    const project = summary();
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi
      .fn()
      .mockResolvedValue('data:image/webp;base64,BB');

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,BB');
    expect(publishThumbnail).toHaveBeenCalledWith(project);
  });

  it('falls back to the placeholder when there is nothing to render from', async () => {
    // The case that keeps a project too large to open reachable: nothing this
    // device holds, and no attempt to fetch it, so the shelf still paints.
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('No geometry')).toBeNull();
  });

  it('reports a genuinely empty part differently from a missing preview', async () => {
    const loadThumbnail = vi.fn().mockResolvedValue(null);
    const publishThumbnail = vi.fn();

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    expect(await screen.findByText('No geometry')).toBeVisible();
    // A cached "empty" is an answer, not a miss — re-deriving it every visit
    // would defeat the cache for exactly the parts that render to nothing.
    expect(publishThumbnail).not.toHaveBeenCalled();
  });

  it('survives a rejected read without throwing', async () => {
    const loadThumbnail = vi.fn().mockRejectedValue(new Error('idb closed'));
    const publishThumbnail = vi.fn();

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(loadThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('survives a rejected backfill without throwing', async () => {
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi
      .fn()
      .mockRejectedValue(new Error('no webgl context'));

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('retries a miss when the same project listing gains a cloud artifact', async () => {
    const project = summary();
    const loadThumbnail = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('data:image/webp;base64,CC');
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );
    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledTimes(1));

    rerender(
      <PartThumbnail
        project={{
          ...project,
          thumbnailArtifactId: toArtifactId('artifact_thumbnail')
        }}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,CC');
    expect(loadThumbnail).toHaveBeenCalledTimes(2);
  });
});
