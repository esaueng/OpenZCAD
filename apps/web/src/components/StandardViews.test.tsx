import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveKeymapOverrides } from '../lib/keymap';
import { ViewerToolbar } from './ViewerToolbar';
import { ViewModeBar } from './ViewModeBar';

function renderViews(mode: 'Build' | 'View', onView = vi.fn()) {
  const noop = () => undefined;
  const common = {
    settings: { showGrid: true, displayMode: 'shaded-edges' as const },
    projection: 'perspective' as const,
    onToggleGrid: noop,
    onFit: noop,
    onView,
    onCycleDisplayMode: noop,
    onToggleProjection: noop
  };
  render(
    mode === 'View' ? (
      <ViewModeBar {...common} measuring={false} onMeasure={noop} />
    ) : (
      <ViewerToolbar
        {...common}
        canUndo={false}
        canRedo={false}
        sectionRange={null}
        onUndo={noop}
        onRedo={noop}
        onToggleSection={noop}
        onSectionPlane={noop}
        onSectionOffset={noop}
        onSectionCommit={noop}
        onExportSectionDxf={noop}
        sectionOutline={{ kind: 'clipping' }}
        units="mm"
      />
    )
  );
  fireEvent.click(screen.getByRole('button', { name: 'Standard views' }));
}

afterEach(() => setActiveKeymapOverrides({}));

describe.each(['Build', 'View'] as const)('%s standard views', (mode) => {
  it('advertises the missing view keys and applies their live remaps', () => {
    act(() =>
      setActiveKeymapOverrides({
        'view-back': ['8'],
        'view-bottom': ['9'],
        'view-left': ['0']
      })
    );
    const onView = vi.fn();
    renderViews(mode, onView);
    expect(
      screen.getByRole('button', { name: 'Back view (8)' })
    ).toHaveTextContent('8');
    expect(
      screen.getByRole('button', { name: 'Bottom view (9)' })
    ).toHaveTextContent('9');
    const left = screen.getByRole('button', { name: 'Left view (0)' });
    expect(left).toHaveTextContent('0');
    fireEvent.click(left);
    expect(onView).toHaveBeenCalledWith('left');
  });

  it('omits a new default that conflicts with a saved shortcut', () => {
    act(() => setActiveKeymapOverrides({ 'view-grid': ['5'] }));
    renderViews(mode);
    const back = screen.getByRole('button', { name: 'Back view' });
    expect(back.querySelector('kbd')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Bottom view (6)' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Left view (7)' })
    ).toBeInTheDocument();
  });
});
