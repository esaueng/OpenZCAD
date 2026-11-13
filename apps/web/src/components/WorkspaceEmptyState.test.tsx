import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

function renderEmptyState(
  overrides: Partial<Parameters<typeof WorkspaceEmptyState>[0]> = {}
) {
  const handlers = { onBox: vi.fn(), onSketch: vi.fn(), onImport: vi.fn() };
  render(
    <WorkspaceEmptyState
      boxIcon={<svg aria-hidden="true" />}
      sketchIcon={<svg aria-hidden="true" />}
      boxKey="B"
      sketchKey="S"
      {...handlers}
      {...overrides}
    />
  );
  return handlers;
}

describe('WorkspaceEmptyState', () => {
  it('invites a first step with the three ways to begin', () => {
    const { onBox, onSketch, onImport } = renderEmptyState();
    const region = screen.getByRole('region', { name: 'Start modeling' });
    expect(region).toHaveTextContent(/^Nothing here yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Start with a box' }));
    expect(onBox).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Start a sketch' }));
    expect(onSketch).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole('button', { name: 'Import CAD files to start from' })
    );
    expect(onImport).toHaveBeenCalledOnce();
  });

  it("never answers to the tool rail's own button names", () => {
    // The rail's Box is "Box (B)…" and its Sketch "Sketch (S)…": a second
    // control under either name is one a screen reader's button list, and
    // every locator written against the rail, cannot tell from the first.
    renderEmptyState();
    for (const button of screen.getAllByRole('button')) {
      expect(button).not.toHaveAccessibleName(/^(Box|Sketch) \(/);
      expect(button).not.toHaveAccessibleName('Import CAD files…');
    }
  });

  it('keeps each visible label inside its accessible name', () => {
    // WCAG 2.5.3: what is read on the button is what speech input says.
    renderEmptyState();
    expect(
      screen.getByRole('button', { name: 'Start with a box' })
    ).toHaveTextContent(/^Box/);
    expect(
      screen.getByRole('button', { name: 'Start a sketch' })
    ).toHaveTextContent(/^Sketch/);
    expect(
      screen.getByRole('button', { name: 'Import CAD files to start from' })
    ).toHaveTextContent('Import CAD files');
  });

  it('shows the live keys, and none for a tool left unbound', () => {
    renderEmptyState({ boxKey: 'J', sketchKey: undefined });
    const box = screen.getByRole('button', { name: 'Start with a box' });
    expect(box).toHaveAttribute('title', 'Box (J)');
    expect(box.querySelector('kbd')).toHaveTextContent('J');
    const sketch = screen.getByRole('button', { name: 'Start a sketch' });
    expect(sketch).toHaveAttribute('title', 'Sketch');
    expect(sketch.querySelector('kbd')).toBeNull();
  });
});
