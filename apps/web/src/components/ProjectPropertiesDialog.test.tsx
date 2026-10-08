import { act, fireEvent, render, screen } from '@testing-library/react';
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
});
