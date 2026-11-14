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
    const status = screen.getByText('Loading project details…');
    expect(status).toHaveAttribute('role', 'status');
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
    // The caveat opens from a button, so keyboard and touch reach it, and
    // stays out of the way until asked for.
    const caveat =
      'A duplicated project keeps the save history of its original.';
    expect(within(history).getByText(caveat)).not.toBeVisible();
    const about = within(history).getByRole('button', {
      name: 'About First recorded save'
    });
    expect(about).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(about);
    expect(about).toHaveAttribute('aria-expanded', 'true');
    expect(within(history).getByText(caveat)).toBeVisible();
    expect(about).toHaveAttribute(
      'aria-controls',
      within(history).getByText(caveat).id
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

  /** Success feedback stayed until the dialog closed, past any later copy. */
  it('settles Copied back to Copy after a moment', async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn().mockResolvedValue(undefined) }
      });
      renderDialog();
      await act(async () => undefined);
      fireEvent.click(screen.getByRole('button', { name: 'Copy project ID' }));
      await act(async () => undefined);
      expect(screen.getByText('Project ID copied.')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        screen.getByRole('button', { name: 'Copy project ID' })
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'refuses the write',
      { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    ],
    ['has no clipboard', undefined]
  ])('says so when the browser %s', async (_case, clipboard) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboard
    });
    renderDialog();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Copy project ID' }));
    expect(
      await screen.findByText(
        'Could not copy the project ID. Select it to copy it.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Could not copy project ID; select it to copy'
      })
    ).toBeInTheDocument();
  });

  it('states how the project is stored, with the reason one press away', async () => {
    render(
      <ProjectPropertiesDialog
        project={project}
        accountStatus="Saved to my account"
        encryption={{
          state: 'encrypted',
          label: 'End-to-end encrypted',
          detail: 'Encrypted on this device before it is saved.'
        }}
        loadProperties={vi.fn().mockResolvedValue(details)}
        onClose={vi.fn()}
      />
    );
    const library = await screen.findByRole('region', { name: 'Library' });
    const value = within(library).getByText('Encryption').nextElementSibling;
    expect(value).toHaveTextContent('End-to-end encrypted');
    expect(value?.querySelector('svg')).not.toBeNull();
    fireEvent.click(
      within(library).getByRole('button', { name: 'About Encryption' })
    );
    expect(
      within(library).getByText('Encrypted on this device before it is saved.')
    ).toBeVisible();
  });

  it('leaves the encryption row out when the host does not say', async () => {
    renderDialog();
    await screen.findByRole('alert');
    expect(screen.queryByText('Encryption')).toBeNull();
  });
});
