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
      onToggleSection={noop}
      onSectionPlane={noop}
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
        onToggleSection={noop}
        onSectionPlane={noop}
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

describe('the section button and its panel', () => {
  // 4.1 / 1.2 (UI polish pass, 4 Oct 2026): the button cycled XY → XZ →
  // YZ → off, Escape put nothing away, and the section panel and the views
  // flyout could both be open, one drawn across the other.
  function renderSection(
    sectionView: ViewerSettings['sectionView'],
    handlers: {
      onToggleSection?: () => void;
      onSectionPlane?: (plane: 'XY' | 'XZ' | 'YZ') => void;
    } = {}
  ) {
    const noop = () => undefined;
    const props = {
      projection: 'perspective' as const,
      canUndo: false,
      canRedo: false,
      sectionRange: sectionView ? { min: 0, max: 6 } : null,
      onUndo: noop,
      onRedo: noop,
      onToggleGrid: noop,
      onFit: noop,
      onView: noop,
      onCycleDisplayMode: noop,
      onToggleProjection: noop,
      onToggleSection: handlers.onToggleSection ?? noop,
      onSectionPlane: handlers.onSectionPlane ?? noop,
      onSectionOffset: noop,
      onSectionCommit: noop,
      onExportSectionDxf: noop,
      sectionOutline: { kind: 'clipping' } as const,
      units: 'mm'
    };
    const view = render(
      <ViewerToolbar
        settings={{
          ...settings,
          ...(sectionView ? { sectionView } : { sectionView: undefined })
        }}
        {...props}
      />
    );
    return {
      rerender(next: ViewerSettings['sectionView']) {
        view.rerender(
          <ViewerToolbar
            settings={{
              ...settings,
              ...(next ? { sectionView: next } : { sectionView: undefined })
            }}
            {...props}
            sectionRange={next ? { min: 0, max: 6 } : null}
          />
        );
      }
    };
  }
  const sectionButton = () =>
    screen.getByRole('button', { name: /^Section view/ });
  const panel = () => document.querySelector('.rail-section-panel');

  it('switches on and off with one click each', () => {
    const onToggleSection = vi.fn();
    const view = renderSection(undefined, { onToggleSection });
    expect(sectionButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sectionButton());
    expect(onToggleSection).toHaveBeenCalledOnce();

    view.rerender({ plane: 'XY', offset: 3 });
    expect(sectionButton().getAttribute('aria-pressed')).toBe('true');
    expect(panel()).not.toBeNull();
    fireEvent.click(sectionButton());
    expect(onToggleSection).toHaveBeenCalledTimes(2);
  });

  it('chooses the plane inside the panel', () => {
    const onSectionPlane = vi.fn();
    renderSection({ plane: 'XY', offset: 3 }, { onSectionPlane });
    const planes = screen.getByRole('group', { name: 'Section plane' });
    expect(
      [...planes.querySelectorAll('button')].map((button) => [
        button.textContent,
        button.getAttribute('aria-pressed')
      ])
    ).toEqual([
      ['XY', 'true'],
      ['XZ', 'false'],
      ['YZ', 'false']
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'YZ plane' }));
    expect(onSectionPlane).toHaveBeenCalledWith('YZ');
    // The plane already cutting is not re-requested (it would re-centre).
    fireEvent.click(screen.getByRole('button', { name: 'XY plane' }));
    expect(onSectionPlane).toHaveBeenCalledOnce();
  });

  it('puts the panel away on Escape, leaving the cut on', () => {
    const onToggleSection = vi.fn();
    renderSection({ plane: 'XY', offset: 3 }, { onToggleSection });
    // A press on the panel, with nothing focused after it (Safari does not
    // focus a clicked button), is enough for Escape to belong to the panel.
    const plane = screen.getByRole('button', { name: 'XZ plane' });
    fireEvent.pointerDown(plane);
    fireEvent.click(plane);
    expect(document.activeElement).toBe(document.body);
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(sectionButton().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(sectionButton());
    // The next press brings the panel back rather than switching off.
    fireEvent.click(sectionButton());
    expect(panel()).not.toBeNull();
    expect(onToggleSection).not.toHaveBeenCalled();
  });

  it('leaves Escape to the workspace while the user is elsewhere', () => {
    renderSection({ plane: 'XY', offset: 3 });
    // Pressed on the panel, then moved on to a field: Escape is the field's.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'XZ plane' }));
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: 'Escape' });
    expect(panel()).not.toBeNull();
    // Pressed on the canvas: Escape clears the pick, not the panel.
    fireEvent.pointerDown(elsewhere);
    elsewhere.blur();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).not.toBeNull();
    elsewhere.remove();
  });

  it('keeps one rail popover open at a time', () => {
    renderSection({ plane: 'XY', offset: 3 });
    const views = screen.getByRole('button', { name: 'Standard views' });
    expect(panel()).not.toBeNull();
    fireEvent.click(views);
    expect(views.getAttribute('aria-expanded')).toBe('true');
    expect(panel()).toBeNull();
    // The cut is still on; reopening its panel puts the views away.
    expect(sectionButton().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sectionButton());
    expect(panel()).not.toBeNull();
    expect(views.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens its panel, and closes the views, when the cut comes on', () => {
    const view = renderSection(undefined);
    const views = screen.getByRole('button', { name: 'Standard views' });
    fireEvent.click(views);
    expect(views.getAttribute('aria-expanded')).toBe('true');
    // From the palette as much as from the button.
    view.rerender({ plane: 'XZ', offset: 1 });
    expect(panel()).not.toBeNull();
    expect(views.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the standard views flyout', () => {
  it('hands the keyboard back to its button once a view is chosen', () => {
    // The chosen tile unmounted with the panel and focus fell to <body>.
    const onView = vi.fn();
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
        onView={onView}
        onCycleDisplayMode={noop}
        onToggleProjection={noop}
        onToggleSection={noop}
        onSectionPlane={noop}
        onSectionOffset={noop}
        onSectionCommit={noop}
        onExportSectionDxf={noop}
        sectionOutline={{ kind: 'clipping' }}
        units="mm"
      />
    );
    const trigger = screen.getByRole('button', { name: 'Standard views' });
    // A group of buttons, not a menu: no menu-button claim.
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(trigger);
    const top = screen.getByRole('button', { name: 'Top view (2)' });
    // The key is on the tile; the view's name stays the visible text.
    expect(top).toHaveTextContent('Top2');
    top.focus();
    fireEvent.click(top);
    expect(onView).toHaveBeenCalledWith('top');
    expect(trigger).toHaveFocus();
  });
});

describe('the section view help', () => {
  it('leads with the state and names the panel apart from its slider', () => {
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
        onToggleSection={noop}
        onSectionPlane={noop}
        onSectionOffset={noop}
        onSectionCommit={noop}
        onExportSectionDxf={noop}
        sectionOutline={{ kind: 'clipping' }}
        units="mm"
      />
    );
    // The old sentence ran past the 320px tooltip and lost "Now: …".
    fireEvent.focus(screen.getByRole('button', { name: /^Section view/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Section viewNow: XY plane · cuts the display only'
    );
    expect(
      screen.getByRole('group', { name: 'Section view' })
    ).toContainElement(
      screen.getByRole('slider', { name: 'Section plane offset' })
    );
  });
});
