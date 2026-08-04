import { StrictMode, useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useModalFocus } from './useModalFocus';

function Modal({ onClose }: { onClose(): void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef });
  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} role="dialog" aria-label="Test dialog" tabIndex={-1}>
        <input ref={initialFocusRef} aria-label="First field" />
        <button type="button" onClick={onClose}>
          Close dialog
        </button>
      </div>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <button type="button">Background action</button>
      {open && <Modal onClose={() => setOpen(false)} />}
    </>
  );
}

describe('useModalFocus', () => {
  it('captures the opener before focusing, inerts the background, and restores focus', async () => {
    const user = userEvent.setup();
    render(
      <StrictMode>
        <Harness />
      </StrictMode>
    );

    const opener = screen.getByRole('button', { name: 'Open dialog' });
    const background = screen.getByRole('button', {
      name: 'Background action'
    });
    await user.click(opener);

    expect(screen.getByLabelText('First field')).toHaveFocus();
    expect(opener).toHaveAttribute('inert');
    expect(background).toHaveAttribute('inert');

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('First field')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('inert');
  });
});
