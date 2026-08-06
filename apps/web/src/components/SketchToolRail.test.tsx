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
    onTool: vi.fn(),
    onCircleMode: vi.fn(),
    onConstruction: vi.fn(),
    onSettings: vi.fn(),
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
});
