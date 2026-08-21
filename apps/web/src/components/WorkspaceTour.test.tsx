import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTour } from './WorkspaceTour';

const idle = { featureCount: 0, hasSelection: false, exportSeen: false };

describe('WorkspaceTour', () => {
  it('opens on the create step and auto-advances as work happens', () => {
    const { rerender } = render(<WorkspaceTour {...idle} onDismiss={vi.fn()} />);
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

  it('skips on the close control without walking anywhere', () => {
    const onDismiss = vi.fn();
    render(<WorkspaceTour {...idle} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('outlines the chrome region the current step points at', () => {
    const palette = document.createElement('nav');
    palette.className = 'tool-palette';
    document.body.appendChild(palette);
    try {
      const { unmount } = render(<WorkspaceTour {...idle} onDismiss={vi.fn()} />);
      expect(palette.classList.contains('tour-target')).toBe(true);
      unmount();
      expect(palette.classList.contains('tour-target')).toBe(false);
    } finally {
      palette.remove();
    }
  });
});
