import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';

const defaultProps = {
  status: 'Workspace ready.',
  tone: 'ready' as const,
  hint: null,
  projectName: 'Test project',
  bodyCount: 1,
  featureCount: 2,
  warningCount: 0,
  documentVersion: 3,
  units: 'mm',
  selectionFilter: 'any' as const,
  selectionFilterIsAutomatic: true,
  onSelectionFilter: vi.fn()
};

describe('StatusBar activity log', () => {
  it('opens from the current status and retains every displayed status', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StatusBar {...defaultProps} />);
    const trigger = screen.getByRole('button', {
      name: /Open activity log\. Current status: Workspace ready\./
    });

    await user.click(trigger);

    const log = screen.getByRole('region', { name: 'Activity log' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(log).getByText('Workspace ready.')).toBeVisible();
    expect(within(log).getByText('1 entry this session')).toBeVisible();

    rerender(
      <StatusBar
        {...defaultProps}
        status="Fillet could not be applied."
        tone="warning"
      />
    );

    expect(
      await within(log).findByText('Fillet could not be applied.')
    ).toBeVisible();
    expect(within(log).getByText('Workspace ready.')).toBeVisible();
    expect(within(log).getByText('2 entries this session')).toBeVisible();
    expect(
      within(log).getByText('Fillet could not be applied.').closest('li')
    ).toHaveAttribute('aria-current', 'true');
  });

  it('closes with Escape and restores focus to the status trigger', async () => {
    const user = userEvent.setup();
    render(<StatusBar {...defaultProps} />);
    const trigger = screen.getByRole('button', {
      name: /Open activity log/
    });

    await user.click(trigger);
    expect(screen.getByRole('region', { name: 'Activity log' })).toBeVisible();

    await user.keyboard('{Escape}');

    expect(
      screen.queryByRole('region', { name: 'Activity log' })
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Escape from reaching the workspace behind the log', async () => {
    const user = userEvent.setup();
    const workspaceKeyDown = vi.fn();
    window.addEventListener('keydown', workspaceKeyDown);

    try {
      render(<StatusBar {...defaultProps} />);
      await user.click(
        screen.getByRole('button', { name: /Open activity log/ })
      );

      await user.keyboard('{Escape}');

      expect(workspaceKeyDown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', workspaceKeyDown);
    }
  });
});
