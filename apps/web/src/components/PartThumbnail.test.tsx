import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@openzcad/shared';
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
    const project = summary();
    const loadThumbnail = vi.fn().mockResolvedValue('data:image/webp;base64,AA');

    render(<PartThumbnail project={project} loadThumbnail={loadThumbnail} />);

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,AA');
    expect(loadThumbnail).toHaveBeenCalledTimes(1);
    expect(loadThumbnail).toHaveBeenCalledWith(project);
  });

  it('falls back to the placeholder when this device has no preview', async () => {
    // The case that matters for a project too large to open: no cached image,
    // and crucially no attempt to produce one, so the shelf stays reachable.
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);

    render(
      <PartThumbnail project={summary()} loadThumbnail={loadThumbnail} />
    );

    await waitFor(() => expect(loadThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('No geometry')).toBeNull();
  });

  it('reports a genuinely empty part differently from a missing preview', async () => {
    const loadThumbnail = vi.fn().mockResolvedValue(null);

    render(
      <PartThumbnail project={summary()} loadThumbnail={loadThumbnail} />
    );

    expect(await screen.findByText('No geometry')).toBeVisible();
  });

  it('survives a rejected read without throwing', async () => {
    const loadThumbnail = vi.fn().mockRejectedValue(new Error('idb closed'));

    render(
      <PartThumbnail project={summary()} loadThumbnail={loadThumbnail} />
    );

    await waitFor(() => expect(loadThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });
});
