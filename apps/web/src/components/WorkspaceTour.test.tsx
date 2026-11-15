import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTour } from './WorkspaceTour';

const idle = {
  featureCount: 0,
  hasSelection: false,
  historyOpen: false,
  exportSeen: false
};

describe('WorkspaceTour', () => {
  it('minimizes guidance without dismissing or losing its step', () => {
    const onDismiss = vi.fn();
    render(<WorkspaceTour {...idle} onDismiss={onDismiss} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Minimize modeling guide' })
    );
    expect(
      screen.queryByRole('heading', { name: 'Create your first feature' })
    ).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand modeling guide' })
    );
    expect(
      screen.getByRole('heading', { name: 'Create your first feature' })
    ).toBeVisible();
  });
  it('opens on the create step and auto-advances as work happens', () => {
    const { rerender } = render(
      <WorkspaceTour {...idle} onDismiss={vi.fn()} />
    );
    expect(screen.getByText('Create your first feature')).toBeTruthy();

    rerender(<WorkspaceTour {...idle} featureCount={1} onDismiss={vi.fn()} />);
    expect(screen.getByText('Select to edit')).toBeTruthy();

    rerender(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        hasSelection
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('The history is the model')).toBeTruthy();
  });

  it('comes back at the step it had reached after leaving the stage', () => {
    // The card unmounts while a command or a sketch runs. It used to count
    // its steps again from the first on return: past "Select to edit" by
    // hand, then a Box, and it was back at "Select to edit".
    let reached = 0;
    const props = {
      ...idle,
      featureCount: 1,
      onDismiss: vi.fn(),
      onIndexChange: (index: number) => {
        reached = index;
      }
    };
    const first = render(<WorkspaceTour {...props} />);
    expect(screen.getByText('Select to edit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }));
    expect(screen.getByText('Take it with you')).toBeTruthy();
    expect(reached).toBe(3);
    first.unmount();

    render(<WorkspaceTour {...props} featureCount={2} startIndex={reached} />);
    expect(screen.getByText('Take it with you')).toBeTruthy();
  });

  it('still skips ahead from the step it kept', () => {
    render(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        startIndex={0}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('Select to edit')).toBeTruthy();
  });

  it('starts past the steps a resumed session already did', () => {
    render(<WorkspaceTour {...idle} featureCount={3} onDismiss={vi.fn()} />);
    expect(screen.getByText('Select to edit')).toBeTruthy();
  });

  it('walks the manual steps with Next and finishes into the dismissal', () => {
    const onDismiss = vi.fn();
    render(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        hasSelection
        onDismiss={onDismiss}
      />
    );
    // Next moves on from the history step without opening History.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Take it with you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds the history step over the panel History opens, until Next (I16)', async () => {
    // It moved on the moment History opened, so the grip, row and rollback
    // tips vanished while the panel was still arriving.
    const rail = document.createElement('div');
    rail.className = 'rail-panels';
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'History panel');
    rail.appendChild(button);
    const panel = document.createElement('section');
    panel.className = 'model-panel model-panel-history';
    const file = document.createElement('details');
    file.className = 'file-menu';
    const summary = document.createElement('summary');
    file.appendChild(summary);
    document.body.append(rail, panel, file);
    const props = { ...idle, featureCount: 1, hasSelection: true };
    const { rerender, unmount } = render(
      <WorkspaceTour {...props} onDismiss={vi.fn()} />
    );
    try {
      expect(button).toHaveClass('tour-target');
      rerender(<WorkspaceTour {...props} historyOpen onDismiss={vi.fn()} />);
      expect(screen.getByText('The history is the model')).toBeTruthy();
      expect(screen.getByText(/Drag the grip to reorder/)).toBeTruthy();
      await waitFor(() => expect(panel).toHaveClass('tour-target'));
      expect(button).not.toHaveClass('tour-target');
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByText('Take it with you')).toBeTruthy();
      expect(panel).not.toHaveClass('tour-target');
      // The last step shows where Export is.
      await waitFor(() => expect(summary).toHaveClass('tour-target'));
    } finally {
      unmount();
      rail.remove();
      panel.remove();
      file.remove();
    }
  });

  it('outlines the rail and the More tools button at its foot (I16)', async () => {
    const palette = document.createElement('nav');
    palette.className = 'tool-palette';
    const more = document.createElement('button');
    more.className = 'command-more-toggle';
    palette.appendChild(more);
    document.body.appendChild(palette);
    try {
      const { unmount } = render(
        <WorkspaceTour {...idle} onDismiss={vi.fn()} />
      );
      expect(palette).toHaveClass('tour-target');
      expect(more).toHaveClass('tour-target');
      unmount();
      expect(palette).not.toHaveClass('tour-target');
      expect(more).not.toHaveClass('tour-target');
    } finally {
      palette.remove();
    }
  });

  it('still teaches the history step when History was already open', () => {
    const { rerender } = render(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        historyOpen
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('Select to edit')).toBeTruthy();
    rerender(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        hasSelection
        historyOpen
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('The history is the model')).toBeTruthy();
  });

  it('hands the keyboard back to where it came from when skipped', () => {
    // Skip unmounted the card with the focus inside it: <body> had it next.
    const onDismiss = vi.fn();
    render(
      <>
        <button type="button">Origin</button>
        <WorkspaceTour {...idle} onDismiss={onDismiss} />
      </>
    );
    const origin = screen.getByRole('button', { name: 'Origin' });
    const skip = screen.getByRole('button', { name: 'Skip the tour' });
    skip.focus();
    fireEvent.focus(skip, { relatedTarget: origin });
    fireEvent.click(skip);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(origin).toHaveFocus();
  });

  it('finishes into the workspace, not the command bar, when the keyboard came from nowhere', () => {
    // The command bar was the fallback, so "press B" — the first step's own
    // advice — typed a B into search instead of opening Box.
    render(
      <>
        <input className="command-bar-input" aria-label="Command" />
        <WorkspaceTour
          {...idle}
          featureCount={1}
          hasSelection
          onDismiss={vi.fn()}
        />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const finish = screen.getByRole('button', { name: 'Finish' });
    finish.focus();
    fireEvent.click(finish);
    expect(screen.getByRole('textbox', { name: 'Command' })).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('skips into the workspace when the keyboard came from nowhere', () => {
    render(
      <>
        <input className="command-bar-input" aria-label="Command" />
        <WorkspaceTour {...idle} onDismiss={vi.fn()} />
      </>
    );
    const skip = screen.getByRole('button', { name: 'Skip the tour' });
    skip.focus();
    fireEvent.click(skip);
    expect(screen.getByRole('textbox', { name: 'Command' })).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
  });

  it('announces a step that changes on its own', () => {
    const { rerender } = render(
      <WorkspaceTour {...idle} onDismiss={vi.fn()} />
    );
    const title = screen.getByRole('heading', {
      name: 'Create your first feature'
    });
    expect(title.closest('[aria-live="polite"]')).not.toBeNull();
    rerender(<WorkspaceTour {...idle} featureCount={1} onDismiss={vi.fn()} />);
    expect(
      screen
        .getByRole('heading', { name: 'Select to edit' })
        .closest('[aria-live="polite"]')
    ).not.toBeNull();
  });

  it('announces progress while minimized without reopening its content', () => {
    const { rerender } = render(
      <WorkspaceTour {...idle} minimized onDismiss={vi.fn()} />
    );
    rerender(
      <WorkspaceTour {...idle} minimized featureCount={1} onDismiss={vi.fn()} />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'step 2 of 4: Select to edit'
    );
    expect(
      screen.queryByRole('heading', { name: 'Select to edit' })
    ).not.toBeInTheDocument();
  });

  it('skips on the close control without walking anywhere', () => {
    const onDismiss = vi.fn();
    render(<WorkspaceTour {...idle} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('outlines a target that mounts after the step starts', async () => {
    // The tool palette is a lazy chunk: it lands a moment after the tour.
    const { unmount } = render(<WorkspaceTour {...idle} onDismiss={vi.fn()} />);
    const palette = document.createElement('nav');
    palette.className = 'tool-palette';
    document.body.appendChild(palette);
    try {
      await waitFor(() =>
        expect(palette.classList.contains('tour-target')).toBe(true)
      );
      unmount();
      expect(palette.classList.contains('tour-target')).toBe(false);
    } finally {
      palette.remove();
    }
  });

  it('points to the History rail button with the panel closed and releases it on Next', async () => {
    const { unmount } = render(
      <WorkspaceTour
        {...idle}
        featureCount={1}
        hasSelection
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('The history is the model')).toBeTruthy();
    expect(document.querySelector('.model-panel')).toBeNull();

    // The rail can arrive after the tour, just like the first step's palette.
    const rail = document.createElement('div');
    rail.className = 'rail-panels';
    const history = document.createElement('button');
    history.setAttribute('aria-label', 'History panel');
    rail.appendChild(history);
    document.body.appendChild(rail);
    try {
      await waitFor(() => expect(history).toHaveClass('tour-target'));
      expect(
        screen.getByText(/Open History from the rail on the right/)
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(screen.getByText('Take it with you')).toBeTruthy();
      expect(history).not.toHaveClass('tour-target');
    } finally {
      unmount();
      rail.remove();
    }
  });

  it('outlines the chrome region the current step points at', () => {
    const palette = document.createElement('nav');
    palette.className = 'tool-palette';
    document.body.appendChild(palette);
    try {
      const { unmount } = render(
        <WorkspaceTour {...idle} onDismiss={vi.fn()} />
      );
      expect(palette.classList.contains('tour-target')).toBe(true);
      unmount();
      expect(palette.classList.contains('tour-target')).toBe(false);
    } finally {
      palette.remove();
    }
  });
});
