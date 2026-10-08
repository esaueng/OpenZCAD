import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTour } from './WorkspaceTour';

const idle = { featureCount: 0, hasSelection: false, exportSeen: false };

describe('WorkspaceTour', () => {
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
    // History is the step the app cannot observe; Next is the only way on.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Take it with you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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

  it('finishes into the command bar when the keyboard came from nowhere', () => {
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
    expect(screen.getByRole('textbox', { name: 'Command' })).toHaveFocus();
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
