import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SharedLinkCopyDialog } from './SharedLinkCopyDialog';
import { ViewModeRail } from './ViewModeRail';

describe('SharedLinkCopyDialog (ADR-024 slice 5-11)', () => {
  it('holds the account copy until the account has answered', async () => {
    const onChoose = vi.fn();
    render(<SharedLinkCopyDialog accountEncrypts={null} onChoose={onChoose} />);
    const dialog = screen.getByRole('dialog', { name: 'Make a copy' });
    expect(dialog).toHaveTextContent('Checking your account…');
    expect(
      screen.getByRole('button', { name: 'Copy to your account' })
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Keep on this device only' })
    );
    expect(onChoose).toHaveBeenCalledWith('device');
  });

  it('says whether the account copy is end-to-end encrypted', async () => {
    const onChoose = vi.fn();
    const { rerender } = render(
      <SharedLinkCopyDialog accountEncrypts onChoose={onChoose} />
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      /end-to-end encrypted under your keys/
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Copy to your account' })
    );
    expect(onChoose).toHaveBeenLastCalledWith('account');

    rerender(
      <SharedLinkCopyDialog accountEncrypts={false} onChoose={onChoose} />
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      /stored without end-to-end encryption/
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
    await userEvent.keyboard('{Escape}');
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });
});

describe('ViewModeRail Make a copy (ADR-024 slice 5-11)', () => {
  const parts = {
    bodies: [],
    hiddenBodyIds: new Set<string>(),
    selectedBodyIds: [],
    open: false,
    onOpenChange: vi.fn(),
    onSelectBody: vi.fn(),
    onToggleVisibility: vi.fn(),
    onIsolate: vi.fn(),
    onShowAll: vi.fn()
  };

  it('offers Make a copy only when given one', async () => {
    const { rerender } = render(<ViewModeRail {...parts} />);
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
    const onMakeCopy = vi.fn();
    rerender(<ViewModeRail {...parts} onMakeCopy={onMakeCopy} />);
    await userEvent.click(screen.getByRole('button', { name: 'Make a copy' }));
    expect(onMakeCopy).toHaveBeenCalledOnce();
  });
});
