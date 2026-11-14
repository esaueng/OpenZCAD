import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import type { ProjectProperties } from '../lib/projectProperties';
import { ProjectPropertiesDialog } from './ProjectPropertiesDialog';

const project: ProjectSummary = {
  projectId: toProjectId('project_properties'),
  name: 'Bracket',
  revisionCount: 1,
  updatedAt: '2026-10-08T01:59:30.000Z'
};

const details: ProjectProperties = {
  source: 'device',
  olderDeviceCopy: false,
  updatedAt: '2026-10-08T01:59:30.000Z',
  startedAt: '2026-10-07T01:59:30.000Z',
  units: 'mm',
  documentVersion: 204,
  documentBytes: 3 * 1024 * 1024,
  referencedSourceBytes: 0,
  bodies: 13,
  features: 31,
  sketches: 18,
  parameters: 23,
  savePoints: 5
};

function renderDialog(
  loadProperties: () => Promise<ProjectProperties | null> = vi
    .fn()
    .mockResolvedValue(null)
) {
  const onClose = vi.fn();
  render(
    <ProjectPropertiesDialog
      project={project}
      accountStatus="This device only"
      loadProperties={loadProperties}
      onClose={onClose}
    />
  );
  return { onClose };
}

describe('ProjectPropertiesDialog', () => {
  /**
   * The backdrop closed on click, and a drag that selects the project name or
   * ID and ends past the card fires its click on the backdrop.
   */
  it('stays open when a text drag ends on the backdrop, and closes on a press there', async () => {
    const { onClose } = renderDialog();
    await screen.findByRole('alert');
    const dialog = screen.getByRole('dialog', { name: 'Project properties' });
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(screen.getByText('Bracket'));
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('spins its loading indicator', () => {
    renderDialog(() => new Promise(() => undefined));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading project details…');
    expect(status.querySelector('svg')).toHaveClass('spin');
  });

  it('shows dates without seconds, as the start screen tile does', async () => {
    renderDialog();
    await act(async () => undefined);
    const edited = screen.getByText('Last edited').nextElementSibling;
    const date = new Date(project.updatedAt);
    expect(edited?.textContent).toBe(
      `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      })}`
    );
  });

  it('draws Retry and Close as buttons, not bare text', async () => {
    renderDialog();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveClass(
      'secondary'
    );
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(
      'secondary'
    );
  });

  /**
   * One flat grid of twenty label/value cells mixed counts, dates and sizes
   * with no order a reader could scan; the details now sit under headings.
   */
  it('groups the details under headed sections, counts first', async () => {
    renderDialog(vi.fn().mockResolvedValue(details));
    const contents = await screen.findByLabelText('Contents');
    expect(
      [...contents.querySelectorAll('div')].map((tile) => tile.textContent)
    ).toEqual(['Bodies13', 'Features31', 'Sketches18', 'Parameters23']);
    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(['Library', 'History', 'Storage', 'Technical']);
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('Save points')).toBeInTheDocument();
    // The caveat is the label's tooltip, not a line that grows the dialog.
    expect(within(history).getByText('First recorded save')).toHaveAttribute(
      'title',
      'A duplicated project keeps the save history of its original.'
    );
    const storage = screen.getByRole('region', { name: 'Storage' });
    expect(within(storage).getByText('Project data size')).toBeInTheDocument();
    expect(screen.getByText('Details from this device')).toBeInTheDocument();
  });

  /** Without a referenced source, document and total sizes were the same row twice. */
  it('splits the size only when referenced source files add to it', async () => {
    renderDialog(vi.fn().mockResolvedValue(details));
    const total = await screen.findByText('Project data size');
    expect(total.nextElementSibling).toHaveTextContent('3 MiB');
    expect(screen.queryByText('Document size')).toBeNull();
    expect(screen.queryByText('Referenced source files')).toBeNull();
  });

  it('lists referenced source files when present, inside the total', async () => {
    renderDialog(
      vi.fn().mockResolvedValue({ ...details, referencedSourceBytes: 1024 })
    );
    const label = await screen.findByText('Referenced source files');
    expect(label.nextElementSibling).toHaveTextContent('1 KiB');
    expect(
      screen.getByText('Document size').nextElementSibling
    ).toHaveTextContent('3 MiB');
  });

  it('copies the project ID', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    renderDialog();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Copy project ID' }));
    expect(writeText).toHaveBeenCalledWith(project.projectId);
    expect(
      await screen.findByRole('button', { name: 'Copied project ID' })
    ).toBeInTheDocument();
  });
});
