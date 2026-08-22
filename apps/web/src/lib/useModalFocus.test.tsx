import { StrictMode, useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useModalFocus } from './useModalFocus';

function Modal({
  label = 'Test dialog',
  onClose
}: {
  label?: string;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  useModalFocus(dialogRef, { autoFocus: true, initialFocusRef });
  return (
    <div className="modal-backdrop">
      <div ref={dialogRef} role="dialog" aria-label={label} tabIndex={-1}>
        <input ref={initialFocusRef} aria-label={`${label} first field`} />
        <button type="button" onClick={onClose}>
          Close {label}
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

    expect(screen.getByLabelText('Test dialog first field')).toHaveFocus();
    expect(opener).toHaveAttribute('inert');
    expect(background).toHaveAttribute('inert');

    await user.tab({ shift: true });
    expect(
      screen.getByRole('button', { name: 'Close Test dialog' })
    ).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Test dialog first field')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Close Test dialog' }));
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('inert');
  });

  it('keeps the topmost concurrent dialog interactive and reactivates the one below', async () => {
    const user = userEvent.setup();

    function StackedHarness() {
      const [lowerOpen, setLowerOpen] = useState(false);
      const [upperOpen, setUpperOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setLowerOpen(true);
              setUpperOpen(true);
            }}
          >
            Open stacked dialogs
          </button>
          {lowerOpen && (
            <Modal label="Lower dialog" onClose={() => setLowerOpen(false)} />
          )}
          {upperOpen && (
            <Modal label="Upper dialog" onClose={() => setUpperOpen(false)} />
          )}
        </>
      );
    }

    render(
      <StrictMode>
        <StackedHarness />
      </StrictMode>
    );
    await user.click(
      screen.getByRole('button', { name: 'Open stacked dialogs' })
    );

    const upper = screen.getByRole('dialog', { name: 'Upper dialog' });
    expect(upper.parentElement).not.toHaveAttribute('inert');
    expect(screen.getByLabelText('Upper dialog first field')).toHaveFocus();

    await user.click(
      screen.getByRole('button', { name: 'Close Upper dialog' })
    );
    expect(screen.getByLabelText('Lower dialog first field')).toHaveFocus();
    expect(
      screen.getByRole('dialog', { name: 'Lower dialog' }).parentElement
    ).not.toHaveAttribute('inert');

    await user.click(
      screen.getByRole('button', { name: 'Close Lower dialog' })
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Open stacked dialogs' })
      ).toHaveFocus()
    );
  });

  it('keeps the visually top dialog interactive when a lower dialog mounts later', () => {
    function AsyncStackedHarness({ lowerOpen }: { lowerOpen: boolean }) {
      return (
        <>
          {lowerOpen && (
            <Modal label="Lower dialog" onClose={() => undefined} />
          )}
          <Modal label="Top dialog" onClose={() => undefined} />
        </>
      );
    }

    const { rerender } = render(
      <StrictMode>
        <AsyncStackedHarness lowerOpen={false} />
      </StrictMode>
    );
    rerender(
      <StrictMode>
        <AsyncStackedHarness lowerOpen />
      </StrictMode>
    );

    const lower = screen.getByRole('dialog', {
      name: 'Lower dialog',
      hidden: true
    });
    const top = screen.getByRole('dialog', { name: 'Top dialog' });
    expect(lower.parentElement).toHaveAttribute('inert');
    expect(top.parentElement).not.toHaveAttribute('inert');
    expect(screen.getByLabelText('Top dialog first field')).toHaveFocus();
  });

  it('focuses the first control of a dialog whose body arrives later', async () => {
    // A code-split dialog mounts with an empty frame while its chunk loads.
    // Focus has to end up inside it anyway, or the keyboard is left on the
    // workspace the dialog claims to be modal over.
    function LateContentModal({ loaded }: { loaded: boolean }) {
      const dialogRef = useRef<HTMLDivElement | null>(null);
      useModalFocus(dialogRef, { autoFocus: true });
      return (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Late dialog"
          tabIndex={-1}
        >
          {loaded && <button type="button">Late action</button>}
        </div>
      );
    }

    const { rerender } = render(<LateContentModal loaded={false} />);
    const dialog = screen.getByRole('dialog', { name: 'Late dialog' });
    expect(dialog).toHaveFocus();

    rerender(<LateContentModal loaded />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Late action' })).toHaveFocus()
    );
  });

  it('leaves focus alone when the viewer moved it before the body arrived', async () => {
    function LateContentModal({ loaded }: { loaded: boolean }) {
      const dialogRef = useRef<HTMLDivElement | null>(null);
      useModalFocus(dialogRef, { autoFocus: true });
      return (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Late dialog"
          tabIndex={-1}
        >
          <button type="button">Always here</button>
          {loaded && <button type="button">Late action</button>}
        </div>
      );
    }

    const { rerender } = render(<LateContentModal loaded={false} />);
    const anchor = screen.getByRole('button', { name: 'Always here' });
    expect(anchor).toHaveFocus();

    rerender(<LateContentModal loaded />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Late action' })).toBeVisible();
    });
    expect(anchor).toHaveFocus();
  });
});
