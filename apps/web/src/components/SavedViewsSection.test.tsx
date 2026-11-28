import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSavedViews, saveView } from '../lib/savedViews';
import { SAVE_PREVIEW_VIEW_REASON } from '../lib/saveStatePreview';
import { SavedViewsSection } from './SavedViewsSection';

const view = {
  camera: {
    position: [40, 30, 20] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    orthographicZoom: 1,
    orthographicHalfHeight: 90
  },
  projection: 'perspective' as const,
  displayMode: 'shaded-edges' as const
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('saved views while the view on screen is not the project’s (#2422)', () => {
  function open(writeRefusal: string | null) {
    const stored = saveView('project-1', { ...view, units: 'inch' });
    if (!stored.ok) throw new Error(stored.reason);
    const capture = vi.fn(() => view);
    const onApply = vi.fn();
    const onStatus = vi.fn();
    render(
      <SavedViewsSection
        projectId="project-1"
        units="inch"
        capture={capture}
        onApply={onApply}
        onStatus={onStatus}
        writeRefusal={writeRefusal}
      />
    );
    return { name: stored.view.name, capture, onApply, onStatus };
  }

  it('saves, renames and deletes nothing, and says why', () => {
    // A version saved in millimetres is framed by a millimetre camera: kept
    // under the inch project it would open far off the model.
    const { name, capture, onStatus } = open(SAVE_PREVIEW_VIEW_REASON);
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }));
    expect(capture).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith(SAVE_PREVIEW_VIEW_REASON);

    onStatus.mockClear();
    fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
    expect(onStatus).toHaveBeenLastCalledWith(SAVE_PREVIEW_VIEW_REASON);

    onStatus.mockClear();
    fireEvent.doubleClick(
      screen.getByRole('button', { name: `Go to ${name}` })
    );
    const field = screen.getByLabelText(`Name ${name}`);
    fireEvent.change(field, { target: { value: 'Over the version' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onStatus).toHaveBeenLastCalledWith(SAVE_PREVIEW_VIEW_REASON);

    expect(loadSavedViews('project-1').map((saved) => saved.name)).toEqual([
      name
    ]);
  });

  it('still goes to a saved view', () => {
    const { name, onApply } = open(SAVE_PREVIEW_VIEW_REASON);
    fireEvent.click(screen.getByRole('button', { name: `Go to ${name}` }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('saves as before with no refusal', () => {
    const { capture } = open(null);
    fireEvent.click(screen.getByRole('button', { name: /Save view/ }));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(loadSavedViews('project-1')).toHaveLength(2);
  });
});
