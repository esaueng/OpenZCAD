import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  PanelFrame,
  type PanelControls,
  type PanelDockControls
} from './PanelFrame';

function dockControls(
  overrides: Partial<PanelDockControls> = {}
): PanelDockControls {
  return {
    onHeaderPointerDown: vi.fn(),
    moveItems: vi.fn(() => [
      { id: 'dock-left', label: 'Dock left' },
      { id: 'float', label: 'Float', disabled: true, detail: 'Not here' },
      { id: 'up', label: 'Move up', shortcut: 'Alt+↑', section: true }
    ]),
    onMove: vi.fn(),
    onGripKey: vi.fn(() => true),
    onPopOut: vi.fn(),
    ...overrides
  };
}

function frame(dock?: PanelDockControls): PanelControls {
  return {
    placement: 'docked',
    status: 'docked',
    onPin: vi.fn(),
    onUnpin: vi.fn(),
    onClose: vi.fn(),
    onUse: vi.fn(),
    ...(dock ? { dock } : {})
  };
}

function renderFrame(controls: PanelControls) {
  render(
    <PanelFrame id="history" count={2} controls={controls}>
      <p>Rows</p>
    </PanelFrame>
  );
  return within(screen.getByRole('region', { name: 'History' }));
}

describe('PanelFrame in a dock', () => {
  it('makes the grip a Move menu button and offers Pop out', async () => {
    const user = userEvent.setup();
    const dock = dockControls();
    const region = renderFrame(frame(dock));
    const grip = region.getByRole('button', { name: 'Move History' });
    expect(grip).toHaveAttribute('aria-haspopup', 'menu');
    // A closed menu leaves the header with nothing that reads as a fold.
    expect(grip).not.toHaveAttribute('aria-expanded');
    await user.click(region.getByRole('button', { name: 'Pop out History' }));
    expect(dock.onPopOut).toHaveBeenCalledTimes(1);

    await user.click(grip);
    const menu = screen.getByRole('menu', { name: 'Move History' });
    expect(grip).toHaveAttribute('aria-expanded', 'true');
    expect(dock.moveItems).toHaveBeenCalledTimes(1);
    expect(
      within(menu).getByRole('menuitem', { name: /^Float/ })
    ).toBeDisabled();
    await user.click(
      within(menu).getByRole('menuitem', { name: /^Dock left/ })
    );
    expect(dock.onMove).toHaveBeenCalledWith('dock-left');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hands header presses and grip keys to the dock', () => {
    const dock = dockControls();
    const region = renderFrame(frame(dock));
    fireEvent.pointerDown(region.getByRole('heading', { name: 'History 2' }));
    expect(dock.onHeaderPointerDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region.getByRole('button', { name: 'Move History' }), {
      key: 'ArrowUp',
      altKey: true
    });
    expect(dock.onGripKey).toHaveBeenCalledTimes(1);
  });

  it('has no Pop out where the dock offers none, and no Move menu outside a dock', () => {
    const lone = renderFrame(frame(dockControls({ onPopOut: undefined })));
    expect(lone.queryByRole('button', { name: 'Pop out History' })).toBeNull();
    expect(lone.getByRole('button', { name: 'Move History' })).toBeVisible();
  });

  it('draws the phone lane’s panel without the dock’s controls', () => {
    const region = renderFrame({ ...frame(), placement: 'phone' });
    expect(region.queryByRole('button', { name: 'Move History' })).toBeNull();
    expect(region.queryByRole('button', { name: /Pop out/ })).toBeNull();
  });
});
