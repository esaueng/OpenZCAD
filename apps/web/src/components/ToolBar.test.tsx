import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { toolTitle, type ToolAvailability } from '../lib/tools';
import { ToolBar } from './ToolBar';

const AVAILABILITY: ToolAvailability = {
  sketchCount: 0,
  liveBodyCount: 1,
  exactGeometryReady: true,
  hasEdgeSelected: false
};

describe('ToolBar', () => {
  it('preserves the composed accessible names without native titles', () => {
    render(
      <ToolBar
        activeTool={null}
        availability={AVAILABILITY}
        onLaunchTool={vi.fn()}
      />
    );

    const box = screen.getByRole('button', {
      name: toolTitle('box', AVAILABILITY)
    });
    const extrude = screen.getByRole('button', {
      name: toolTitle('extrude', AVAILABILITY)
    });
    expect(box).not.toHaveAttribute('title');
    expect(extrude).toBeDisabled();
    expect(extrude).toHaveAccessibleName('Extrude (E) — Create a sketch first');
  });
});
