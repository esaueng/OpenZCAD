import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnappliedCardDialog } from './UnappliedCardDialog';

function renderDialog() {
  const handlers = {
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn()
  };
  render(
    <UnappliedCardDialog card="Move" outcome="Union opens" {...handlers} />
  );
  return handlers;
}

describe('UnappliedCardDialog', () => {
  it('names the pending card and the tool, and focuses Apply', () => {
    const { onApply, onDiscard, onCancel } = renderDialog();
    const dialog = screen.getByRole('alertdialog', {
      name: 'Apply the Move first?'
    });
    expect(dialog).toHaveTextContent(
      'The Move card has changes that are not applied yet. Apply them or discard them before Union opens.'
    );
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toHaveFocus();
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledOnce();
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('discards, or cancels on the button and on Escape', () => {
    const { onApply, onDiscard, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onApply).not.toHaveBeenCalled();
  });
});
