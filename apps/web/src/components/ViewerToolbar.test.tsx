import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ViewerToolbar } from './ViewerToolbar';
import type { SectionOutlineState } from '../lib/sectionOutline';
import type { ViewerSettings } from '@openzcad/viewport';

/**
 * The section panel is where the two section pipelines are told apart. The
 * clipped preview is what a drag shows; the kernel's exact section is what
 * the DXF export writes, and the button that writes it is live only while
 * that is what is actually on screen.
 */

const settings: ViewerSettings = {
  showGrid: true,
  displayMode: 'shaded-edges',
  sectionView: { plane: 'XY', offset: 3 }
};

function renderToolbar(
  sectionOutline: SectionOutlineState,
  handlers: {
    onSectionCommit?: () => void;
    onExportSectionDxf?: () => void;
    onSectionOffset?: (offset: number) => void;
  } = {}
) {
  const noop = () => undefined;
  render(
    <ViewerToolbar
      settings={settings}
      projection="perspective"
      canUndo={false}
      canRedo={false}
      sectionRange={{ min: 0, max: 6 }}
      onUndo={noop}
      onRedo={noop}
      onToggleGrid={noop}
      onFit={noop}
      onView={noop}
      onCycleDisplayMode={noop}
      onToggleProjection={noop}
      onCycleSection={noop}
      onSectionOffset={handlers.onSectionOffset ?? noop}
      onSectionCommit={handlers.onSectionCommit ?? noop}
      onExportSectionDxf={handlers.onExportSectionDxf ?? noop}
      sectionOutline={sectionOutline}
      units="mm"
    />
  );
}

describe('the section panel', () => {
  it('names the clipped preview and refuses to export it', () => {
    renderToolbar({ kind: 'clipping' });
    expect(screen.getByText('Clipping preview')).toBeTruthy();
    expect(
      screen.getByText(/release the slider for section curves/)
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Export the exact section as DXF')
    ).toHaveProperty('disabled', true);
  });

  it('names the exact section, shows its area, and exports it', () => {
    const onExportSectionDxf = vi.fn();
    renderToolbar(
      { kind: 'exact', regions: [], area: 187.4538, missed: 0, unsectioned: 0 },
      { onExportSectionDxf }
    );
    expect(screen.getByText('Exact section')).toBeTruthy();
    expect(screen.getByText('187.45 mm² of material')).toBeTruthy();
    const button = screen.getByLabelText('Export the exact section as DXF');
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    expect(onExportSectionDxf).toHaveBeenCalledOnce();
  });

  it('still exports when the plane merely misses a body', () => {
    renderToolbar({
      kind: 'exact',
      regions: [],
      area: 540,
      missed: 1,
      unsectioned: 0
    });
    expect(
      screen.getByText('540 mm² of material, 1 body is not cut here')
    ).toBeTruthy();
    // The exporter treats a plane that misses a body as an ordinary section,
    // so the drawing is complete and the button stays live.
    expect(
      screen.getByLabelText('Export the exact section as DXF')
    ).toHaveProperty('disabled', false);
  });

  it('shuts the export when a body the plane cuts has no exact section', () => {
    const onExportSectionDxf = vi.fn();
    renderToolbar(
      { kind: 'exact', regions: [], area: 540, missed: 0, unsectioned: 1 },
      { onExportSectionDxf }
    );
    // The kernel section IS on screen for the body that came out exact, so
    // the rail still names it; the drawing would be missing the other body's
    // material, and `exportSectionDxf` refuses rather than dropping it.
    expect(screen.getByText('Exact section')).toBeTruthy();
    expect(
      screen.getByText(
        '540 mm² of material, 1 body has no exact section, so there is no drawing to export'
      )
    ).toBeTruthy();
    const button = screen.getByLabelText('Export the exact section as DXF');
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(onExportSectionDxf).not.toHaveBeenCalled();
  });

  it('shows a refusal in full and keeps the export shut', () => {
    renderToolbar({
      kind: 'refused',
      detail: 'The section plane does not pass through this body.'
    });
    expect(screen.getByText('No exact section')).toBeTruthy();
    expect(
      screen.getByText('The section plane does not pass through this body.')
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Export the exact section as DXF')
    ).toHaveProperty('disabled', true);
  });

  it('asks for the exact cut when the slider is released, not while dragging', () => {
    const onSectionCommit = vi.fn();
    const onSectionOffset = vi.fn();
    renderToolbar({ kind: 'clipping' }, { onSectionCommit, onSectionOffset });
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '4' } });
    expect(onSectionOffset).toHaveBeenCalledWith(4);
    expect(onSectionCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onSectionCommit).toHaveBeenCalledOnce();
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onSectionCommit).toHaveBeenCalledTimes(2);
  });
});

describe('Measure on the viewer bar', () => {
  // F13: Measure was on View mode's rail only, so Build had no way to it.
  function renderWithMeasure(
    measuring: boolean,
    onMeasure?: (next: boolean) => void
  ) {
    const noop = () => undefined;
    render(
      <ViewerToolbar
        settings={{ ...settings, sectionView: undefined }}
        projection="perspective"
        canUndo={false}
        canRedo={false}
        sectionRange={null}
        onUndo={noop}
        onRedo={noop}
        onToggleGrid={noop}
        onFit={noop}
        measuring={measuring}
        {...(onMeasure ? { onMeasure } : {})}
        onView={noop}
        onCycleDisplayMode={noop}
        onToggleProjection={noop}
        onCycleSection={noop}
        onSectionOffset={noop}
        onSectionCommit={noop}
        onExportSectionDxf={noop}
        sectionOutline={{ kind: 'clipping' }}
        units="mm"
      />
    );
  }

  it('toggles Measure and shows whether it is on', () => {
    const onMeasure = vi.fn();
    renderWithMeasure(false, onMeasure);
    const button = screen.getByRole('button', { name: 'Measure' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onMeasure).toHaveBeenCalledWith(true);
  });

  it('reads pressed while measuring and switches it off', () => {
    const onMeasure = vi.fn();
    renderWithMeasure(true, onMeasure);
    const button = screen.getByRole('button', { name: 'Measure' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onMeasure).toHaveBeenCalledWith(false);
  });

  it('draws no ruler without a handler', () => {
    renderWithMeasure(false);
    expect(screen.queryByRole('button', { name: 'Measure' })).toBeNull();
  });
});
