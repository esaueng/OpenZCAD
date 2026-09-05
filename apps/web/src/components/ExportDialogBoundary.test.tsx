import { lazy, Suspense, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ExportDialogBoundary } from './ExportDialogBoundary';

it('contains a rejected export chunk and returns focus to the intact workspace', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const FailedExport = lazy(() =>
    Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
  );
  function Workspace() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <input
          aria-label="Unsaved project name"
          defaultValue="QA unsaved draft"
        />
        <button onClick={() => setOpen(true)}>Export mesh</button>
        {open && (
          <ExportDialogBoundary onClose={() => setOpen(false)}>
            <Suspense fallback={null}>
              <FailedExport />
            </Suspense>
          </ExportDialogBoundary>
        )}
      </>
    );
  }
  try {
    render(<Workspace />);
    const opener = screen.getByRole('button', { name: 'Export mesh' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', {
      name: 'Export unavailable'
    });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: 'Unsaved project name' })
    ).toHaveValue('QA unsaved draft');
    expect(opener).toHaveFocus();
  } finally {
    consoleError.mockRestore();
  }
});
