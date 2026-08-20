import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@openzcad/shared';
import { SketchToolRail } from './SketchToolRail';

function renderRail(
  overrides: Partial<ComponentProps<typeof SketchToolRail>> = {}
) {
  const props: ComponentProps<typeof SketchToolRail> = {
    tool: 'circle',
    circleMode: 'center-radius',
    construction: false,
    settings: structuredClone(DEFAULT_APP_SETTINGS.sketching),
    units: 'mm',
    paletteVisible: true,
    canConstrain: true,
    pendingConstraint: null,
    constraints: [],
    solveStatus: null,
    solving: false,
    onTool: vi.fn(),
    onCircleMode: vi.fn(),
    onConstruction: vi.fn(),
    onSettings: vi.fn(),
    onConstraintTool: vi.fn(),
    onDeleteConstraint: vi.fn(),
    onSolve: vi.fn(),
    onDiagnostics: vi.fn(),
    onExtrude: vi.fn(),
    onExit: vi.fn(),
    ...overrides
  };
  return { ...render(<SketchToolRail {...props} />), props };
}

describe('SketchToolRail', () => {
  it('selects a circle construction mode from the shared flyout', async () => {
    const user = userEvent.setup();
    const onCircleMode = vi.fn();
    renderRail({ onCircleMode });

    await user.click(
      screen.getByRole('button', { name: 'Choose circle type' })
    );
    await user.click(
      screen.getByRole('menuitemradio', { name: /Three-Point Circle/ })
    );

    expect(onCircleMode).toHaveBeenCalledWith('three-point');
    expect(
      screen.queryByRole('menuitemradio', { name: /Three-Point Circle/ })
    ).not.toBeInTheDocument();
  });

  it('keeps geometry and grid snapping independent', async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();
    renderRail({ onSettings });

    await user.click(screen.getByLabelText('Snap to grid'));
    expect(onSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapEnabled: true, geometrySnapEnabled: true })
    );

    await user.click(screen.getByLabelText('Geometry snaps'));
    expect(onSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapEnabled: false,
        geometrySnapEnabled: false
      })
    );
  });

  it('keeps Finish Sketch permanently available', async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    renderRail({ onExit });

    await user.click(screen.getByRole('button', { name: 'Finish Sketch' }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('arms a constraint tool and disarms it on a second click', async () => {
    const user = userEvent.setup();
    const onConstraintTool = vi.fn();
    const { rerender, props } = renderRail({ onConstraintTool });

    await user.click(screen.getByRole('button', { name: 'Parallel' }));
    expect(onConstraintTool).toHaveBeenLastCalledWith('parallel');

    rerender(
      <SketchToolRail
        {...props}
        pendingConstraint={{ kind: 'parallel', picks: [] }}
      />
    );
    const armed = screen.getByRole('button', { name: 'Parallel' });
    expect(armed).toHaveAttribute('aria-pressed', 'true');
    await user.click(armed);
    expect(onConstraintTool).toHaveBeenLastCalledWith(null);
  });

  it('disables constraining until the sketch node exists', () => {
    renderRail({ canConstrain: false });
    expect(screen.getByRole('button', { name: 'Horizontal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Solve' })).toBeDisabled();
  });

  it('solves on demand and shows the status pill', async () => {
    const user = userEvent.setup();
    const onSolve = vi.fn();
    renderRail({
      onSolve,
      constraints: [{ constraintId: 'scon_1', label: 'Horizontal · Line' }],
      solveStatus: { label: '2 DOF remaining', tone: 'info' }
    });

    expect(screen.getByRole('status')).toHaveTextContent('2 DOF remaining');
    await user.click(screen.getByRole('button', { name: 'Solve' }));
    expect(onSolve).toHaveBeenCalledOnce();
  });

  it('lists constraints in the palette with per-row delete', async () => {
    const user = userEvent.setup();
    const onDeleteConstraint = vi.fn();
    renderRail({
      onDeleteConstraint,
      constraints: [
        { constraintId: 'scon_1', label: 'Horizontal · Line 1' },
        { constraintId: 'scon_2', label: 'Parallel · Line 1 ∥ Line 2' }
      ]
    });

    await user.click(
      screen.getByRole('button', {
        name: 'Delete constraint: Parallel · Line 1 ∥ Line 2'
      })
    );
    expect(onDeleteConstraint).toHaveBeenCalledWith('scon_2');
  });
});
