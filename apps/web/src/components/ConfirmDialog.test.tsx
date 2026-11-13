import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, useConfirm } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('is an alertdialog with focus on Cancel, so a reflex Enter keeps things', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Delete “Bracket A” forever?"
        body="This cannot be undone."
        confirmLabel="Delete forever"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Delete “Bracket A” forever?'
    });
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.');
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' })
    ).toHaveFocus();
    expect(
      within(dialog).getByRole('button', { name: 'Delete forever' })
    ).toHaveClass('confirm-dialog-danger');
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Escape and confirms on its own button', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        title="Reset settings on this device?"
        confirmLabel="Reset settings"
        tone="default"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
    const confirm = screen.getByRole('button', { name: 'Reset settings' });
    expect(confirm).toHaveClass('primary');
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

function Harness({ onAnswer }: { onAnswer(answer: boolean): void }) {
  const { confirm, dialog } = useConfirm();
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void confirm({
            title: 'Empty the trash?',
            confirmLabel: 'Empty trash'
          }).then(onAnswer);
        }}
      >
        Empty
      </button>
      {dialog}
    </>
  );
}

describe('useConfirm', () => {
  it('settles true on confirm and false on cancel', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<Harness onAnswer={onAnswer} />);

    await user.click(screen.getByRole('button', { name: 'Empty' }));
    await user.click(screen.getByRole('button', { name: 'Empty trash' }));
    expect(onAnswer).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Empty' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAnswer).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('answers no for a request a newer one replaces, and on unmount', async () => {
    const onAnswer = vi.fn();
    const { unmount } = render(<Harness onAnswer={onAnswer} />);
    const empty = screen.getByRole('button', { name: 'Empty' });
    act(() => empty.click());
    act(() => empty.click());
    await act(async () => undefined);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    unmount();
    await act(async () => undefined);
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer).toHaveBeenLastCalledWith(false);
  });
});
