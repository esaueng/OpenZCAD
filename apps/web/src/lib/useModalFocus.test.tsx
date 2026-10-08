import { StrictMode, useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { modalHoldsKeyboard, useModalFocus } from './useModalFocus';

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
  /**
   * A dialog container without a tabindex gives up focus to the body when its
   * text is clicked, and its own key handler then never hears Escape. The
   * hook's fallback has to close it, and only once when focus is inside.
   */
  it('still closes on Escape after a click on non-focusable dialog text', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function TextModal() {
      const dialogRef = useRef<HTMLDivElement | null>(null);
      useModalFocus(dialogRef, { autoFocus: true, onEscape: onClose });
      return (
        <div className="modal-backdrop">
          <div
            ref={dialogRef}
            role="dialog"
            aria-label="Text dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
              }
            }}
          >
            <p>Some explanatory text</p>
            <button type="button">Keep</button>
          </div>
        </div>
      );
    }
    render(<TextModal />);
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    await user.click(screen.getByText('Some explanatory text'));
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('treats a radio group as one Tab stop, so Shift+Tab cannot leave from its checked radio', async () => {
    const user = userEvent.setup();
    function RadioModal() {
      const dialogRef = useRef<HTMLDivElement | null>(null);
      const [choice, setChoice] = useState('ply');
      useModalFocus(dialogRef, { autoFocus: true });
      return (
        <>
          <button type="button">Background action</button>
          <div ref={dialogRef} role="dialog" aria-label="Radio dialog">
            {['3mf', 'stl', 'ply'].map((value) => (
              <input
                key={value}
                type="radio"
                name="format"
                value={value}
                aria-label={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
              />
            ))}
            <button type="button">Export</button>
          </div>
        </>
      );
    }
    render(<RadioModal />);
    const checked = screen.getByRole('radio', { name: 'ply' });
    const exportButton = screen.getByRole('button', { name: 'Export' });
    checked.focus();

    await user.tab({ shift: true });
    expect(exportButton).toHaveFocus();
    await user.tab();
    expect(checked).toHaveFocus();
  });

  it.each([
    ['inside', true],
    ['beside', false]
  ])(
    'returns focus to the control that opened a modal nested %s another',
    async (_placement, nestedInDom) => {
      const user = userEvent.setup();
      function Inner({ onClose }: { onClose(): void }) {
        const dialogRef = useRef<HTMLDivElement | null>(null);
        useModalFocus(dialogRef, { autoFocus: true });
        return (
          <div className="modal-backdrop">
            <div ref={dialogRef} role="dialog" aria-label="Inner dialog">
              <button type="button" onClick={onClose}>
                Close inner
              </button>
            </div>
          </div>
        );
      }
      function Outer() {
        const dialogRef = useRef<HTMLDivElement | null>(null);
        const [innerOpen, setInnerOpen] = useState(false);
        useModalFocus(dialogRef, { autoFocus: true });
        const inner = innerOpen ? (
          <Inner onClose={() => setInnerOpen(false)} />
        ) : null;
        return (
          <>
            <div
              ref={dialogRef}
              role="dialog"
              aria-label="Outer dialog"
              tabIndex={-1}
            >
              <button type="button">First outer control</button>
              <button type="button" onClick={() => setInnerOpen(true)}>
                Open inner
              </button>
              {nestedInDom && inner}
            </div>
            {!nestedInDom && inner}
          </>
        );
      }
      render(
        <StrictMode>
          <Outer />
        </StrictMode>
      );
      const opener = screen.getByRole('button', { name: 'Open inner' });
      await user.click(opener);
      expect(screen.getByRole('button', { name: 'Close inner' })).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Close inner' }));
      expect(opener).toHaveFocus();
      expect(opener).not.toHaveAttribute('inert');
    }
  );

  it('holds the keyboard from the workspace unless the dialog hands it back', () => {
    function Sheet({ workspaceKeys }: { workspaceKeys: boolean }) {
      const dialogRef = useRef<HTMLDivElement | null>(null);
      useModalFocus(dialogRef, { workspaceKeys });
      return <div ref={dialogRef} role="dialog" aria-label="Sheet" />;
    }
    expect(modalHoldsKeyboard()).toBe(false);

    const blocking = render(<Sheet workspaceKeys={false} />);
    expect(modalHoldsKeyboard()).toBe(true);
    blocking.unmount();
    expect(modalHoldsKeyboard()).toBe(false);

    const passing = render(<Sheet workspaceKeys />);
    expect(modalHoldsKeyboard()).toBe(false);
    passing.unmount();
  });
});
