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
  saveState: 'synced' as const,
  selectionFilter: 'any' as const,
  selectionFilterIsAutomatic: true,
  onSelectionFilter: vi.fn()
};

describe('StatusBar activity log', () => {
  it('exposes a stable, correctly pluralized workspace summary', () => {
    const { rerender } = render(<StatusBar {...defaultProps} />);

    expect(
      screen.getByLabelText('Test project · 2 features · 1 body. Sync Synced.')
    ).toBeVisible();

    rerender(<StatusBar {...defaultProps} featureCount={1} bodyCount={2} />);
    expect(
      screen.getByLabelText('Test project · 1 feature · 2 bodies. Sync Synced.')
    ).toBeVisible();
  });

  it('shows the same local-only state as the workspace top bar', () => {
    render(<StatusBar {...defaultProps} saveState="local" />);

    expect(
      screen.getByRole('group', { name: 'Workspace status' })
    ).toHaveTextContent('syncLocal only');
  });

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

describe('StatusBar announcements', () => {
  it('announces the status politely when it changes', () => {
    const { rerender } = render(<StatusBar {...defaultProps} />);

    const live = screen.getByText('Workspace ready.');
    // Polite, not assertive: modelling feedback should queue behind whatever
    // the user is already being told, never interrupt it.
    expect(live).toHaveAttribute('aria-live', 'polite');
    // Atomic, so a changed message is read whole rather than diffed into
    // whichever words happen to differ from the last one.
    expect(live).toHaveAttribute('aria-atomic', 'true');

    // The same node carries the new message, which is what makes it an
    // announcement rather than a second thing to find.
    rerender(
      <StatusBar {...defaultProps} status="Union does not fill empty space." />
    );
    expect(live).toHaveTextContent('Union does not fill empty space.');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('keeps the announcement out of the log button it sits in', () => {
    render(<StatusBar {...defaultProps} />);

    // The button names itself; the live region must not become a second,
    // separately-focusable thing, or every status change adds a tab stop.
    const button = screen.getByRole('button', {
      name: /Open activity log\. Current status: Workspace ready\./
    });
    expect(button).toBeVisible();
    expect(screen.getByText('Workspace ready.')).not.toHaveAttribute('tabindex');
  });
});
